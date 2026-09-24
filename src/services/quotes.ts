/**
 * D58 — Valuation via the provider tier.
 *
 * Fetches live quotes AND instrument profiles (name/sector) from the
 * instruments module for open positions in a portfolio, persists the snapshot
 * columns, and never throws — instruments unreachable → priceSource 'fallback',
 * stored profile fields kept as-is.
 *
 * Country is treated as canonical metadata recorded at buy time (2-letter ISO
 * code from the instrument search result). The live profile only fills it in
 * for positions that lack one, and prefers the profile's countryCode (ISO
 * alpha-2) over its display name so the position never regresses to a guess.
 */

import { and, eq, sql } from "drizzle-orm"
import type { DB } from "../db/index.js"
import { positions, portfolios, valueSnapshots } from "../db/schema.js"
import { fxTo } from "./instruments-fx.js"
import { dailyNetCashFlows } from "./cashFlows.js"
import { recomputeReturnColumns, syncCurrentValueFromSnapshots } from "./returnColumns.js"

// ── Types ─────────────────────────────────────────────────────────────────

/** In-process per-symbol quote cache. Keyed by UPPER symbol. */
interface CachedQuote {
  currentPrice: number
  change: number
  percentChange: number
  currency: string
  fetchedAt: number // Date.now()
}

/** In-process per-symbol profile cache. Keyed by UPPER symbol. */
interface CachedProfile {
  name: string | null
  sector: string | null
  country: string | null
  instrumentCurrency: string | null
  fetchedAt: number
}

// ── Module-level caches ───────────────────────────────────────────────────

const quoteCache = new Map<string, CachedQuote>()
const profileCache = new Map<string, CachedProfile>()

// ── Config (read at call time so tests can set env vars before calling) ──

/** How long a cached entry is considered fresh (ms). Override via env. */
const CACHE_TTL_MS = Number(process.env.QUOTE_CACHE_TTL_MS ?? 60_000)

/** How old a stored priceAsOf may be before we attempt a re-fetch (ms). */
const STALE_MS = Number(process.env.QUOTE_STALE_MS ?? 15 * 60_000)

/** Read instruments base URL at call time so tests can mutate env freely. */
function instrumentsBase(): string {
  return (
    process.env.INSTRUMENTS_URL ??
    process.env.API_INSTRUMENTS_URL ??
    ""
  ).replace(/\/$/, "")
}

// ── Fetchers ──────────────────────────────────────────────────────────────

async function fetchQuote(symbol: string, authToken: string): Promise<CachedQuote | null> {
  const base = instrumentsBase()
  if (!base) return null
  try {
    const res = await fetch(`${base}/api/instruments/${symbol}/quote`, {
      headers: { Authorization: authToken },
    })
    if (!res.ok) return null
    const data = (await res.json()) as Record<string, unknown>
    const price = Number(data.currentPrice ?? 0)
    if (!price) return null
    const entry: CachedQuote = {
      currentPrice: price,
      change: Number(data.change ?? 0),
      percentChange: Number(data.percentChange ?? 0),
      currency: isIsoCurrency(data.currency) ? data.currency.toUpperCase() : "USD",
      fetchedAt: Date.now(),
    }
    quoteCache.set(symbol, entry)
    return entry
  } catch {
    return null
  }
}

async function fetchProfile(symbol: string, authToken: string): Promise<CachedProfile | null> {
  const base = instrumentsBase()
  if (!base) return null
  try {
    const res = await fetch(`${base}/api/instruments/${symbol}/profile`, {
      headers: { Authorization: authToken },
    })
    if (!res.ok) return null
    const data = (await res.json()) as Record<string, unknown>
    const entry: CachedProfile = {
      name: typeof data.name === "string" && data.name ? data.name : null,
      // profile returns finnhubIndustry as the sector string (see translate.ts)
      sector: typeof data.finnhubIndustry === "string" && data.finnhubIndustry
        ? data.finnhubIndustry
        : typeof data.gicsSector === "string" && data.gicsSector
          ? data.gicsSector
          : null,
      country: typeof data.countryCode === "string" && data.countryCode
        ? data.countryCode
        : typeof data.country === "string" && data.country
          ? data.country
          : null,
      instrumentCurrency: isIsoCurrency(data.currency) ? data.currency.toUpperCase() : null,
      fetchedAt: Date.now(),
    }
    profileCache.set(symbol, entry)
    return entry
  } catch {
    return null
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** §39 — accept only 3-letter ISO-4217 codes. The provider tier has served
 * unit-suffixed codes (biznesradar prices LSE in pence, "GBp") — a lowercased
 * "gbp" would pass a plain ISO check, uppercase to a plausible "GBP" and mask
 * a 100× price. Non-ISO (and pence) codes must never overwrite a position's
 * stored currency. */
export function isIsoCurrency(code: unknown): code is string {
  if (typeof code !== "string" || !/^[A-Za-z]{3}$/.test(code)) return false
  // "gbp" in any mixed casing is the provider's pence unit, not the ISO code
  return code.toLowerCase() !== "gbp" || code === "GBP"
}

function quoteCacheHit(symbol: string): boolean {
  const c = quoteCache.get(symbol)
  return !!c && Date.now() - c.fetchedAt < CACHE_TTL_MS
}

function profileCacheHit(symbol: string): boolean {
  const c = profileCache.get(symbol)
  return !!c && Date.now() - c.fetchedAt < CACHE_TTL_MS
}

function missesEnrichment(value: string | null): boolean {
  const v = value ?? ""
  return v.trim() === "" || v === "Other"
}

function needsPriceRefresh(pos: { priceAsOf: Date | null }): boolean {
  if (!pos.priceAsOf) return true
  return Date.now() - pos.priceAsOf.getTime() > STALE_MS
}

function needsProfileRefresh(pos: { companyName: string | null; updatedAt: Date }): boolean {
  if (!pos.companyName) return true
  return Date.now() - pos.updatedAt.getTime() > STALE_MS
}

// ── Main export ───────────────────────────────────────────────────────────

/**
 * Refresh quote + profile snapshot columns for all open positions in a portfolio.
 *
 * Quote side: fetches currentPrice, change, percentChange → persists marketValue,
 *   unrealizedGainLoss, dayChange, dayChangePercent, priceSource ('quote'|'fallback'), priceAsOf.
 *
 * Profile side: fetches companyName, sector from /:symbol/profile. Country
 * (preferring the ISO countryCode) is filled only when the position has none,
 * an empty string, or the "Other" sentinel (plan §28.5 self-heal) — a
 * real-profile/curated value is canonical and never overwritten by a live
 * guess. These are persisted as live-but-cached values; stored values act as
 * fallback when the instruments service is unavailable.
 *
 * Never throws. Instruments errors → keep stored values, mark priceSource 'fallback'.
 */
export async function refreshQuotes(
  db: DB,
  userId: string,
  portfolioId: string,
  authToken: string,
): Promise<void> {
  if (!instrumentsBase()) return

  const rows = await db
    .select()
    .from(positions)
    .where(
      and(
        eq(positions.userId, userId),
        eq(positions.portfolioId, portfolioId),
        eq(positions.isOpen, true),
      ),
    )

  if (rows.length === 0) return

  // Determine which symbols need fetching
  const symbolsForQuote = new Set<string>()
  const symbolsForProfile = new Set<string>()

  for (const p of rows) {
    if (!quoteCacheHit(p.symbol) && needsPriceRefresh(p)) symbolsForQuote.add(p.symbol)
    if (!profileCacheHit(p.symbol) && needsProfileRefresh(p)) symbolsForProfile.add(p.symbol)
  }

  // Fetch quotes + profiles in parallel
  await Promise.all([
    ...[...symbolsForQuote].map((sym) => fetchQuote(sym, authToken)),
    ...[...symbolsForProfile].map((sym) => fetchProfile(sym, authToken)),
  ])

  // Persist snapshots for each position; accumulate live values for H5 snapshot
  const now = new Date()
  const liveValues: Array<{ marketValue: string; averageCostBasis: string; quantity: string; instrumentCurrency: string | null }> = []

  await Promise.all(
    rows.map(async (p) => {
      const quote = quoteCache.get(p.symbol)
      const profile = profileCache.get(p.symbol)

      // ── Profile fields (companyName, sector, country, instrumentCurrency) ─
      const profileUpdate: Record<string, unknown> = {}
      if (profile) {
        if (profile.name !== null) profileUpdate.companyName = profile.name
        // Enrichment (plan §28.5): fill the sector/industry/country when the
        // stored value is null, empty or the "Other" sentinel (imported
        // positions from before the catalog existed self-heal on the next
        // quotes pass). A real-profile/curated value is canonical and kept.
        if (profile.sector !== null && missesEnrichment(p.sector)) {
          profileUpdate.sector = profile.sector
          profileUpdate.industry = profile.sector
        }
        if (profile.country !== null && missesEnrichment(p.country)) profileUpdate.country = profile.country
        if (profile.instrumentCurrency !== null) profileUpdate.instrumentCurrency = profile.instrumentCurrency
      }

      // ── Quote fields ────────────────────────────────────────────────────
      if (!quote) {
        // No live price — mark as fallback if we have a stored price, apply any profile update
        const update: Record<string, unknown> = { ...profileUpdate, updatedAt: now }
        if (p.currentPrice != null) update.priceSource = "fallback"
        if (Object.keys(update).length > 1 || update.priceSource) {
          await db.update(positions).set(update).where(eq(positions.id, p.id))
        }
        // use stored marketValue as best-effort for snapshot
        liveValues.push({
          marketValue: p.marketValue ?? "0",
          averageCostBasis: p.averageCostBasis,
          quantity: p.quantity,
          instrumentCurrency: p.instrumentCurrency,
        })
        return
      }

      const qty = Number(p.quantity)
      const avg = Number(p.averageCostBasis)
      const price = quote.currentPrice
      const mv = price * qty
      const ugl = (price - avg) * qty
      const dayChange = quote.change * qty
      const dayChangePct = quote.percentChange

      liveValues.push({
        marketValue: String(mv),
        averageCostBasis: p.averageCostBasis,
        quantity: p.quantity,
        instrumentCurrency: p.instrumentCurrency,
      })

      await db
        .update(positions)
        .set({
          ...profileUpdate,
          currentPrice: String(price),
          priceSource: "quote",
          priceAsOf: now,
          marketValue: String(mv),
          unrealizedGainLoss: String(ugl),
          dayChange: String(dayChange),
          dayChangePercent: String(dayChangePct),
          updatedAt: now,
        })
        .where(eq(positions.id, p.id))
    }),
  )

  // H5 — snapshot-on-read: upsert today's portfolio value into value_snapshots.
  // Best-effort: errors are swallowed so they never affect the positions response.
  void snapshotPortfolioValue(db, authToken, portfolioId, liveValues, now).catch(() => undefined)
}

/**
 * Compute and upsert a single-day value snapshot for a portfolio.
 *
  * portfolioValue = Σ pos.marketValue × fx(instrumentCurrency → baseCurrency)
  * invested       = Σ (pos.averageCostBasis × pos.quantity) × fx(instrumentCurrency → baseCurrency)
  *
  * Falls back to rate=1 when instruments FX is unavailable or a pair is missing (plan §48.3).
  * Exported for unit testing.
  */
export async function snapshotPortfolioValue(
  db: DB,
  authToken: string | null,
  portfolioId: string,
  positionRows: Array<{
    marketValue: string | null
    averageCostBasis: string
    quantity: string
    instrumentCurrency: string | null
  }>,
  now = new Date(),
): Promise<void> {
  const [portfolio] = await db
    .select({ baseCurrency: portfolios.baseCurrency })
    .from(portfolios)
    .where(eq(portfolios.id, portfolioId))
    .limit(1)
  if (!portfolio) return

  const base = portfolio.baseCurrency
  // plan §48.3 — pair rates resolved via instruments, memoized per currency.
  const toBase = await fxTo(authToken, base)

  let totalValue = 0
  let totalInvested = 0
  for (const p of positionRows) {
    const from = (p.instrumentCurrency ?? "USD").toUpperCase()
    const rate = await toBase(from, 1)
    const mv = Number(p.marketValue ?? 0)
    const cost = Number(p.averageCostBasis) * Number(p.quantity)
    totalValue += mv * rate
    totalInvested += cost * rate
  }

  const snapshotDate = now.toISOString().slice(0, 10)
  const todayFlows = await dailyNetCashFlows(db, authToken, portfolioId, snapshotDate, snapshotDate, base)
  await db
    .insert(valueSnapshots)
    .values({
      portfolioId,
      snapshotDate,
      value: totalValue.toFixed(8),
      invested: totalInvested.toFixed(8),
      netFlow: (todayFlows.get(snapshotDate) ?? 0).toFixed(8),
    })
    .onConflictDoUpdate({
      target: [valueSnapshots.portfolioId, valueSnapshots.snapshotDate],
      set: {
        value: sql`excluded.value`,
        invested: sql`excluded.invested`,
        netFlow: sql`excluded.net_flow`,
      },
    })

  // Recompute stored return-type columns after the new snapshot is written
  await recomputeReturnColumns(db, portfolioId)
  // §53.5 — keep portfolios.current_value in step with the newest snapshot
  await syncCurrentValueFromSnapshots(db, portfolioId)
}

/** Exposed for testing: flush the in-process caches. */
export function _clearQuoteCache() {
  quoteCache.clear()
  profileCache.clear()
}
