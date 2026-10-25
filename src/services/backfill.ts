/**
 * price-data-architecture H6 — historical value_snapshots backfill job.
 *
 * Triggered asynchronously from GET /:id/analytics when value_snapshots has
 * fewer than 2 rows. Computes a daily portfolio value series from the first
 * transaction date to yesterday, then bulk-upserts into value_snapshots.
 *
 * Algorithm:
 *  1. Find firstTxDate = MIN(executed_at) across BUY/SELL transactions.
 *  2. Build a daily qty_held map per symbol from cumulative BUY − SELL.
 *  3. Fetch price series per symbol from instruments GET /price-bars.
 *  4. Carry-forward prices on weekends/holidays (last known close).
 *  5. For each calendar day: value = Σ qty_held(sym,day) × price(sym,day) × fx.
 *  6. Bulk upsert value_snapshots (idempotent ON CONFLICT DO UPDATE).
 *  7. Mark portfolio_backfill_metadata complete (or failed on error).
 */
import { and, eq, lt, sql } from "drizzle-orm"
import type { DB } from "../db/index.js"
import { transactionInPortfolio } from "../db/position-membership.js"
import {
  portfolioBackfillMetadata,
  portfolios,
  portfolioCashTransactions,
  portfolioTransactions,
  positions,
  valueSnapshots,
} from "../db/schema.js"
import {
  InstrumentsUnavailableError,
  instrumentsAuthHeaders,
  instrumentsBase,
  resolvedFxRate,
} from "./instruments-fx.js"
import { cashBalanceSeries, dailyExternalFlows } from "./cashLedger.js"
import { LOT_QUANTITY_TYPES, isTransferType, quantitySign } from "../transaction-types.js"
import { dailyTransferBasis, marketValuedTransferFlows } from "./transferFlows.js"
// §63.2 — `composePortfolioValue` only. `splitPortfolioValue` is deliberately NOT
// imported: the live path converts each position out of its own instrument
// currency, and the closes reaching this file are already in the portfolio's base
// (§48.3), so it cannot be used here. The shared part is the composition.
import { composePortfolioValue } from "./valuation.js"
import { enqueueBackfill } from "./backfill-runner.js"
import { refreshQuotesUnlocked } from "./quotes.js"
import {
  recomputeReturnColumns,
  syncCurrentValueFromSnapshots,
  buildSimple,
  buildTwr,
  buildMwr,
} from "./returnColumns.js"

// ── instruments client ────────────────────────────────────────────────────

interface PriceBarSeries {
  symbol: string
  dates: string[]
  closes: number[]
  stale: boolean
  currency?: string | null
  /** §72.16 — the first date instruments could actually convert. Bars before it
   * are still in the SOURCE currency while the response declares the target for
   * the whole series, so a consumer that trusts `currency` silently mixes two. */
  fxFrom?: string | null
  /** §72.10 — the requested-window dates instruments DROPPED for want of an FX
   * rate. This is the only place the reason for a missing bar is knowable: the
   * backfill can see that a date is absent from the response but not whether it
   * was never fetched or was fetched and unconvertible. Null until the
   * `@marx-org/contracts` release carrying the field is out — see the note on
   * `fxCoverageHoles` for what happens without it. */
  unconvertedDates?: string[] | null
}

async function fetchPriceBars(
  symbol: string,
  from: string,
  to: string,
  authToken: string,
  signal?: AbortSignal,
  currency?: string,
  /** §63.10.5 — the base we already know for this symbol (the position's
   * `instrumentCurrency`). instruments' own resolver is silent for a ticker listed
   * on several venues in different currencies (AFL: NYSE+ASX), and §48.2 refuses a
   * conversion whose base is unknown — so one such position 400'd and took the
   * whole portfolio with it. Declared here, honoured there, and never overriding a
   * base instruments can resolve itself (§47). */
  baseCcy?: string,
  includePrevious = false,
): Promise<PriceBarSeries | null> {
  const base = instrumentsBase()
  if (!base) throw new InstrumentsUnavailableError(null, "instruments (INSTRUMENTS_URL unset)")
  const q = new URLSearchParams({ from, to })
  if (currency) q.set("currency", currency)
  if (baseCcy) q.set("baseCurrency", baseCcy)
  if (includePrevious) q.set("includePrevious", "true")
  const url = `${base}/api/instruments/${encodeURIComponent(symbol)}/price-bars?${q}`
  let res: Response
  try {
    res = await fetch(url, { headers: instrumentsAuthHeaders(authToken), signal })
  } catch (e) {
    // §63.10 — a price source we could not reach is an error, not "no data".
    // The old `catch { return null }` made an auth rejection indistinguishable
    // from an empty series, and computeSnapshotBatch then dropped every
    // position and wrote a cash-only value over the correct one.
    throw new InstrumentsUnavailableError(null, url, e)
  }
  if (!res.ok) {
    // 404 is cachest/instruments' documented "no data for this key" answer (an
    // unknown ticker, a symbol with no history) — a legitimate gap, which the
    // batch surfaces via `gapSymbols`. Everything else — 401/403 (auth), 400, 5xx
    // — means the price source could not be used at all and the pass must abort.
    if (res.status === 404) return null
    throw new InstrumentsUnavailableError(res.status, url)
  }
  // A 200 with zero dates is a legitimate answer: the symbol genuinely has no
  // price history, which surfaces as a gap rather than an aborted pass.
  return (await res.json()) as PriceBarSeries
}

/**
 * §72.16 — drop bars that instruments could not convert.
 *
 * `convertSeries` keeps a bar in its SOURCE currency when no rate row exists for
 * that date ("floor semantics, no carry-forward"), while the response declares
 * `currency: <target>` for the whole series and `fxFrom` as the first date it
 * managed. BTC-USD converted to PLN over 2022-02-13..21 returns
 * `fxFrom: 2022-02-14` and leaves 02-13 at a raw 42,197.5156 where its
 * neighbours are ~170,859 — a USD number labelled PLN, off by the FX rate.
 *
 * The grid multiplies that straight into a portfolio total, which is where
 * Crypto's +410% single-day jumps came from. Cutting the unconverted prefix
 * leaves a gap that `buildPriceMap` already carries forward from the first
 * genuinely-converted close, which is at least honest about the currency.
 */
function dropUnconvertedPrefix(series: PriceBarSeries): PriceBarSeries {
  if (!series.fxFrom) return series
  const from = series.fxFrom
  const keep = series.dates.findIndex((d) => d >= from)
  if (keep <= 0) return series
  return { ...series, dates: series.dates.slice(keep), closes: series.closes.slice(keep) }
}

/**
 * §72.21 — the dates a symbol was held on but has no price for, counted BEFORE
 * `buildPriceMap` erases the evidence.
 *
 * **This is the only point where the information exists.** `buildPriceMap`
 * carry-forwards every day from the first surviving bar onward, so by the time
 * the gap scan runs (`prices.has(day)`) a **scattered** mid-window hole is
 * indistinguishable from a day that simply reused the last close — which is
 * exactly the shape §72.17's damage took (`fx-convert.ts:44-45`). A prefix hole
 * survives that scan and gets reported as a `gapSymbol`; a scattered one does
 * not, and never did. Anything computed downstream of the carry-forward would
 * report a number structurally incapable of being non-zero for the case that
 * matters.
 *
 * **What it can and cannot say.** It can say a held day has no returned bar. It
 * cannot say why: no history upstream, or a bar instruments dropped for want of
 * an FX rate, are the same absence at this layer. `unconvertedDates` (§72.10) is
 * what separates them, and it is `null` until that contract field ships — so this
 * is a **count, deliberately not a diagnosis**, and the note is repeated on
 * `fxCoverage` so nobody reads it as one.
 */
function fxCoverageHoles(
  qtyMaps: Map<string, Map<string, number>>,
  seriesBySymbol: Map<string, PriceBarSeries>,
  symbols: string[],
  days: string[],
): Map<string, string[]> {
  const holes = new Map<string, string[]>()
  for (const sym of symbols) {
    const perDay = qtyMaps.get(sym)
    if (!perDay) continue
    // A symbol with no returned series at all is a `gapSymbol`, reported
    // elsewhere and not an FX story — counting every day of it here would bury
    // the real signal under the genuinely unpriceable bonds (§72.31).
    const series = seriesBySymbol.get(sym)
    if (!series) continue
    const returned = new Set(series.dates)
    const missing: string[] = []
    for (const day of days) {
      if ((perDay.get(day) ?? 0) <= 0) continue          // not held ⇒ not a hole
      if (returned.has(day)) continue                    // instruments returned it
      if (isMarketClosure(day, series.dates)) continue    // the market was shut
      missing.push(day)
    }
    if (missing.length > 0) holes.set(sym, missing)
  }
  return holes
}

/**
 * Is `day` a day the market simply did not trade?
 *
 * **This function is the whole reason `fxCoverageHoles` was wrong the first time
 * it shipped, and the measurement that shows it is worth more than the argument.**
 * The first version compared a held day against `series.dates` and called the
 * difference a hole. `days` is `calendarDays` — every calendar day — and a
 * week has five trading days, so it reported **1,148 of 1,222 SAP.DE "holes" as
 * weekends**, and then IBKR 108 symbols and Equate+ 820. Those were not
 * coverage findings; they were the exchange calendar, and they were large enough
 * to bury any real signal. A metric that says 94% of its findings are the
 * definition of the day is not a metric.
 *
 * Three exclusions, in increasing cost and decreasing effect:
 *
 * 1. **Weekends.** Deterministic, no data needed, and 94% of the noise.
 * 2. **Closure spans** — a missing day with no bar within ±`HOLES_BRACKET_DAYS`
 *    either side is inside a holiday week, not a hole. A single-day holiday is
 *    still bracketed, so this removes long closures and not Christmas.
 * 3. Nothing more. A one-day exchange holiday the portfolio's other venues did
 *    not share **is still counted**, and that is a real, stated limit: `days` has
 *    no calendar in it and nothing here can invent one. SAP.DE measures 74 such
 *    days over eleven years — the German holiday list, recognisable as Dec 24/31,
 *    Jan 1, Good Friday, Easter Monday, Whit Monday, Oct 3. The count is honest
 *    about its own error rather than small enough to hide it.
 */
function isMarketClosure(day: string, sortedDates: string[]): boolean {
  const dow = new Date(`${day}T00:00:00Z`).getUTCDay()
  if (dow === 0 || dow === 6) return true
  const t = Date.parse(`${day}T00:00:00Z`)
  const day_ms = 86_400_000
  // Nearest bar before `day` at ANY distance, and nearest after within the
  // bracket window. "Before, unbounded" is what separates a long closure from a
  // prefix absence.
  let prevAny = Infinity
  let nextNear = Infinity
  for (const d of sortedDates) {
    const delta = Math.round((Date.parse(`${d}T00:00:00Z`) - t) / day_ms)
    if (delta < 0) prevAny = Math.min(prevAny, -delta)
    else if (delta <= HOLES_BRACKET_DAYS) nextNear = Math.min(nextNear, delta)
  }
  // No bar anywhere before: this is a PREFIX absence, not a closure. Whether it
  // means "the instrument started trading later" or "FX coverage began late" is
  // not knowable at this layer, so it stays counted — `gapSymbols` reports the
  // same shape, and quietly reclassifying it here would hide one of the two.
  if (prevAny === Infinity) return false
  // Bars exist but the nearest one is far away on either side ⇒ shut, not
  // missing. This is what removes holiday weeks.
  return prevAny > HOLES_BRACKET_DAYS || nextNear > HOLES_BRACKET_DAYS
}

/** How close a bar must be, either side, for a missing day to count as a hole. */
const HOLES_BRACKET_DAYS = 7

/**
 * Max symbols fetched concurrently by one recompute pass (RECALC_PRICE_CONCURRENCY,
 * default 4). A full-import portfolio has 100+ symbols; fetching them all at
 * once (the old Promise.all) multiplied the price_bars_all load by the number
 * of concurrent passes and pegged the node's CPU (2026-09-19 incident). The
 * global runner serializes passes; this caps the per-pass fan-out.
 */
export const MAX_PRICE_FETCH_CONCURRENCY = 32

export function boundedPriceFetchConcurrency(value: string | undefined): number {
  const requested = Number(value)
  return Number.isFinite(requested)
    ? Math.min(Math.max(Math.floor(requested), 1), MAX_PRICE_FETCH_CONCURRENCY)
    : 4
}

const PRICE_FETCH_CONCURRENCY = boundedPriceFetchConcurrency(process.env.RECALC_PRICE_CONCURRENCY)

/** ISO-4217 shape, so a junk `instrument_currency` is not declared as a base. */
const KNOWN_CURRENCY = /^[A-Z]{3}$/

/**
 * Fetch per-symbol price series with a bounded worker pool (default 4
 * concurrent). `targetCcy` (plan §48.3) carries the per-symbol conversion
 * target — instruments serves the closes already converted, so the value
 * path multiplies qty × close with no FX lookup. Aborts promptly: an aborted
 * signal stops dispatching further symbols (in-flight fetches resolve and
 * are dropped).
 */
export async function fetchPriceSeries(
  symbols: string[],
  from: string,
  to: string,
  authToken: string,
  fetcher: (
    symbol: string,
    from: string,
    to: string,
    authToken: string,
    signal?: AbortSignal,
    currency?: string,
    baseCcy?: string,
    includePrevious?: boolean,
  ) => Promise<PriceBarSeries | null> = fetchPriceBars,
  signal?: AbortSignal,
  targetCcy?: Map<string, string | null>,
  /** §63.10.5 — per-symbol base the caller already knows; passed to instruments
   * so an ambiguous listing can still be converted. */
  baseCcyMap?: Map<string, string | null>,
  /** §72.15 — the portfolio's own base currency. Every close the grid multiplies
   * by a quantity has to be in THIS currency, and it is the only reference that
   * can say whether a series arrived converted. */
  portfolioBase?: string,
  previousSymbols?: ReadonlySet<string>,
): Promise<Map<string, PriceBarSeries>> {
  const out = new Map<string, PriceBarSeries>()
  let next = 0
  /**
   * §63.10 — a rejected fetch must abort the whole pass, not just skip a symbol.
   * Workers run concurrently, so the first failure is latched and re-thrown once
   * they have all settled; without the latch an in-flight `Promise.all` could
   * reject while another worker was still writing into `out`, and the pass would
   * continue with a partial map.
   */
  let failure: unknown = null
  const worker = async (): Promise<void> => {
    for (;;) {
      throwIfAborted(signal)
      if (failure !== null) return
      const i = next++
      if (i >= symbols.length) return
      const wantCcy = targetCcy?.get(symbols[i] ?? "") ?? undefined
      const baseCcy = baseCcyMap?.get(symbols[i] ?? "") ?? undefined
      const includePrevious = previousSymbols?.has(symbols[i] ?? "") ?? false
      let series = await fetcher(symbols[i], from, to, authToken, signal, wantCcy, baseCcy, includePrevious)
      if (failure !== null) return

      // §72.15 — the price-bars response states the currency of the closes it
      // returned. When we asked for no conversion we were ASSUMING the close was
      // already in the portfolio base, and that assumption came from
      // `transactions.instrument_currency`, which the import fills from the
      // PAYMENT currency. A BTC-USD holding bought for 690 PLN was therefore
      // stored as PLN, and the grid took a USD close as if it were PLN —
      // undervaluing 0.004 BTC at ~172 PLN where it is ~688.
      //
      // So check the answer instead of trusting the question we asked. When the
      // series comes back in a currency that is not the portfolio's, re-ask with
      // the conversion, rather than multiplying a foreign price by a quantity.
      // That is an extra round trip only for symbols whose stored currency was
      // wrong; everything else takes one fetch as before.
      if (
        series &&
        series.dates.length > 0 &&
        !wantCcy &&
        portfolioBase &&
        series.currency &&
        series.currency.toUpperCase() !== portfolioBase.toUpperCase()
      ) {
        const converted = await fetcher(
          symbols[i], from, to, authToken, signal, portfolioBase, baseCcy, includePrevious,
        )
        if (failure !== null) return
        if (converted && converted.dates.length > 0) series = converted
      }

      if (series && series.dates.length > 0) out.set(symbols[i], dropUnconvertedPrefix(series))
    }
  }
  const workers = Math.min(PRICE_FETCH_CONCURRENCY, symbols.length)
  await Promise.all(
    Array.from({ length: workers }, () =>
      worker().catch((e) => {
        if (failure === null) failure = e
      }),
    ),
  )
  if (failure !== null) throw failure
  return out
}

export async function transferCloseForDate(
  symbol: string,
  day: string,
  authToken: string,
  baseCurrency: string,
  instrumentCurrency: string,
): Promise<number | null> {
  const base = baseCurrency.toUpperCase()
  const listing = instrumentCurrency.toUpperCase()
  const prices = await fetchPriceSeries(
    [symbol], day, day, authToken, fetchPriceBars, undefined,
    new Map([[symbol, listing === base ? null : base]]),
    new Map([[symbol, listing]]), base, new Set([symbol]),
  )
  const series = prices.get(symbol)
  return series ? buildPriceMap(series.dates, series.closes, [day]).get(day) ?? null : null
}

/**
 * Context for cash-flow-mirrored benchmark overlay (D50).
 *
 * The benchmark no longer projects a pure price index: instead it mirrors the
 * portfolio's external cash deployment schedule into the benchmark instrument,
 * so a deposit of $X "buys" $X of the benchmark at that day's close and a
 * withdrawal of $Y "sells" $Y (fractional shares allowed, clamped ≥ 0).
 */
export interface BenchmarkBuildContext {
  db: DB
  /**
   * §83.3 — was required and never read: `buildBenchmarkSeries` takes the flows
   * and the seed from the caller, because the aggregate `/merged` overlay
   * (`:83.3`) has no single portfolio to name. Left optional rather than
   * invented: passing an arbitrary id would put a lie in a field that looks like
   * it scopes something.
   */
  portfolioId?: string
  baseCurrency: string
  /** daily net external cash flow in base currency, keyed by YYYY-MM-DD */
  flows: Map<string, number>
  /** portfolio invested capital at the window start (seeds the mirror) */
  seedInvested: number
  calcType: "moneyWeighted" | "timeWeighted" | "simple"
}

export interface BenchmarkReturn {
  symbol: string
  name: string
  /** Flow-adjusted return index used by yearly/excess calculations. */
  timeSeries: Array<{ date: string; value: number }>
  /** Absolute synthetic benchmark value in the portfolio base currency. */
  absoluteTimeSeries: Array<{ date: string; value: number }>
  returnPercent: number
  volatility: number
}

export async function buildBenchmarkSeries(
  symbol: string,
  from: string,
  to: string,
  authToken: string,
  name: string,
  ctx: BenchmarkBuildContext,
): Promise<BenchmarkReturn | null> {
  const series = await fetchPriceBars(symbol, from, to, authToken)
  if (!series || series.dates.length === 0) return null

  const base = ctx.baseCurrency.toUpperCase()
  const isBaseCcy = !series.currency || series.currency.toUpperCase() === base
  // plan §48.3 — one resolved pair rate for the overlay (benchmarks are a
  // single instrument; the rate degrades 1:1 when unresolvable).
  const rate = isBaseCcy ? 1 : (await resolvedFxRate(authToken, series.currency!, base, undefined, { strict: true }))?.rate ?? 1
  const toBase = (v: number): number => (isBaseCcy ? v : v * rate)

  // Carry-forward closes (converted to base currency) over every calendar day.
  const days = calendarDays(from, to)
  const closeMap = buildPriceMap(series.dates, series.closes, days)
  const points: Array<{ date: string; close: number }> = []
  for (const day of days) {
    const raw = closeMap.get(day)
    const close = raw != null && raw > 0 ? toBase(raw) : 0
    if (close > 0) points.push({ date: day, close })
  }
  if (points.length === 0) return null

  // Build the mirrored value series as units × close, where units (fractional)
  // grow/shrink by the day's net cash flow valued at that day's close.
  const firstClose = points[0].close
  let units = ctx.seedInvested > 0 ? ctx.seedInvested / firstClose : 0
  const mirrorValues: number[] = []
  const flows: number[] = []
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const flow = ctx.flows.get(p.date) ?? 0
    if (i > 0) {
      units = Math.max(0, units + flow / p.close)
    }
    mirrorValues.push(Math.round(units * p.close * 10000) / 10000)
    flows.push(flow)
  }

  // Render the requested return-type column using the same builders as the
  // portfolio's own snapshots — apples-to-apples mirror semantics.
  const dates = points.map((p) => p.date)
  let columns: number[]
  if (ctx.calcType === "moneyWeighted") columns = buildMwr(mirrorValues, flows, dates)
  else if (ctx.calcType === "simple") columns = buildSimple(mirrorValues)
  else columns = buildTwr(mirrorValues, flows)

  // A withdrawal can exhaust the synthetic benchmark position even though the
  // portfolio later remains invested. Do not publish a permanently flat zero
  // indexed benchmark in that case; fall back to the raw indexed market series,
  // which is the useful return comparison once flow mirroring has no capital
  // left to model. The absolute series remains the real mirror, including the
  // zero after the synthetic position was exhausted, so the value chart still
  // reflects the portfolio's withdrawal schedule.
  const exhausted = mirrorValues.slice(1).some((value) => value <= 0)
  const indexedOutput = exhausted
    ? points.map((p) => Math.round((p.close / firstClose) * 100 * 100) / 100)
    : columns
  const timeSeries = points.map((p, i) => ({ date: p.date, value: indexedOutput[i] }))
  const absoluteTimeSeries = points.map((p, i) => ({ date: p.date, value: mirrorValues[i] }))
  const returnPercent = Math.round((indexedOutput[indexedOutput.length - 1] - 100) * 100) / 100

  // Volatility stays a property of the raw price series (unchanged from D46).
  let volatility = 0
  const prices = points.map((p) => p.close)
  if (prices.length >= 2) {
    const logReturns: number[] = []
    for (let i = 1; i < prices.length; i++) {
      if (prices[i - 1] > 0) logReturns.push(Math.log(prices[i] / prices[i - 1]))
    }
    if (logReturns.length >= 2) {
      const mean = logReturns.reduce((s, v) => s + v, 0) / logReturns.length
      const variance = logReturns.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (logReturns.length - 1)
      volatility = Math.round(Math.sqrt(variance) * Math.sqrt(252) * 100 * 100) / 100
    }
  }

  return { symbol, name, timeSeries, absoluteTimeSeries, returnPercent, volatility }
}

// ── helpers ───────────────────────────────────────────────────────────────

/** Normalise a value that may be a Date, ISO string, or timestamptz string to YYYY-MM-DD. */
function toDateStr(v: unknown): string | null {
  if (!v) return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  const s = String(v)
  // ISO 8601 starts with YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  // fallback: try parsing as a date
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

/** Returns the ISO date string for today minus N days. */
function daysAgo(n: number, now = new Date()): string {
  const d = new Date(now)
  d.setUTCDate(d.getUTCDate() - n)
  return d.toISOString().slice(0, 10)
}

/** Enumerate every calendar date in [from, to] inclusive (YYYY-MM-DD). */
export function calendarDays(from: string, to: string): string[] {
  const days: string[] = []
  const cur = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)
  while (cur <= end) {
    days.push(cur.toISOString().slice(0, 10))
    cur.setUTCDate(cur.getUTCDate() + 1)
  }
  return days
}

/**
 * Build a carry-forward price map from a PriceBarSeries.
 * For each date in `days`, the price is the last known close on or before
 * that date (weekend/holiday carry-forward).
 *
 * pfire-docs#84 — when a date is repeated in the series, the FIRST occurrence
 * is authoritative. instruments serves a stooq/overflow pair stooq-first (its
 * split-adjusted close is the preferred value), and a last-wins `set` let the
 * lower-priority overflow close overwrite it in the valuation grid and the
 * transfer flows. The series endpoint now de-duplicates at the source, so this
 * is the explicit precedence the grid keeps if a duplicate ever arrives.
 */
export function buildPriceMap(
  dates: string[],
  closes: number[],
  days: string[],
): Map<string, number> {
  // sorted price index
  const priceByDate = new Map<string, number>()
  for (let i = 0; i < dates.length; i++) {
    const c = closes[i]
    if (c !== undefined && c > 0 && !priceByDate.has(dates[i])) priceByDate.set(dates[i], c)
  }
  const sortedDates = [...priceByDate.keys()].sort()

  const result = new Map<string, number>()
  let last: number | null = null
  let idx = 0
  for (const day of days) {
    // advance the sorted price dates up to `day`
    while (idx < sortedDates.length && sortedDates[idx] <= day) {
      last = priceByDate.get(sortedDates[idx])!
      idx++
    }
    if (last !== null) result.set(day, last)
  }
  return result
}

// ── backfill status ───────────────────────────────────────────────────────

export async function getBackfillStatus(
  db: DB,
  portfolioId: string,
): Promise<"pending" | "complete" | "failed" | "none"> {
  const rows = await db
    .select({ status: portfolioBackfillMetadata.status })
    .from(portfolioBackfillMetadata)
    .where(eq(portfolioBackfillMetadata.portfolioId, portfolioId))
    .limit(1)
  return (rows[0]?.status as "pending" | "complete" | "failed") ?? "none"
}

/**
 * §63.8 — the held symbols the latest backfill pass had no price bar for (null
 * when every held symbol was priced). Surfaced by `GET /:id/analytics` so the
 * SPA can flag the value as a partial sum instead of a wrong total.
 */
export async function getGapSymbols(
  db: DB,
  portfolioId: string,
): Promise<{
  gapSymbols: string[] | null
  heldGapSymbols: string[] | null
  fxCoverageHoles: Record<string, number> | null
}> {
  const rows = await db
    .select({
      gap: portfolioBackfillMetadata.gapSymbols,
      held: portfolioBackfillMetadata.heldGapSymbols,
      // §72.21 — a row written before this column existed has null, which means
      // "not measured", not "none". It surfaces as absent and the next backfill
      // fills it in, exactly like `heldGapSymbols`.
      holes: portfolioBackfillMetadata.fxCoverageHoles,
    })
    .from(portfolioBackfillMetadata)
    .where(eq(portfolioBackfillMetadata.portfolioId, portfolioId))
    .limit(1)
  const gap = rows[0]?.gap
  const held = rows[0]?.held
  const holes = rows[0]?.holes
  return {
    gapSymbols: gap && gap.length > 0 ? gap : null,
    // A row written before this column existed has `held == null` while `gap` is
    // populated. Falling back to the full list there would re-introduce exactly
    // the false warning §72.30 split the field to remove, so an unknown subset
    // reads as "no confirmed current gap" and the next backfill fills it in.
    heldGapSymbols: held && held.length > 0 ? held : null,
    fxCoverageHoles: holes && Object.keys(holes).length > 0 ? holes : null,
  }
}

async function setBackfillStatus(
  db: DB,
  portfolioId: string,
  status: "pending" | "complete" | "failed",
  extra: { completedAt?: Date; errorMessage?: string } = {},
) {
  await db
    .insert(portfolioBackfillMetadata)
    .values({
      portfolioId,
      status,
      startedAt: status === "pending" ? new Date() : undefined,
      completedAt: extra.completedAt,
      errorMessage: extra.errorMessage,
    })
    .onConflictDoUpdate({
      target: portfolioBackfillMetadata.portfolioId,
      set: {
        status,
        ...(status === "pending" ? { startedAt: sql`now()`, errorMessage: null } : {}),
        ...(extra.completedAt ? { completedAt: extra.completedAt } : {}),
        ...(extra.errorMessage !== undefined ? { errorMessage: extra.errorMessage } : {}),
      },
    })
}

// ── main backfill job ─────────────────────────────────────────────────────

/**
 * Run the full historical backfill for one portfolio. Called fire-and-forget
 * from the analytics endpoint; the returned promise resolves once the pass
 * has been consumed by the serialized backfill runner (passes run one at a
 * time cluster-wide — a page reload mid-import cannot fan out a second
 * price-bar storm). Errors never propagate (→ status='failed').
 */
export function runBackfill(
  db: DB,
  portfolioId: string,
  authToken: string,
  now = new Date(),
): Promise<void> {
  return enqueueBackfill(portfolioId, (signal) => runBackfillCore(db, portfolioId, authToken, now, signal))
}

/**
 * Additive refresh (2026-09-27) — the scheduled job's mode. Like
 * {@link runBackfill} it UPSERTs (never deletes) the computed days, but the
 * window extends to **today**, so the last two days are re-valued: FX for a
 * fresh date is unknown until the ECB publish (~16:00 CET) and the converted
 * portfolio value can still shift after a mid-day pass. A failed pass
 * leaves the prior values in place (upsert, no deletes) — the chart never
 * goes blank.
 */
export function runBackfillRecent(
  db: DB,
  portfolioId: string,
  authToken: string,
  now = new Date(),
): Promise<void> {
  const today = now.toISOString().slice(0, 10)
  return enqueueBackfill(portfolioId, (signal) =>
    runBackfillCore(db, portfolioId, authToken, now, signal, today),
  )
}

/**
 * Force-rebuild a portfolio's value-snapshot history on user request.
 * Uses the full delete+rebuild path (`recalcPortfolioHistory`) rather than the
 * upsert-only backfill so stale rows (days that no longer carry value) are
 * removed. Enqueued through the serialized backfill runner; the returned
 * promise resolves once the slot has been consumed.
 */
export function forcePortfolioRecalc(
  db: DB,
  portfolioId: string,
  authToken: string,
  now = new Date(),
): Promise<void> {
  return enqueueBackfill(
    portfolioId,
    (signal) => recalcPortfolioHistory(db, portfolioId, authToken, now, signal),
  )
}

/**
 * True when a backfill could actually produce snapshots for this portfolio:
 * the window is [first BUY/SELL date, yesterday], so a portfolio whose only
 * trades are from today (or that has no trades) is NOT backfillable — it has
 * an empty (complete) history, not a pending one. Mirrors computeSnapshotBatch's
 * guards exactly (plan §48.4 — merged/analytics must not stay "pending" for
 * same-day-only portfolios).
 */
/**
 * The `in (...)` list for "types that move a position", shared by all three
 * filters below so they cannot drift apart.
 *
 * It includes the transfer pair because a transfer moves a position. With these
 * reading `('BUY','SELL')` only, a portfolio whose *entire* history is one
 * `TRANSFER_IN` — which is exactly what IBKR holds for a symbol received from
 * Equate+ — produced no window at all: no `'BUY','SELL'` row and no cash row, so
 * `computeSnapshotBatch` returned an empty batch and the portfolio had no history.
 * A missing filter value shows up as silently absent data, never as an error.
 *
 * `sql.raw`, not a bare string: interpolating a plain string into a `sql` template
 * makes it a bind parameter, so `in ($1)` — which Postgres rejects with "there is
 * no parameter $1". The values are compile-time constants from an `as const`
 * array, never user input.
 */
const positionMovementTypes = sql.raw(
  LOT_QUANTITY_TYPES.map((v) => `'${v}'`).join(","),
)

export async function hasBackfillableHistory(
  db: DB,
  portfolioId: string,
  now = new Date(),
): Promise<boolean> {
  const [row] = await db
    .select({ minDate: sql<string>`min(${portfolioTransactions.executedAt})` })
    .from(portfolioTransactions)
    .where(
      and(
        transactionInPortfolio(portfolioId),
        sql`${portfolioTransactions.type} in (${positionMovementTypes})`,
      ),
    )
  const from = row?.minDate ? toDateStr(row.minDate) : null
  return from !== null && from <= daysAgo(1, now)
}

async function runBackfillCore(
  db: DB,
  portfolioId: string,
  authToken: string,
  now: Date,
  signal?: AbortSignal,
  toOverride?: string,
): Promise<void> {
  await setBackfillStatus(db, portfolioId, "pending")
  try {
    await _runBackfillCore(db, portfolioId, authToken, now, signal, toOverride)
    await setBackfillStatus(db, portfolioId, "complete", { completedAt: new Date() })
  } catch (err) {
    // An aborted pass stays silent: the pass that replaced it recomputes the
    // latest state.
    if (err instanceof RecalcAbortedError) return
    const msg = err instanceof Error ? err.message : String(err)
    await setBackfillStatus(db, portfolioId, "failed", { errorMessage: msg }).catch(() => undefined)
  }
}

/** Marker error: the recalc pass was aborted mid-run (new mutation arrived). */
export class RecalcAbortedError extends Error {
  constructor() {
    super("recalc aborted by newer transaction change")
    this.name = "RecalcAbortedError"
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RecalcAbortedError()
}

export interface SnapshotRow {
  portfolioId: string
  snapshotDate: string
  value: string
  invested: string
  netFlow: string
  /**
   * §78.5 — base-currency cost of positions held on this day that have **no
   * price**. `value` excludes them (a held-but-unpriced row contributes 0), so
   * without this column the series cannot distinguish "the market fell" from
   * "money is parked in something nothing can quote".
   *
   * Stored per day rather than as a window summary because the symptom is a
   * step on a specific date — IKE Marek's −76.1% on 2021-11-09 was 5 717,65 of
   * bonds — and a total cannot place it.
   */
  unpricedValue: string
  /**
   * §72.31 — base-currency COST of positions whose price on this day is a
   * CARRIED-FORWARD value, not a real bar for this day, and where the market was
   * not closed. `unpricedValue` cannot see these: carry-forward means the grid has
   * a price, so the value looks complete.
   */
  carriedValue: string
}

/**
 * Result of {@link computeSnapshotBatch}: the per-day snapshot rows plus the
 * held-but-unpriced symbols (no price bar in the window) that were dropped from
 * every day's value. `gapSymbols.length > 0` means the stored value is a
 * **partial** sum (§63.8).
 */
export interface SnapshotBatch {
  rows: SnapshotRow[]
  /**
   * §72.30 — **window-wide**. Every symbol that was held on *any* day of the
   * window and lacked a price on at least one of those days. `length > 0` means
   * the stored value is a **partial** sum for part of the history.
   *
   * This is deliberately NOT the abort input: it is a report, and it spans days
   * the pass is not deciding about. Use `unpricedLastDay` for that.
   */
  gapSymbols: string[]
  /**
   * §72.30 — the subset of `gapSymbols` still HELD on the window's last day.
   *
   * `gapSymbols` is window-wide: it lists every symbol that was held on *any*
   * day and lacked a bar on at least one such day. That is the right answer to
   * "is this history a partial sum?" and the wrong answer to "is the value I am
   * looking at right now short?" — the two came back as one field, and PROD
   * (2026-10-01) rendered the consequence: the banner read "Value excludes 7
   * positions without price history" for IKE Beata, whose 7 flagged symbols were
   * **all closed**. Its current value was complete. A warning that is wrong about
   * the number in front of the user trains them to ignore the real one.
   *
   * Empty while `gapSymbols` is non-empty is the normal, healthy case: the
   * history has holes, today's value does not.
   */
  heldGapSymbols: string[]
  /**
   * §63.10 — held symbols the pass was asked to price (qty > 0 on the window's
   * last day). `unpricedLastDay === heldSymbols` means the pass priced *nothing*,
   * which is never a legitimate result: it is what a transport/auth failure looks
   * like once it has been collapsed into "no data". A genuinely all-cash
   * portfolio has `heldSymbols === 0` and is unaffected.
   */
  heldSymbols: number
  /**
   * §72.30 — how many of those last-day-held symbols had no price. Kept separate
   * from `gapSymbols` so that a mid-window gap (an illiquid bond that was later
   * sold) can be reported honestly without tripping the abort: before this split,
   * a portfolio whose live holdings all priced fine but which held an unpriceable
   * bond earlier would be judged "priced nothing" and lose its entire history.
   */
  unpricedLastDay: number
  /**
   * §72.21 — per symbol, the days it was **held** on but instruments returned **no
   * bar** for, counted before `buildPriceMap` carry-forward made the difference
   * invisible.
   *
   * This is the FX-coverage boundary made reportable, and it is the *scattered*
   * case that `gapSymbols` structurally cannot see: a hole after the first bar
   * survives carry-forward as a repeated close, so `prices.has(day)` is true and
   * nothing is ever reported. A prefix hole does show up, in `gapSymbols`, where
   * it is indistinguishable from a symbol with no history at all.
   *
   * **A count, not a diagnosis.** At this layer "no bar returned" and "bar
   * dropped for want of an FX rate" are the same absence. Only instruments knows
   * which — via `unconvertedDates` (§72.10), which is `null` on the response
   * until that contract field ships. So this says *the series has holes where it
   * is held*, and the reason needs one more field, not a better guess.
   */
  fxCoverageHoles: Map<string, string[]>
}

/** No history to backfill (no BUY/SELL or cash yet) — shared by every guard. */
const EMPTY_BATCH: SnapshotBatch = {
  rows: [], gapSymbols: [], heldGapSymbols: [], heldSymbols: 0, unpricedLastDay: 0, fxCoverageHoles: new Map(),
}

/**
 * §63.10 — refuse to persist a pass that could not price a single held symbol.
 *
 * The stored value would be cash only, written over a correct one by
 * `onConflictDoUpdate`, and the fleet-wide symptom was `gap_symbols` equal to the
 * position count on every portfolio (IBKR ended up with a *negative* value). With
 * a real credential in place this should never fire; it exists so the next
 * credential or transport mistake is loud instead of silent.
 */
export class UnpriceablePortfolioError extends Error {
  constructor(
    public readonly portfolioId: string,
    public readonly heldSymbols: number,
  ) {
    super(
      `refusing to write snapshots for portfolio ${portfolioId}: priced 0 of ${heldSymbols} ` +
        `held symbols — the price source was not usable (a partial pass with at least ` +
        `one priced symbol is still written and flagged in gap_symbols)`,
    )
    this.name = "UnpriceablePortfolioError"
  }
}

/**
 * §72.21 — reduce `fxCoverageHoles` (symbol → the hole dates) to the counts that
 * get persisted and returned.
 *
 * **Counts, not dates, on purpose.** The dates behind these can run to thousands
 * over a wide window, and they are not what a UI states: "SAP.DE is missing 12
 * held days" is the claim, and the dates would be an unreadable dump on a
 * summary row. The per-day detail is still available where it belongs — on the
 * price-bar series, as `unconvertedDates` (§72.10), which separates "dropped for
 * want of an FX rate" from "no history at all". At the valuation layer those two
 * are one absence, so this must not pretend to know which it was.
 */
export function fxCoverageCounts(
  holes: Map<string, string[]> | null | undefined,
): Record<string, number> | null {
  if (!holes || holes.size === 0) return null
  const out: Record<string, number> = {}
  for (const [sym, dates] of holes) {
    // A zero would be a lie (the map only holds symbols with ≥1 hole) and would
    // trip the contract's `minimum: 1`, so it is dropped rather than written.
    const n = dates.length
    if (n > 0) out[sym] = n
  }
  return Object.keys(out).length > 0 ? out : null
}

export function isUnpriceable(batch: SnapshotBatch): boolean {
  // §72.30 — last-day view only. Deliberately NOT gapSymbols.length: that is a
  // window-wide report now, and a portfolio can be fully priced today while
  // having held an unpriceable bond last year.
  return batch.heldSymbols > 0 && batch.unpricedLastDay >= batch.heldSymbols
}

/**
 * §63.8 — record which held symbols lacked a price bar in the latest pass, so
 * `GET /:id/analytics` can flag the stored value as a *partial* sum. A null
 * clears a previously-recorded gap (all held symbols now priced).
 */
export async function persistGapSymbols(
  db: DB,
  portfolioId: string,
  gapSymbols: string[] | null,
  /** §72.30 — the still-held subset. Defaults to the full list for callers that
   *  only have one (a forced rebuild of a window whose last day is the only day
   *  that matters); the normal backfill pass supplies both. */
  heldGapSymbols?: string[] | null,
  /** §72.21 — symbol → held days with no returned bar. `undefined` means "this
   *  caller does not measure it" and leaves any existing value alone; `null` or an
   *  empty map clears it. The distinction is load-bearing: an omitted argument must
   *  not read as "measured, and there were none", or a partial caller would
   *  silently erase a real finding. */
  fxCoverageHoles?: Record<string, number> | null,
): Promise<void> {
  // Empty = every held symbol priced → store NULL ("no gap") rather than [] so
  // consumers can treat null as the clean state.
  const gap = gapSymbols && gapSymbols.length > 0 ? gapSymbols : null
  const held = heldGapSymbols && heldGapSymbols.length > 0 ? heldGapSymbols : null
  const holes =
    fxCoverageHoles !== undefined && Object.keys(fxCoverageHoles ?? {}).length > 0
      ? fxCoverageHoles
      : null
  await db
    .insert(portfolioBackfillMetadata)
    .values({
      portfolioId,
      status: "pending",
      gapSymbols: gap,
      heldGapSymbols: held,
      ...(fxCoverageHoles !== undefined ? { fxCoverageHoles: holes } : {}),
    })
    .onConflictDoUpdate({
      target: portfolioBackfillMetadata.portfolioId,
      set: {
        gapSymbols: gap,
        heldGapSymbols: held,
        ...(fxCoverageHoles !== undefined ? { fxCoverageHoles: holes } : {}),
      },
    })
}

/**
 * Recompute the full daily value/invested/netFlow series for one portfolio
 * from its BUY/SELL transactions + instrument price bars (steps 1–7 of the old
 * `_runBackfillCore`). Returns `{ rows: [], gapSymbols: [] }` when there is no
 * history to backfill (no BUY/SELL transactions, or nothing valued). Honors an
 * optional AbortSignal and throws RecalcAbortedError on abort so the caller
 * never commits a partial series.
 */
export async function computeSnapshotBatch(
  db: DB,
  portfolioId: string,
  authToken: string,
  now = new Date(),
  signal?: AbortSignal,
  /** Optional window-end override (YYYY-MM-DD). The default is yesterday —
   * the scheduled additive refresh passes *today* so the last two days are
   * re-valued (FX for a new date is unknown until the ECB publish and can
   * still move the converted value). */
  toOverride?: string,
): Promise<SnapshotBatch> {
  throwIfAborted(signal)

  // 1. Determine the window start: the earliest BUY/SELL trade OR cash row
  //    (§62.4 — a portfolio that only holds cash still has value to backfill).
  const minTrade = await db
    .select({ minDate: sql<string>`min(${portfolioTransactions.executedAt})` })
    .from(portfolioTransactions)
    .where(
      and(
        transactionInPortfolio(portfolioId),
        sql`${portfolioTransactions.type} in (${positionMovementTypes})`,
      ),
    )
  const [pfRow] = await db
    .select({ baseCurrency: portfolios.baseCurrency, isVirtual: portfolios.isVirtual })
    .from(portfolios)
    .where(eq(portfolios.id, portfolioId))
    .limit(1)
  if (!pfRow) throw new Error(`backfill: portfolio ${portfolioId} not found`)
  const base = pfRow.baseCurrency.toUpperCase()
  const minCash = await db
    .select({ minDate: sql<string>`min(${portfolioCashTransactions.transactionDate})` })
    .from(portfolioCashTransactions)
    .where(eq(portfolioCashTransactions.portfolioId, portfolioId))
  const firstDate = minTrade[0]?.minDate ?? (minCash[0]?.minDate ? `${minCash[0].minDate}T00:00:00.000Z` : null)
  if (!firstDate) return EMPTY_BATCH // no trades and no cash yet
  const from = toDateStr(firstDate)
  if (!from) return EMPTY_BATCH
  const to = toOverride ?? daysAgo(1, now) // yesterday (today when overridden)
  if (from > to) return EMPTY_BATCH // only one day of history, nothing to backfill

  // 2. Fetch all BUY/SELL transactions ordered by date
  const txRows = await db
    .select({
      symbol: portfolioTransactions.instrumentSymbol,
      type: portfolioTransactions.type,
      quantity: portfolioTransactions.quantity,
      price: portfolioTransactions.price,
      exchangeRate: portfolioTransactions.exchangeRate,
      executedAt: portfolioTransactions.executedAt,
      instrumentCurrency: portfolioTransactions.instrumentCurrency,
      externalId: portfolioTransactions.externalId,
    })
    .from(portfolioTransactions)
    .where(
      and(
        transactionInPortfolio(portfolioId),
        sql`${portfolioTransactions.type} in (${positionMovementTypes})`,
        lt(portfolioTransactions.executedAt, now),
      ),
    )
    .orderBy(portfolioTransactions.executedAt)

  const hasCash =
    (await db
      .select({ d: sql<string>`1` })
      .from(portfolioCashTransactions)
      .where(eq(portfolioCashTransactions.portfolioId, portfolioId))
      .limit(1)).length > 0
  if (txRows.length === 0 && !hasCash) return EMPTY_BATCH

  // Collect unique symbols + their instrument currencies (null = unknown,
  // never guessed — plan §45.3)
  const symbolCcy = new Map<string, string | null>()
  for (const tx of txRows) {
    if (tx.symbol) symbolCcy.set(tx.symbol, tx.instrumentCurrency)
  }

  // 2b. §72.14 — option-premium legs are not share disposals.
  //
  // An option trade arrives as a pair: a SELL of 100 at the premium (1.04-1.30)
  // and an EXPIRATION at 0 whose externalId is the SELL's plus "#e". The lot
  // ledger closes both against a SHORT option lot, but summing raw quantities
  // counts the SELL as selling 100 shares of the UNDERLYING.
  //
  // On Equate+ (SAP.DE) that is 481.77 shares bought against 976 sold: a net of
  // -494.23, which `Math.max(0, cum)` clamps to ZERO for the rest of history.
  // Every snapshot valued the position at 0, so the whole series was cash-only
  // and the final day — priced from the lot ledger, which has the position right
  // at 5.765762 shares — was the only point that included it. That is the
  // spike, and `heldCount`/gapSymbols cannot report it because they key on the
  // same quantity that had gone to zero.
  const optionLegIds = new Set<string>()
  const expRows = await db
    .select({ externalId: portfolioTransactions.externalId })
    .from(portfolioTransactions)
    .where(
      and(
        transactionInPortfolio(portfolioId),
        eq(portfolioTransactions.type, "EXPIRATION"),
      ),
    )
  for (const r of expRows) {
    if (r.externalId) optionLegIds.add(r.externalId.replace(/#e$/, ""))
  }

  // 3. Build cumulative qty_held per symbol per day.
  //    For each symbol: sorted list of (date, deltaQty) then accumulated.
  //
  //    §78.5 — each event also carries a `costDelta`, the money that leg moved in
  //    the portfolio's base currency, accumulated into `costMaps` alongside.
  //
  //    **This exists because a held-but-unpriced position contributes 0 to
  //    `value` while its cash leg has already left, so buying one looks exactly
  //    like a loss.** Measured on PROD: IKE Marek bought INS0922 + VOX0224 on
  //    2021-11-09 for 5 717,65 and the value fell 5 728,51 — a −76.1% day that
  //    was never a market move. §78.3's answer is "accept the partial sum and say
  //    so", and saying so needs the amount: `gapSymbols` names the symbol, but a
  //    chart cannot attribute a step without knowing it was 5 717,65 of bonds.
  //
  //    NOT `positions.average_cost_basis`, deliberately: that column is populated
  //    only for positions that exist today, and these were all closed years ago.
  //    Replaying the legs is the only way to price a window that is mostly closed
  //    positions. It is the same arithmetic as `qtyMaps`, one more accumulator.
  type QtyEvent = { date: string; delta: number; costDelta: number }
  const symbolEvents = new Map<string, QtyEvent[]>()
  for (const tx of txRows) {
    if (!tx.symbol) continue
    // BOTH legs of an option premium are cash, not share disposals: the SELL
    // carries the premium and the "#e" EXPIRATION is its marker. Skipping only
    // the SELL double-counted the close once the EXPIRATION entered this query —
    // which it did when `positionMovementTypes` began including the transfer pair
    // and EXPIRATION, driving the running quantity to 0 and collapsing the whole
    // series to the premium. Both are excluded by base id.
    if (tx.externalId && optionLegIds.has(tx.externalId.replace(/#e$/, ""))) continue
    // `quantitySign`, not "not a BUY means a decrement". A TRANSFER_IN that has
    // just arrived INCREASES this portfolio's quantity; the old shape decremented
    // it, driving a receiving portfolio's daily quantity negative.
    const sign = quantitySign(tx.type)
    if (sign === 0) continue
    const delta = sign * Number(tx.quantity)
    const date = toDateStr(tx.executedAt) ?? ""
    if (!date) continue
    // `exchange_rate` is the rate the import applied to reach the portfolio's
    // base, and these bonds are PLN-denominated at rate 1, so `qty x price x
    // rate` is base currency. A null rate is treated as 1: the same choice the
    // import makes, and a wrong currency guess here would only affect a figure
    // that is explicitly labelled "this much could not be priced".
    const price = Number(tx.price ?? 0)
    const rate = Number(tx.exchangeRate ?? 1) || 1
    const costDelta = sign * Math.abs(delta) * price * rate
    const arr = symbolEvents.get(tx.symbol) ?? []
    arr.push({ date, delta, costDelta })
    symbolEvents.set(tx.symbol, arr)
  }

  // 4. Per-symbol conversion target (base already resolved in step 1).
  //    known non-base instrument currencies are converted server-side
  //    (?currency=<base>); unknown or already-base currencies stay native.
  const targetCcy = new Map<string, string | null>()
  for (const [sym, ccy] of symbolCcy) {
    targetCcy.set(sym, ccy && ccy.toUpperCase() !== base ? base : null)
  }

  // 5. Daily value grid + cumulative qty per symbol per day.
  //    qty_held(sym, day) = sum of deltas where date <= day
  const days = calendarDays(from, to)
  const qtyMaps = new Map<string, Map<string, number>>()
  // §78.5 — cumulative COST BASIS per symbol per day, same shape as `qtyMaps`.
  const costMaps = new Map<string, Map<string, number>>()
  for (const [sym, events] of symbolEvents) {
    const sorted = events.slice().sort((a, b) => a.date.localeCompare(b.date))
    const dayQty = new Map<string, number>()
    const dayCost = new Map<string, number>()
    let cum = 0
    let cumCost = 0
    let ei = 0
    for (const day of days) {
      while (ei < sorted.length && sorted[ei].date <= day) {
        cum += sorted[ei].delta
        cumCost += sorted[ei].costDelta
        ei++
      }
      dayQty.set(day, Math.max(0, cum))
      dayCost.set(day, Math.max(0, cumCost))
    }
    qtyMaps.set(sym, dayQty)
    costMaps.set(sym, dayCost)
  }

  // §63.10.5 — only value symbols this portfolio actually held INSIDE the
  // window. `symbolCcy` is built from every BUY/SELL row ever imported, so it
  // also contains long-closed positions (PROD: IKE Beata's AFL, sold 2024-03,
  // in a window starting 2021-10). Those contribute nothing to any day, and one
  // of them failing to price aborted the entire portfolio — which is how a
  // closed ticker kept a live portfolio unvaluable.
  const symbols = [...symbolCcy.keys()].filter((sym) => {
    const perDay = qtyMaps.get(sym)
    if (!perDay) return false
    for (const day of days) {
      if ((perDay.get(day) ?? 0) > 0) return true
    }
    return false
  })
  const transferMovesByDay = new Map<string, { symbol: string; quantity: number }[]>()
  const transferSymbols = new Set<string>()
  for (const tx of txRows) {
    if (!tx.symbol || !isTransferType(tx.type)) continue
    const day = toDateStr(tx.executedAt)
    if (!day || day < from || day > to) continue
    const arr = transferMovesByDay.get(day) ?? []
    arr.push({ symbol: tx.symbol, quantity: quantitySign(tx.type) * Number(tx.quantity) })
    transferMovesByDay.set(day, arr)
    transferSymbols.add(tx.symbol)
  }
  const pricingSymbols = [...new Set([...symbols, ...transferSymbols])]

  // 6. Fetch price series per held or transferred symbol from instruments (bounded
  //    fan-out — see fetchPriceSeries; an aborted signal rejects promptly). A
  //    cash-only portfolio has no symbols to price.
  // §63.10.5 — the known instrument currency travels with the request, so a
  // symbol instruments cannot resolve on its own is still convertible.
  const declaredBase = new Map<string, string | null>()
  for (const [sym, ccy] of symbolCcy) {
    declaredBase.set(sym, ccy && KNOWN_CURRENCY.test(ccy) ? ccy.toUpperCase() : null)
  }
  const priceSeries = pricingSymbols.length
    ? await fetchPriceSeries(
        pricingSymbols, from, to, authToken, fetchPriceBars, signal,
        targetCcy,
        declaredBase,
        base,
        pfRow.isVirtual ? new Set(pricingSymbols) : transferSymbols,
      )
    : new Map<string, PriceBarSeries>()
  throwIfAborted(signal)

  // §62.4 / D50: netFlow = EXTERNAL flows only (DEPOSIT +, WITHDRAWAL −,
  // TRANSFER ± its own leg) in base currency — trade rows (BUY/SELL) are
  // internal cash↔position moves, no longer flows. Cash value is added to
  // the position value below via the per-day base-currency balance series.
  // §63.10 — strict: a 1:1 FX degrade across a whole valuation misvalues every
  // non-base row silently, so an unusable FX source aborts the pass instead.
  const dailyFlows = await dailyExternalFlows(db, authToken, portfolioId, from, to, base, { strict: true })
  const cashSeries = await cashBalanceSeries(db, authToken, portfolioId, from, to, base, { strict: true })
  throwIfAborted(signal)

  // §72.21 — count the held days instruments did NOT return a bar for, while
  // that difference still exists. It is measured against `series.dates` (what
  // came back) and NOT against `priceMaps`, which is built immediately below and
  // carry-forwards every day from the first surviving bar: after that, a scattered
  // hole is indistinguishable from a day that legitimately reused the last close.
  const fxCoverage = fxCoverageHoles(qtyMaps, priceSeries, symbols, days)

  // Pre-build carry-forward price maps per symbol
  const priceMaps = new Map<string, Map<string, number>>()
  for (const sym of pricingSymbols) {
    const series = priceSeries.get(sym)
    if (series) {
      priceMaps.set(sym, buildPriceMap(series.dates, series.closes, days))
    }
  }
  const transferMarketFlows = marketValuedTransferFlows(transferMovesByDay, priceMaps)

  // §62 follow-up (2026-09-27): invested(day) = cumulative net EXTERNAL cash
  // flow up to that day (deposits − withdrawals ± transfer legs, base ccy) —
  // "money put in". Position cost basis is NOT the invested basis (a fully
  // invested portfolio has ~0 cash balance but a large invested total).
  // §69.4 — SEED the cumulative flow with capital invested BEFORE the window.
  //
  // The window starts at the first BUY/SELL date, so any cash row dated earlier
  // is outside it. Accumulating from zero therefore dropped it from EVERY
  // historical day, while `snapshotPortfolioValue` (the live path) calls
  // `externalCashInvested` over ALL history and keeps it. The two then disagreed
  // by exactly the pre-window capital, and because the live snapshot is the last
  // point of the series it surfaced as a vertical spike on the final day — PROD,
  // IKE Marek, 2026-09-28: `invested` read 38,771 for the whole series and 54,548
  // on the last row, a step of 15,777 from a deposit dated 2021-10-18. Return is
  // computed from this pair, so the step showed as a sudden jump in the chart.
  //
  // The fix is to start the accumulator where the money actually started rather
  // than at the window edge. Same basis as the live path, by construction.
  const windowStartDate = new Date(`${from}T00:00:00.000Z`)
  const dayBeforeWindow = toDateStr(new Date(windowStartDate.getTime() - 86_400_000))
  let cumulativeFlow = 0
  if (dayBeforeWindow) {
    const preWindowFlows = await dailyExternalFlows(
      db, authToken, portfolioId, "0000-01-01", dayBeforeWindow, base, { strict: true },
    )
    for (const v of preWindowFlows.values()) cumulativeFlow += v
  }

  // The capital basis is cumulative net external cash PLUS the cost of whatever
  // has been transferred in or out, signed. Without the second term a portfolio
  // that sent an instrument away kept its basis while losing the value, so
  // `totalReturn = value - invested` reported a full negative of the transferred
  // value — a −100% day for a holding that was merely moved.
  //
  // Cost, not market: `invested` is a basis, so it travels with the shares, and
  // the accrued unrealised gain is just `value - invested` and follows the
  // holding. Rebasing at the transfer-date market would delete real profit — five
  // shares bought at 10 and sold at 12 gained 10, rebased at 11 they gain 5.
  //
  // The RETURN series is neutralised by the market-valued flow instead
  // (`marketValuedTransferFlows`), because that is how far `value` actually moved. The
  // two coincide unless the price moved since purchase.
  const transferBasisFlows = await dailyTransferBasis(
    db, authToken, portfolioId, from, to, base, { strict: true },
  )
  const preWindowBasis = dayBeforeWindow
    ? await dailyTransferBasis(db, authToken, portfolioId, "0000-01-01", dayBeforeWindow, base, { strict: true })
    : new Map<string, number>()
  let cumulativeTransferBasis = 0
  for (const v of preWindowBasis.values()) cumulativeTransferBasis += v

  const cumulativeFlows = new Map<string, number>()
  for (const day of days) {
    cumulativeFlow += dailyFlows.get(day) ?? 0
    cumulativeTransferBasis += transferBasisFlows.get(day) ?? 0
    cumulativeFlows.set(day, cumulativeFlow + cumulativeTransferBasis)
  }

  // 7. Build the snapshot batch (RECALC_DEBUG=1 → per-symbol day-0 debug logs)
  const recalcDebug = process.env.RECALC_DEBUG === "1"
  const snapBatch: SnapshotRow[] = []

  // §63.8 — a held symbol with NO price bar for a day is *dropped* from that
  // day's value, so the stored series is a partial sum. Surface those symbols so
  // the caller can flag the value as incomplete instead of silently
  // under-reporting (the IKE Beata spike: 18/23 symbols priced → 155k vs true 205k).
  //
  // §72.30 — the gap scan covers EVERY day a symbol was held, not just the
  // window's last day. Last-day-only meant a symbol that was held and unpriced
  // *earlier* in the window went unreported, and the backfill still recorded
  // `status=complete`. PROD (IKE Marek, 2022-06-13): four bonds whose upstream
  // returns a permanent 404 (BST0922, INS0922, NVA0624, VOX0224) contributed
  // nothing while held, so the value was understated by ~10.3k PLN; the sale
  // turned them into cash at real proceeds and the chart showed a +152% "spike".
  // By the last day they were closed, so the old check saw nothing to report.
  const lastDay = days[days.length - 1]
  const gapSymbols: string[] = []
  // §72.30 — the same scan, narrowed to the window's last day. `gapSymbols`
  // answers "was this history a partial sum?" and this answers "is the value in
  // front of the user right now short?" — the two are different claims and PROD
  // showed the conflation is visible, not theoretical.
  const heldGapSymbols: string[] = []
  let heldCount = 0
  let unpricedLastDay = 0
  for (const sym of symbols) {
    const perDay = qtyMaps.get(sym)
    if (!perDay) continue
    const prices = priceMaps.get(sym)
    // Abort accounting (§63.10) is deliberately still last-day-only: a symbol
    // that cannot be priced today must not make the portfolio unvaluable, and
    // these four bonds are permanently unpriceable upstream — aborting on them
    // would strand the whole portfolio.
    if ((perDay.get(lastDay) ?? 0) > 0) {
      heldCount += 1
      if (!prices || !prices.has(lastDay)) {
        unpricedLastDay += 1
        if (!gapSymbols.includes(sym)) gapSymbols.push(sym)
        heldGapSymbols.push(sym)
      }
    }
    for (const day of days) {
      if ((perDay.get(day) ?? 0) <= 0) continue
      if (prices && prices.has(day)) continue
      if (!gapSymbols.includes(sym)) gapSymbols.push(sym)
      break
    }
  }

  for (const day of days) {
    // §63.2 — `composePortfolioValue` is the rule both valuation paths share:
    // a held-but-unpriced row contributes 0 and is counted, `totalValue` is the
    // sum by construction, and cash is added last and never clamped (§62 — a
    // margin account's negative balance reduces the total). It was written twice
    // here and in `valuation.ts` and could drift; §68 is the rule that says it
    // must not.
    //
    // What stays HERE is the per-row arithmetic, and it is genuinely different:
    // the close arriving from `fetchPriceSeries` is already in the portfolio's
    // base currency (§48.3), so there is no instrument currency to convert and
    // `splitPortfolioValue` cannot be used here at all.
    //
    // `unpricedPositions` from the call is DELIBERATELY NOT used for the abort
    // guard. §72.31 separated `unpricedLastDay` from this because folding
    // mid-window gaps into the array that drives `isUnpriceable` made a healthy
    // portfolio look unpriceable and would have destroyed the history of every
    // portfolio that ever held an illiquid bond. The two counts answer different
    // questions; do not "simplify" them into one.
    const contributions: (number | null)[] = []
    let totalInvested = 0
    // §78.5 — the base-currency cost of everything held TODAY that has no price.
    // This is the number that makes an unpriceable buy legible: `value` has
    // already had the cash deducted, so without this the series shows a loss that
    // is really money parked in something nothing can quote.
    let unpricedCost = 0
    // §72.31 — cost of positions whose price on THIS day is a carried-forward
    // value rather than a real bar for this day.
    //
    // `buildPriceMap` advances `last` and stamps it onto every subsequent day,
    // so a day with no returned bar is priced from the previous close and `value`
    // looks complete. Measured on PROD: Crypto reports `gapSymbols: ["BTC-USD"]`
    // and `fxCoverageHoles` counts 24 such days, yet `unpricedValue` was 0 on all
    // 1,690 days — because carry-forward means `price != null`, so the unpriced
    // path never sees it. **"Partial on which days" was therefore not answerable
    // from anything on the wire.**
    //
    // The weekend exclusion is not optional, and it is the §72.21 lesson applied
    // before the mistake rather than after: carry-forward across a closure is what
    // the grid is FOR, and counting it would put ~29% of every series into this
    // column and bury the real holes. `isMarketClosure` is the same predicate
    // §72.21 uses, so the two columns cannot disagree about what a closure is.
    let carriedCost = 0
    for (const sym of symbols) {
      const qty = qtyMaps.get(sym)?.get(day) ?? 0
      // Not held on this day ⇒ contributes nothing AND is not unpriced: the
      // position does not exist yet, so there is no missing price to report.
      if (qty <= 0) continue
      const price = priceMaps.get(sym)?.get(day)
      // Held but unpriced ⇒ null, which `composePortfolioValue` counts. This
      // used to be a bare `continue`, which is the same number but had no way to
      // say so.
      contributions.push(price == null ? null : qty * price)
      if (price == null) {
        unpricedCost += costMaps.get(sym)?.get(day) ?? 0
      } else {
        // Priced, but possibly from a carried value. Only the series that was
        // actually fetched can say; a symbol with no series at all is the
        // `unpricedCost` case above and is not double-counted here.
        const series = priceSeries.get(sym)
        if (series && !series.dates.includes(day) && !isMarketClosure(day, series.dates)) {
          carriedCost += costMaps.get(sym)?.get(day) ?? 0
        }
      }
      if (recalcDebug && price != null && day === days[days.length - 1]) {
        console.log(
          `[recalc-debug] pf=${portfolioId} day=${day} sym=${sym} qty=${qty} close=${price} contrib=${(qty * price).toFixed(2)} base=${base}`,
        )
      }
    }
    // §62.4 — cash is part of the portfolio value (base-currency balance at
    // day's close); `invested` stays the position cost basis so TWR/MWR keep
    // treating cash as external flow (netFlow) rather than invested capital.
    const cashDay = cashSeries.get(day) ?? 0
    const { totalValue } = composePortfolioValue(contributions, cashDay)
    totalInvested = cumulativeFlows.get(day) ?? 0
    if (recalcDebug && day === days[days.length - 1]) {
      console.log(
        `[recalc-debug] pf=${portfolioId} day=${day} CASH=${cashDay.toFixed(2)} TOTAL=${totalValue.toFixed(2)} invested=${totalInvested.toFixed(2)}`,
      )
    }
    // RECALC_DEBUG — the SNAPSHOT path's composition, at the window's last day
    // only. `cash-balance-series` already narrates every day of the window, so
    // the two together answer "why does the stored total differ from the live
    // one" without re-running a backfill or querying the DB by hand.
    if (recalcDebug && day === days[days.length - 1]) {
      console.log(
        `[recalc-debug] pf=${portfolioId} day=${day} SNAPSHOT instruments=${(totalValue - cashDay).toFixed(2)} cash=${cashDay.toFixed(2)} total=${totalValue.toFixed(2)} invested=${totalInvested.toFixed(2)} base=${base} symbols=${symbols.length} gapSymbols=[${gapSymbols.join(",")}]`,
      )
    }
    if (totalValue !== 0) {
      snapBatch.push({
        portfolioId,
        snapshotDate: day,
        value: totalValue.toFixed(8),
        invested: totalInvested.toFixed(8),
        netFlow:
          ((dailyFlows.get(day) ?? 0) + (transferMarketFlows.get(day) ?? 0)).toFixed(8),
        unpricedValue: unpricedCost.toFixed(8),
        carriedValue: carriedCost.toFixed(8),
      })
    }
  }

  return {
    rows: snapBatch,
    gapSymbols,
    heldGapSymbols,
    heldSymbols: heldCount,
    unpricedLastDay,
    fxCoverageHoles: fxCoverage,
  }
}

async function _runBackfillCore(
  db: DB,
  portfolioId: string,
  authToken: string,
  now: Date,
  signal?: AbortSignal,
  toOverride?: string,
): Promise<void> {
  const batch = await computeSnapshotBatch(db, portfolioId, authToken, now, signal, toOverride)
  // §63.10 — never overwrite good values with a pass that priced nothing.
  if (isUnpriceable(batch)) throw new UnpriceablePortfolioError(portfolioId, batch.heldSymbols)
  await persistGapSymbols(db, portfolioId, batch.gapSymbols, batch.heldGapSymbols, fxCoverageCounts(batch.fxCoverageHoles))
  if (batch.rows.length === 0) return

  // Bulk upsert in chunks to avoid huge parameter lists
  const CHUNK = 100
  for (let i = 0; i < batch.rows.length; i += CHUNK) {
    const chunk = batch.rows.slice(i, i + CHUNK)
    await db
      .insert(valueSnapshots)
      .values(chunk)
      .onConflictDoUpdate({
        target: [valueSnapshots.portfolioId, valueSnapshots.snapshotDate],
        set: {
          value: sql`excluded.value`,
          invested: sql`excluded.invested`,
          netFlow: sql`excluded.net_flow`,
          // §78.5 — must be in the upsert's `set`, not just the insert column, or
          // a recompute would update `value` and leave the withheld amount
          // describing the previous run's coverage.
          unpricedValue: sql`excluded.unpriced_value`,
          carriedValue: sql`excluded.carried_value`,
        },
      })
  }

  // Recompute stored return-type columns now that all snapshots are written
  await recomputeReturnColumns(db, portfolioId)
  // §53.5 — keep portfolios.current_value in step with the newest snapshot
  await syncCurrentValueFromSnapshots(db, portfolioId)
}

/**
 * Replace (not upsert) the portfolio's entire value_snapshots history with a
 * fresh series computed from current transactions. Used by the recalc queue
 * after transaction mutations. Unlike `runBackfill`, stale rows are DELETEd
 * (even days that no longer carry value), and an empty history (all BUY/SELL
 * removed) clears the chart entirely. Honors `signal`: an aborted pass throws
 * RecalcAbortedError and never writes a partial series; the queue restarts.
 */
export async function recalcPortfolioHistory(
  db: DB,
  portfolioId: string,
  authToken: string,
  now = new Date(),
  signal?: AbortSignal,
): Promise<void> {
  await setBackfillStatus(db, portfolioId, "pending")
  try {
    const batch = await computeSnapshotBatch(db, portfolioId, authToken, now, signal)
    throwIfAborted(signal)
    // §63.10 — this path DELETEs before it writes, so an unusable pass would not
    // just mis-value the chart, it would erase the history and rebuild it as
    // cash-only. Refuse before the transaction opens.
    if (isUnpriceable(batch)) throw new UnpriceablePortfolioError(portfolioId, batch.heldSymbols)

    await db.transaction(async (tx) => {
      await tx.delete(valueSnapshots).where(eq(valueSnapshots.portfolioId, portfolioId))
      // §63.8 — record the held-but-unpriced symbols atomically with the
      // delete+rebuild so the value is never presented without its gap flag.
      await persistGapSymbols(tx, portfolioId, batch.gapSymbols, batch.heldGapSymbols, fxCoverageCounts(batch.fxCoverageHoles))
      if (batch.rows.length > 0) {
        const CHUNK = 100
        for (let i = 0; i < batch.rows.length; i += CHUNK) {
          await tx.insert(valueSnapshots).values(batch.rows.slice(i, i + CHUNK))
        }
      }
    })

    throwIfAborted(signal)
    // §72.6 — a rebuild must leave the portfolio PRICED, not merely charted.
    //
    // The batch above is computed from price BARS, so it never reads
    // `positions.market_value`. That made a rebuild look complete while the live
    // headline stayed wrong: after the 2026-09-28 wipe every portfolio had a full
    // 18,488-row history and 99 of 99 open positions still had `market_value` NULL,
    // so the headline excluded all of them and warned "96 positions could not be
    // priced". Two paths answer "what is this worth" and, after an import, only
    // one of them had a writer — `refreshQuotes` fires on the 13:00/17:20 sweeps
    // and on any transaction mutation, and an import triggers neither. (It used
    // to also fire on portfolio-open; D58 removed that, and this comment outlived
    // the change.)
    //
    // This is §70's shape one level up: two code paths answering the same
    // question, and the one that is not maintained is the one the user sees.
    //
    // Ordering is load-bearing and NOT cosmetic:
    //   - it must run AFTER the DELETE+rebuild above, because that transaction
    //     removes every snapshot for the portfolio; refreshing first would have
    //     its today-row deleted underneath it.
    //   - it must run BEFORE `syncCurrentValueFromSnapshots`, or `current_value`
    //     is synced from yesterday while the positions carry today's prices.
    //
    // `refreshQuotesUnlocked` upserts today's snapshot itself (snapshot-on-read) and never
    // throws, so this cannot fail a pass — a portfolio that cannot be priced ends
    // up marked `fallback`, which is visible, rather than absent.
    //
    // The price is then fresh for STALE_MS (15 min), so the next portfolio-open
    // skips the per-position instruments fetch entirely — which is why this is
    // slower now and faster afterwards rather than just slower.
    const [owner] = await db
      .select({ userId: portfolios.userId })
      .from(portfolios)
      .where(eq(portfolios.id, portfolioId))
      .limit(1)
    if (owner) {
      await refreshQuotesUnlocked(db, owner.userId, portfolioId, authToken)
      throwIfAborted(signal)
    }

    await recomputeReturnColumns(db, portfolioId)
    // §53.5 — keep portfolios.current_value in step (0 when history cleared)
    await syncCurrentValueFromSnapshots(db, portfolioId)
    await setBackfillStatus(db, portfolioId, "complete", { completedAt: new Date() })
  } catch (err) {
    // An aborted pass must stay silent: the queue restarts with the latest data.
    if (err instanceof RecalcAbortedError) return
    const msg = err instanceof Error ? err.message : String(err)
    // §63.1 — the recompute route is fire-and-forget, so this is the ONLY place
    // a pass failure is observable. Log it (never swallow silently).
    console.error(
      `[recalc] portfolio ${portfolioId} failed: ${msg}\n${err instanceof Error ? err.stack : ""}`,
    )
    await setBackfillStatus(db, portfolioId, "failed", { errorMessage: msg }).catch((e) =>
      console.error(`[recalc] portfolio ${portfolioId} failed to persist status:`, e),
    )
  }
}

/**
 * §76.3 — the ADDITIVE re-value pass, with the pricing tail.
 *
 * `recalcPortfolioHistory` (force) and this are the same computation with one
 * difference: force `DELETE`s every snapshot row for the portfolio and rebuilds,
 * this writes over the top. Both end by pricing positions and syncing
 * `current_value`, so both leave the portfolio in the same state.
 *
 * Why the additive one now backs the mutation queue:
 *
 *   A single position edit used to run TWO passes. The route called
 *   `refreshQuotes` (pricing + today's snapshot, awaited, so the 201 could
 *   return a live price), then `notifyTransactionsChanged` armed a 3s timer
 *   that ran `recalcPortfolioHistory` — which ends with `refreshQuotesUnlocked`
 *   anyway. So the second pass re-did the first pass's work, and between them
 *   deleted and rewrote ~1,661 snapshot rows on the IBKR portfolio to add one
 *   position.
 *
 *   The destructive half bought almost nothing: `computeSnapshotBatch` already
 *   recomputes every day from the earliest BUY/SELL trade through today using
 *   current data, so upsert *corrects* historical values rather than leaving
 *   them stale. What only force can do is drop rows that no longer belong to
 *   the window at all — i.e. after the earliest trade is deleted, or a
 *   wipe-and-reimport. That is a deliberate, rare, whole-history operation, and
 *   it already has its own path: `POST /:id/recompute` with no `mode`, which is
 *   what §63.6's re-import uses. A user adding one position is not that.
 *
 * The pricing tail is NOT optional here and is kept for §70's reason: the bulk
 * import (`routes/import.ts`) triggers neither `refreshQuotes` nor
 * portfolio-open, so if this pass did not price, an import would leave every
 * open position with a NULL `market_value` — the exact failure §70 records,
 * where a full 18,488-row history sat beside 99 unpriced positions and the
 * headline quietly understated net worth.
 *
 * Honors `signal` like every other pass, so an aborted pass writes nothing and
 * the queue restarts with the latest state.
 */
export function recalcPortfolioSeries(
  db: DB,
  portfolioId: string,
  authToken: string,
  now = new Date(),
  signal?: AbortSignal,
): Promise<void> {
  const today = now.toISOString().slice(0, 10)
  return runBackfillCore(db, portfolioId, authToken, now, signal, today).then(async () => {
    // The upsert already synced current_value from the newest snapshot; price the
    // positions after it so today's snapshot carries today's quote, matching the
    // ordering recalcPortfolioHistory documents as load-bearing.
    const [owner] = await db
      .select({ userId: portfolios.userId })
      .from(portfolios)
      .where(eq(portfolios.id, portfolioId))
      .limit(1)
    if (!owner) return
    await refreshQuotesUnlocked(db, owner.userId, portfolioId, authToken)
    throwIfAborted(signal)
    await recomputeReturnColumns(db, portfolioId)
    await syncCurrentValueFromSnapshots(db, portfolioId)
  })
}
