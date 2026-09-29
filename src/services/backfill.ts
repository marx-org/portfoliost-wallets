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
): Promise<PriceBarSeries | null> {
  const base = instrumentsBase()
  if (!base) throw new InstrumentsUnavailableError(null, "instruments (INSTRUMENTS_URL unset)")
  const q = new URLSearchParams({ from, to })
  if (currency) q.set("currency", currency)
  if (baseCcy) q.set("baseCurrency", baseCcy)
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
 * Max symbols fetched concurrently by one recompute pass (RECALC_PRICE_CONCURRENCY,
 * default 4). A full-import portfolio has 100+ symbols; fetching them all at
 * once (the old Promise.all) multiplied the price_bars_all load by the number
 * of concurrent passes and pegged the node's CPU (2026-09-19 incident). The
 * global runner serializes passes; this caps the per-pass fan-out.
 */
const PRICE_FETCH_CONCURRENCY = Math.max(1, Number(process.env.RECALC_PRICE_CONCURRENCY ?? 4))

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
      let series = await fetcher(symbols[i], from, to, authToken, signal, wantCcy, baseCcy)
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
          symbols[i], from, to, authToken, signal, portfolioBase, baseCcy,
        )
        if (failure !== null) return
        if (converted && converted.dates.length > 0) series = converted
      }

      if (series && series.dates.length > 0) out.set(symbols[i], series)
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

/**
 * Context for cash-flow-mirrored benchmark overlay (D50).
 *
 * The benchmark no longer projects a pure price index: instead it mirrors the
 * portfolio's actual deployment schedule into the benchmark instrument, so a
 * BUY of $X in the portfolio "buys" $X of the benchmark at that day's close and
 * a SELL of $Y "sells" $Y (fractional shares allowed, clamped ≥ 0).
 */
export interface BenchmarkBuildContext {
  db: DB
  portfolioId: string
  baseCurrency: string
  /** daily net cash flow (BUY − SELL) in base currency, keyed by YYYY-MM-DD */
  flows: Map<string, number>
  /** portfolio invested capital at the window start (seeds the mirror) */
  seedInvested: number
  calcType: "moneyWeighted" | "timeWeighted" | "simple"
}

export interface BenchmarkReturn {
  symbol: string
  name: string
  timeSeries: Array<{ date: string; value: number }>
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

  const timeSeries = points.map((p, i) => ({ date: p.date, value: columns[i] }))
  const returnPercent = Math.round((columns[columns.length - 1] - 100) * 100) / 100

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

  return { symbol, name, timeSeries, returnPercent, volatility }
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
    if (c !== undefined && c > 0) priceByDate.set(dates[i], c)
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
export async function getGapSymbols(db: DB, portfolioId: string): Promise<string[] | null> {
  const rows = await db
    .select({ gap: portfolioBackfillMetadata.gapSymbols })
    .from(portfolioBackfillMetadata)
    .where(eq(portfolioBackfillMetadata.portfolioId, portfolioId))
    .limit(1)
  const gap = rows[0]?.gap
  return gap && gap.length > 0 ? gap : null
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
        eq(portfolioTransactions.portfolioId, portfolioId),
        sql`${portfolioTransactions.type} in ('BUY','SELL')`,
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
}

/**
 * Result of {@link computeSnapshotBatch}: the per-day snapshot rows plus the
 * held-but-unpriced symbols (no price bar in the window) that were dropped from
 * every day's value. `gapSymbols.length > 0` means the stored value is a
 * **partial** sum (§63.8).
 */
export interface SnapshotBatch {
  rows: SnapshotRow[]
  gapSymbols: string[]
  /**
   * §63.10 — held symbols the pass was asked to price (qty > 0 on the window's
   * last day). `gapSymbols.length === heldSymbols` means the pass priced *nothing*,
   * which is never a legitimate result: it is what a transport/auth failure looks
   * like once it has been collapsed into "no data". A genuinely all-cash
   * portfolio has `heldSymbols === 0` and is unaffected.
   */
  heldSymbols: number
}

/** No history to backfill (no BUY/SELL or cash yet) — shared by every guard. */
const EMPTY_BATCH: SnapshotBatch = { rows: [], gapSymbols: [], heldSymbols: 0 }

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

export function isUnpriceable(batch: SnapshotBatch): boolean {
  return batch.heldSymbols > 0 && batch.gapSymbols.length >= batch.heldSymbols
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
): Promise<void> {
  // Empty = every held symbol priced → store NULL ("no gap") rather than [] so
  // consumers can treat null as the clean state.
  const gap = gapSymbols && gapSymbols.length > 0 ? gapSymbols : null
  await db
    .insert(portfolioBackfillMetadata)
    .values({ portfolioId, status: "pending", gapSymbols: gap })
    .onConflictDoUpdate({
      target: portfolioBackfillMetadata.portfolioId,
      set: { gapSymbols: gap },
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
        eq(portfolioTransactions.portfolioId, portfolioId),
        sql`${portfolioTransactions.type} in ('BUY','SELL')`,
      ),
    )
  const [pfRow] = await db
    .select({ baseCurrency: portfolios.baseCurrency })
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
      executedAt: portfolioTransactions.executedAt,
      instrumentCurrency: portfolioTransactions.instrumentCurrency,
      externalId: portfolioTransactions.externalId,
    })
    .from(portfolioTransactions)
    .where(
      and(
        eq(portfolioTransactions.portfolioId, portfolioId),
        sql`${portfolioTransactions.type} in ('BUY','SELL')`,
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
        eq(portfolioTransactions.portfolioId, portfolioId),
        eq(portfolioTransactions.type, "EXPIRATION"),
      ),
    )
  for (const r of expRows) {
    if (r.externalId) optionLegIds.add(r.externalId.replace(/#e$/, ""))
  }

  // 3. Build cumulative qty_held per symbol per day.
  //    For each symbol: sorted list of (date, deltaQty) then accumulated.
  type QtyEvent = { date: string; delta: number }
  const symbolEvents = new Map<string, QtyEvent[]>()
  for (const tx of txRows) {
    if (!tx.symbol) continue
      if (tx.type === "SELL" && tx.externalId && optionLegIds.has(tx.externalId)) continue
      const delta =
        tx.type === "BUY" ? Number(tx.quantity) : -Number(tx.quantity)
      const date = toDateStr(tx.executedAt) ?? ""
      if (!date) continue
    const arr = symbolEvents.get(tx.symbol) ?? []
    arr.push({ date, delta })
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
  for (const [sym, events] of symbolEvents) {
    const sorted = events.slice().sort((a, b) => a.date.localeCompare(b.date))
    const dayQty = new Map<string, number>()
    let cum = 0
    let ei = 0
    for (const day of days) {
      while (ei < sorted.length && sorted[ei].date <= day) {
        cum += sorted[ei].delta
        ei++
      }
      dayQty.set(day, Math.max(0, cum))
    }
    qtyMaps.set(sym, dayQty)
  }

  // §63.10.5 — only ask for symbols this portfolio actually held INSIDE the
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

  // 6. Fetch price series per held symbol from instruments (bounded fan-out —
  //    see fetchPriceSeries; an aborted signal rejects promptly). A
  //    cash-only portfolio has no symbols to price.
  // §63.10.5 — the known instrument currency travels with the request, so a
  // symbol instruments cannot resolve on its own is still convertible.
  const declaredBase = new Map<string, string | null>()
  for (const [sym, ccy] of symbolCcy) {
    declaredBase.set(sym, ccy && KNOWN_CURRENCY.test(ccy) ? ccy.toUpperCase() : null)
  }
  const priceSeries = symbols.length
    ? await fetchPriceSeries(symbols, from, to, authToken, fetchPriceBars, signal, targetCcy, declaredBase, base)
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

  // Pre-build carry-forward price maps per symbol
  const priceMaps = new Map<string, Map<string, number>>()
  for (const sym of symbols) {
    const series = priceSeries.get(sym)
    if (series) {
      priceMaps.set(sym, buildPriceMap(series.dates, series.closes, days))
    }
  }

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
  const cumulativeFlows = new Map<string, number>()
  for (const day of days) {
    cumulativeFlow += dailyFlows.get(day) ?? 0
    cumulativeFlows.set(day, cumulativeFlow)
  }

  // 7. Build the snapshot batch (RECALC_DEBUG=1 → per-symbol day-0 debug logs)
  const recalcDebug = process.env.RECALC_DEBUG === "1"
  const snapBatch: SnapshotRow[] = []

  // §63.8 — a held symbol (qty > 0 on the window's last day) with NO price bar
  // for the window is *dropped* from every day's value, so the stored series
  // is a partial sum. Surface those symbols so the caller can flag the value as
  // incomplete instead of silently under-reporting (the IKE Beata spike: 18/23
  // symbols priced → 155k vs true 205k).
  const lastDay = days[days.length - 1]
  const gapSymbols: string[] = []
  let heldCount = 0
  for (const sym of symbols) {
    if ((qtyMaps.get(sym)?.get(lastDay) ?? 0) <= 0) continue
    heldCount += 1
    if (!priceMaps.get(sym) || !priceMaps.get(sym)!.has(lastDay)) gapSymbols.push(sym)
  }

  for (const day of days) {
    let totalValue = 0
    let totalInvested = 0
    for (const sym of symbols) {
      const qty = qtyMaps.get(sym)?.get(day) ?? 0
      if (qty <= 0) continue
      const price = priceMaps.get(sym)?.get(day)
      if (price == null) continue
      // plan §48.3 — the close is already in the portfolio base currency
      // (server-side conversion); the value path is qty × close.
      totalValue += qty * price
      if (recalcDebug && day === days[days.length - 1]) {
        console.log(
          `[recalc-debug] pf=${portfolioId} day=${day} sym=${sym} qty=${qty} close=${price} contrib=${(qty * price).toFixed(2)} base=${base}`,
        )
      }
    }
    // §62.4 — cash is part of the portfolio value (base-currency balance at
    // day's close); `invested` stays the position cost basis so TWR/MWR keep
    // treating cash as external flow (netFlow) rather than invested capital.
    const cashDay = cashSeries.get(day) ?? 0
    totalValue += cashDay
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
        netFlow: (dailyFlows.get(day) ?? 0).toFixed(8),
      })
    }
  }

  return { rows: snapBatch, gapSymbols, heldSymbols: heldCount }
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
  await persistGapSymbols(db, portfolioId, batch.gapSymbols)
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
      await persistGapSymbols(tx, portfolioId, batch.gapSymbols)
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
