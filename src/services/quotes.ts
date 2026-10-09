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
import { positionInPortfolio } from "../db/position-membership.js"
import { fxTo, instrumentsAuthHeaders } from "./instruments-fx.js"
import { cashBalances, dailyExternalFlows } from "./cashLedger.js"
import { capitalBasisInvested } from "./transferFlows.js"
import { recomputeReturnColumns } from "./returnColumns.js"
import { enqueueBackfill } from "./backfill-runner.js"
import { splitPortfolioValue } from "./valuation.js"

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
  /**
   * §71 — how instruments derived `instrumentCurrency`: "provider" (a real
   * upstream declaration), "estimated" (the local resolver inferred it from
   * reference data), or "unknown". This was on the wire and thrown away, which
   * is what let a guess overwrite a known-good value.
   */
  currencySource: "provider" | "estimated" | "unknown"
  fetchedAt: number
}

// ── Module-level caches ───────────────────────────────────────────────────

const quoteCache = new Map<string, CachedQuote>()
const profileCache = new Map<string, CachedProfile>()

/**
 * Test-only: drop both module-level caches.
 *
 * They are process-wide and keyed by symbol, so a suite that makes a live quote
 * succeed leaks that price into every later suite in the same file — which then
 * takes a different branch than it would in isolation. §76.3 hit exactly this: a
 * test that proved the pricing tail works warmed `quoteCache`, and a later
 * `recalcPortfolioHistory` test then found the cache hot, priced from it, and
 * wrote today's snapshot-on-read row that its own assertion said must not exist.
 * Same convention as `__resetBackfillRunnerForTests` /
 * `__resetRecalcQueueForTests`.
 */
export function __resetQuoteCachesForTests(): void {
  quoteCache.clear()
  profileCache.clear()
}

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
//
// §71 — these send their credential via `instrumentsAuthHeaders`, NOT a bare
// `Authorization` header. Instruments' `serviceOrUserMiddleware` reads the
// scheduled sweep's credential from `X-Service-Token`; a `Bearer` token goes in
// `Authorization` instead. Both fetchers used to hardcode `Authorization`, so
// the service token went to the wrong header and every scheduled quote and
// profile call returned 401.
//
// That failed SILENTLY, which is the worst way: `refreshQuotes` never throws and
// treats an instruments error as "keep stored values, mark priceSource
// 'fallback'". So `snapshots-sync` reported every portfolio as "priced" twice a
// day while writing no prices at all, and 12 of IKE Marek's 13 positions sat on
// `fallback` with stale values — SRT.F among them, valued in the wrong currency.
// User-driven refreshes were unaffected (a real user JWT is a Bearer token, and
// Bearer is what Authorization expects), which is exactly why it took a PROD
// audit to surface rather than a failing test.
//
// A credential in the wrong header is indistinguishable from "no data", so it
// must never be the difference.

async function fetchQuote(symbol: string, authToken: string): Promise<CachedQuote | null> {
  const base = instrumentsBase()
  if (!base) return null
  try {
    const res = await fetch(`${base}/api/instruments/${symbol}/quote`, {
      headers: instrumentsAuthHeaders(authToken),
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
      headers: instrumentsAuthHeaders(authToken),
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
      // §71 — carried through, not dropped. Without it the refresh could not
      // tell a provider-confirmed currency from a locally inferred one, and so
      // treated them alike when deciding what to persist.
      currencySource:
        data.currencySource === "provider" || data.currencySource === "estimated"
          ? data.currencySource
          : "unknown",
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
  // §72.12 — take the same lock the rebuilds take.
  //
  // This writes TODAY's snapshot row, and the rebuild's own tail does the same,
  // so two of them running at once is a torn series, not just a stale one. The
  // unguarded callers were the 13:00/17:20 sweeps (snapshots-sync, which visits
  // EVERY portfolio) and every transaction mutation. A sweep landing in the
  // middle of a DELETE+rebuild would have its row deleted out from under it, or
  // the reverse, and which one survived depended on timing.
  await enqueueBackfill(portfolioId, () => refreshQuotesUnlocked(db, userId, portfolioId, authToken))
}

/**
 * The pricing pass itself, WITHOUT taking the lock.
 *
 * Only for a caller that already holds it. `recalcPortfolioHistory` runs this at
 * the tail of a pass it owns: routing that through `refreshQuotes` would enqueue
 * a task behind the very pass awaiting it, and the single-flight pump could
 * never start it — a self-deadlock, not a slow queue. Everything else calls
 * `refreshQuotes`.
 */
export async function refreshQuotesUnlocked(
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
        positionInPortfolio(portfolioId),
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
  const liveValues: Array<{
    marketValue: string
    averageCostBasis: string
    quantity: string
    instrumentCurrency: string | null
    quoteCurrency: string | null
  }> = []
  // How many positions were priced from a LIVE quote (not the stored-MV
  // fallback below). Used to decide whether today's snapshot may be written.
  let quotedCount = 0

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
        // §71 — a currency is a label that MULTIPLIES a number, so a wrong one
        // does not fail, it silently inflates the position. This line used to
        // overwrite unconditionally, which is how CRI.WA lost a correct "PLN"
        // (written by the import, and still on both of its BUY transactions) to
        // instruments' locally-inferred "CAD": the live headline overstated that
        // one position by 16,190 PLN, an 18% divergence from the stored series
        // that no test and no card/chart reconciliation caught, because a
        // confident-looking number is what a wrong currency produces.
        //
        // So a value is only ever written when it can be trusted to overwrite:
        // the provider declared it, or the position has nothing to lose. An
        // "estimated" or "unknown" currency never displaces a stored one — the
        // stored value came from the user's own import and is the more reliable
        // of the two.
        if (profile.instrumentCurrency !== null) {
          // `instrument_currency` is char(3): Postgres blank-pads, so "unset" is
          // whitespace, never "". A char column makes a naive `=== ""` check dead
          // code, which would silently make every blank position un-fillable.
          const stored = (p.instrumentCurrency ?? "").trim()
          const confirmed = profile.currencySource === "provider"
          if (confirmed || stored === "") {
            profileUpdate.instrumentCurrency = profile.instrumentCurrency
          } else if (profile.instrumentCurrency !== stored) {
            console.warn(
              `[quotes] pf=${portfolioId} ${p.symbol}: instruments reports ` +
                `${profile.instrumentCurrency} (${profile.currencySource}) but the position already has ` +
                `${stored} — keeping the stored value. A currency discrepancy here ` +
                `changes this position's value by the FX factor.`,
            )
          }
        }
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
          // §53.6 — no live quote: the stored MV is converted via the
          // instrument currency (legacy native-mixed residual, documented in
          // snapshotPortfolioValue)
          quoteCurrency: null,
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

      quotedCount += 1
      liveValues.push({
        marketValue: String(mv),
        averageCostBasis: p.averageCostBasis,
        quantity: p.quantity,
        instrumentCurrency: p.instrumentCurrency,
        // §53.6 — mv is denominated in the quote's own price currency (§39),
        // which is not always the stored instrumentCurrency
        quoteCurrency: quote.currency ?? null,
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
  //
  // Best-effort, as before: errors are swallowed so a snapshot failure can
  // never affect the positions response. But the write is **awaited**, and that
  // is the whole fix. `await` on an already-caught promise cannot throw, so the
  // "best-effort" contract is untouched — only the timing changes.
  //
  // §63.2 (2026-09-30) fixed a real race HERE, and §76.4 has now made it
  // structurally impossible instead of merely ordered. It is kept because the
  // reasoning is what explains the guard below, not because the race can return.
  //
  // §63.2: this call was `void …` (fire-and-forget) while the recompute in
  // backfill.ts ran `syncCurrentValueFromSnapshots` on the next line, so
  // `current_value` was synced from the PREVIOUS (price-bar) snapshot before the
  // live one landed, and the stored card disagreed with the headline. It hid on
  // 9 of 10 PROD portfolios — cash-only or unpriced bonds make both paths agree —
  // and showed only on IBKR, where the gap GREW across a recompute instead of
  // closing. `c195839` fixed it by awaiting this write.
  //
  // §76.4: `snapshotPortfolioValue` no longer writes `value_snapshots` at all.
  // `computeSnapshotBatch` is the single writer of every (portfolioId, date),
  // today included. Two writers of today's row was the precondition for that
  // race, so with one writer there is nothing left to order.
  //
  // §63.2 correction (2026-09-30): the sentence this block used to end with —
  // "`syncCurrentValueFromSnapshots` runs exactly where the snapshot is written" —
  // was false in *this* file. It is called from `backfill.ts` (`:1036`, `:1119`,
  // `:1194`), not from here, and the `quotes.ts` import of it was dead. The
  // claim was carried into `plan-archive.md` §76.4 as evidence that
  // `current_value` is written by the live path, which is not what happens: the
  // row synced is the one the batch wrote from price bars. Removed rather than
  // reworded, because the live quote genuinely does not write anything here.
  //
  // The `quotedCount === 0` guard below still earns its place for a different
  // reason, and the distinction matters: we hold positions but priced NONE, so
  // the fallback path would contribute each position's STORED `marketValue` —
  // which is `0` until a position has been quoted once. On a freshly seeded or
  // freshly re-imported portfolio that is every position, so valuing now would
  // be valuing a set of zeros. Do not touch today's figure; the backfilled
  // series stays authoritative.
  if (quotedCount === 0) return

  // #37 — `portfolios.total_invested` was written ONLY on an actual insert or an
  // interactive edit. The import is insert-only, so a re-import skips every row
  // as a duplicate and the column keeps whatever it last had — meaning a fix to
  // the basis could not reach existing rows without a destructive wipe.
  //
  // `snapshotPortfolioValue` already computes the right figure (it is the same
  // `capitalBasisInvested` call the live card reads), so persisting its result
  // here adds no second derivation path — it reuses the existing writer's own
  // number, which is the principle this file already states for prices. This
  // runs nightly via `snapshots-sync`, so the column is now self-healing rather
  // than correct-only-after-a-wipe.
  const snap = await snapshotPortfolioValue(db, authToken, portfolioId, liveValues, now).catch(() => undefined)
  if (snap) {
    await db
      .update(portfolios)
      .set({ totalInvested: snap.invested, updatedAt: new Date() })
      .where(eq(portfolios.id, portfolioId))
  }
}

/**
  * Compute and upsert a single-day value snapshot for a portfolio.
  *
  * portfolioValue = Σ pos.marketValue × fx(valueCurrency → baseCurrency)
  * invested       = Σ (pos.averageCostBasis × pos.quantity) × fx(instrumentCurrency → baseCurrency)
  *
  * §53.6 — valueCurrency is the quote's own price currency when a live quote
  * produced the marketValue (the quote path stores it unconverted, §39),
  * falling back to the position's instrument currency. The stored MVs on the
  * fallback branch are legacy native-mixed values, so the instrument-currency
  * conversion there is best-effort (documented residual).
  *
  * Falls back to rate=1 when instruments FX is unavailable or a pair is missing (plan §48.3).
  * Exported for unit testing.
  */
 /**
 * What today is worth for a portfolio, computed but NOT written.
 *
 * §76.4: `computeSnapshotBatch` is the single writer of `value_snapshots`; this
 * is the live-quote arithmetic that callers need in order to price positions and
 * to show a fresh figure. See the ownership note at the return statement.
 */
export interface SnapshotValue {
  portfolioId: string
  snapshotDate: string
  value: string
  invested: string
  netFlow: string
}

export async function snapshotPortfolioValue(
  db: DB,
  authToken: string | null,
  portfolioId: string,
  positionRows: Array<{
    symbol?: string
    marketValue: string | null
    averageCostBasis: string
    quantity: string
    instrumentCurrency: string | null
    quoteCurrency?: string | null
  }>,
  now = new Date(),
): Promise<SnapshotValue> {
  const [portfolio] = await db
    .select({ baseCurrency: portfolios.baseCurrency })
    .from(portfolios)
    .where(eq(portfolios.id, portfolioId))
    .limit(1)
  // §66.4 — a missing portfolio row is an error on a valuation path, not a
  // reason to silently leave the previous snapshot in place.
  if (!portfolio) throw new Error(`snapshotPortfolioValue: portfolio ${portfolioId} not found`)

  const base = portfolio.baseCurrency
  // plan §48.3 — pair rates resolved via instruments, memoized per currency.
  // §66.4 — STRICT: this is the headline valuation. A missing source currency or
  // an unresolvable pair must abort rather than write a 1:1 number, which is
  // how the headline ended up disagreeing with the cards (§63.2/§63.3).
  const toBase = await fxTo(authToken, base, new Map(), { strict: true })

  let totalValue = 0
  // §62 follow-up (2026-09-27): invested = cumulative net EXTERNAL cash flow
  // (deposits − withdrawals ± transfer legs), NOT the position cost basis —
  // a fully-invested portfolio has ~0 cash balance but a large invested total.
  let totalInvested = 0
  // §68 — the positions→value arithmetic now lives in splitPortfolioValue, the
  // same function /total-metrics and /summary-metrics use. It previously had its
  // own copy here, which is how this path ended up adding cash to totalValue
  // while the headline route did not.
  //
  // Market value is denominated in the QUOTE's currency (live) or the instrument
  // currency (fallback / legacy stored MV), so the value currency is resolved
  // here and handed over as the row's `instrumentCurrency`.
  const debug = process.env.RECALC_DEBUG === "1"
  const { instrumentsValue, cashValue: totalCash, totalValue: splitTotal } = await splitPortfolioValue(
    toBase,
    positionRows.map((p) => ({ ...p, instrumentCurrency: p.quoteCurrency ?? p.instrumentCurrency })),
    await cashBalances(db, authToken, portfolioId),
    debug
      ? ({ valueCcy, mv, contrib }) =>
          console.log(
            `[recalc-debug-quote] pf=${portfolioId} mv=${mv} mvCcy=${valueCcy}→${base} contrib=${contrib.toFixed(2)}`,
          )
      : undefined,
  )
  totalValue = instrumentsValue

  const snapshotDate = now.toISOString().slice(0, 10)
  // §62.4 — value includes the current cash total (base currency); netFlow is
  // EXTERNAL flows only (a same-day deposit/withdrawal shows up here).
  totalInvested = await capitalBasisInvested(db, authToken, portfolioId, base)
  if (debug) {
    console.log(
      `[recalc-debug-quote] pf=${portfolioId} CASH=${totalCash.toFixed(2)} INSTRUMENTS=${instrumentsValue.toFixed(2)} value=${splitTotal.toFixed(2)} invested=${totalInvested.toFixed(2)} base=${base}`,
    )
  }
  // totalValue is instruments + cash by construction (§68) — not a second
  // hand-written addition, which is how the two paths drifted apart.
  totalValue = splitTotal
  const todayFlows = await dailyExternalFlows(db, authToken, portfolioId, snapshotDate, snapshotDate, base)

  // §76.4 — this function no longer WRITES value_snapshots. It used to upsert
  // today's row here, which made it the second writer of
  // (portfolioId, today) alongside `computeSnapshotBatch`'s window, and whichever
  // ran last won. The ownership rule is now single and stated once:
  //
  //   `computeSnapshotBatch` owns EVERY (portfolioId, snapshotDate), today
  //   included — reached through `_runBackfillCore` (upsert),
  //   `recalcPortfolioSeries` (§76.3) and `recalcPortfolioHistory` (force).
  //   Only it can price a past date from bars, and only it covers a
  //   cash-only portfolio (§62.4), so today must belong to it too.
  //
  // What remains here is the part that genuinely needs a live quote: this
  // function's callers (`refreshQuotesUnlocked` and the POST that writes a
  // position) use it to price POSITIONS — market_value, price_as_of,
  // price_source — and to learn what today is worth.
  //
  // Consequence, stated rather than hidden: a write no longer moves
  // `current_value` on the spot. It picks the value up when the debounced
  // re-value pass lands (~3s). The POST still answers with the freshly priced
  // position, and the card keeps showing the snapshot's own as-of, so the
  // number is labelled rather than silently stale (§70).
  return {
    portfolioId,
    snapshotDate,
    value: totalValue.toFixed(8),
    invested: totalInvested.toFixed(8),
    netFlow: (todayFlows.get(snapshotDate) ?? 0).toFixed(8),
  }
}

/** Exposed for testing: flush the in-process caches. */
export function _clearQuoteCache() {
  quoteCache.clear()
  profileCache.clear()
}
