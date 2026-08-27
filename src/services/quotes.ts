/**
 * D58 — Valuation via the provider tier.
 *
 * Fetches live quotes AND instrument profiles (name/sector/country) from the
 * instruments module for open positions in a portfolio, persists the snapshot
 * columns, and never throws — instruments unreachable → priceSource 'fallback',
 * stored profile fields kept as-is.
 */

import { and, eq } from "drizzle-orm"
import type { DB } from "../db/index.js"
import { positions } from "../db/schema.js"

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
      currency: String(data.currency ?? "USD"),
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
      country: typeof data.country === "string" && data.country ? data.country : null,
      fetchedAt: Date.now(),
    }
    profileCache.set(symbol, entry)
    return entry
  } catch {
    return null
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function quoteCacheHit(symbol: string): boolean {
  const c = quoteCache.get(symbol)
  return !!c && Date.now() - c.fetchedAt < CACHE_TTL_MS
}

function profileCacheHit(symbol: string): boolean {
  const c = profileCache.get(symbol)
  return !!c && Date.now() - c.fetchedAt < CACHE_TTL_MS
}

function needsPriceRefresh(pos: { priceAsOf: Date | null }): boolean {
  if (!pos.priceAsOf) return true
  return Date.now() - pos.priceAsOf.getTime() > STALE_MS
}

function needsProfileRefresh(pos: { companyName: string | null; updatedAt: Date }): boolean {
  // Re-fetch profile if we don't yet have a name or it's been > STALE_MS since last update
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
 * Profile side: fetches companyName, sector, country from /:symbol/profile.
 *   These are persisted as live-but-cached values; stored values act as fallback
 *   when the instruments service is unavailable.
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

  // Persist snapshots for each position
  const now = new Date()
  await Promise.all(
    rows.map(async (p) => {
      const quote = quoteCache.get(p.symbol)
      const profile = profileCache.get(p.symbol)

      // ── Profile fields (companyName, sector, country) ──────────────────
      const profileUpdate: Record<string, unknown> = {}
      if (profile) {
        if (profile.name !== null) profileUpdate.companyName = profile.name
        if (profile.sector !== null) {
          profileUpdate.sector = profile.sector
          profileUpdate.industry = profile.sector // industry mirrors sector until finer data available
        }
        if (profile.country !== null) profileUpdate.country = profile.country
      }

      // ── Quote fields ────────────────────────────────────────────────────
      if (!quote) {
        // No live price — mark as fallback if we have a stored price, apply any profile update
        const update: Record<string, unknown> = { ...profileUpdate, updatedAt: now }
        if (p.currentPrice != null) update.priceSource = "fallback"
        if (Object.keys(update).length > 1 || update.priceSource) {
          await db.update(positions).set(update).where(eq(positions.id, p.id))
        }
        return
      }

      const qty = Number(p.quantity)
      const avg = Number(p.averageCostBasis)
      const price = quote.currentPrice
      const mv = price * qty
      const ugl = (price - avg) * qty
      const dayChange = quote.change * qty
      const dayChangePct = quote.percentChange

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
}

/** Exposed for testing: flush the in-process caches. */
export function _clearQuoteCache() {
  quoteCache.clear()
  profileCache.clear()
}
