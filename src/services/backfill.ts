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
  portfolioTransactions,
  positions,
  valueSnapshots,
} from "../db/schema.js"
import { fxTo, instrumentsBase, resolvedFxRate } from "./instruments-fx.js"
import { dailyNetCashFlows } from "./cashFlows.js"
import { enqueueBackfill } from "./backfill-runner.js"
import {
  recomputeReturnColumns,
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
): Promise<PriceBarSeries | null> {
  const base = instrumentsBase()
  if (!base) return null
  try {
    const url = `${base}/api/instruments/${encodeURIComponent(symbol)}/price-bars?from=${from}&to=${to}${currency ? `&currency=${encodeURIComponent(currency)}` : ""}`
    const res = await fetch(url, { headers: { Authorization: authToken }, signal })
    if (!res.ok) return null
    return (await res.json()) as PriceBarSeries
  } catch {
    return null
  }
}

/**
 * Max symbols fetched concurrently by one recompute pass (RECALC_PRICE_CONCURRENCY,
 * default 4). A full-import portfolio has 100+ symbols; fetching them all at
 * once (the old Promise.all) multiplied the price_bars_all load by the number
 * of concurrent passes and pegged the node's CPU (2026-09-19 incident). The
 * global runner serializes passes; this caps the per-pass fan-out.
 */
const PRICE_FETCH_CONCURRENCY = Math.max(1, Number(process.env.RECALC_PRICE_CONCURRENCY ?? 4))

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
  ) => Promise<PriceBarSeries | null> = fetchPriceBars,
  signal?: AbortSignal,
  targetCcy?: Map<string, string | null>,
): Promise<Map<string, PriceBarSeries>> {
  const out = new Map<string, PriceBarSeries>()
  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      throwIfAborted(signal)
      const i = next++
      if (i >= symbols.length) return
      const series = await fetcher(symbols[i], from, to, authToken, signal, targetCcy?.get(symbols[i] ?? "") ?? undefined)
      if (series && series.dates.length > 0) out.set(symbols[i], series)
    }
  }
  const workers = Math.min(PRICE_FETCH_CONCURRENCY, symbols.length)
  await Promise.all(Array.from({ length: workers }, () => worker()))
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
  const rate = isBaseCcy ? 1 : (await resolvedFxRate(authToken, series.currency!, base))?.rate ?? 1
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
): Promise<void> {
  await setBackfillStatus(db, portfolioId, "pending")
  try {
    await _runBackfillCore(db, portfolioId, authToken, now, signal)
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
 * Recompute the full daily value/invested/netFlow series for one portfolio
 * from its BUY/SELL transactions + instrument price bars (steps 1–7 of the old
 * `_runBackfillCore`). Returns [] when there is no history to backfill (no
 * BUY/SELL transactions, or nothing valued). Honors an optional AbortSignal and
 * throws RecalcAbortedError on abort so the caller never commits a partial
 * series.
 */
export async function computeSnapshotBatch(
  db: DB,
  portfolioId: string,
  authToken: string,
  now = new Date(),
  signal?: AbortSignal,
): Promise<SnapshotRow[]> {
  throwIfAborted(signal)

  // 1. Find firstTxDate
  const minRows = await db
    .select({ minDate: sql<string>`min(${portfolioTransactions.executedAt})` })
    .from(portfolioTransactions)
    .where(
      and(
        eq(portfolioTransactions.portfolioId, portfolioId),
        sql`${portfolioTransactions.type} in ('BUY','SELL')`,
      ),
    )
  const firstTxDate = minRows[0]?.minDate
  if (!firstTxDate) return [] // no transactions yet

  const from = toDateStr(firstTxDate)
  if (!from) return []
  const to = daysAgo(1, now) // yesterday
  if (from > to) return [] // only one day of history, nothing to backfill

  // 2. Fetch all BUY/SELL transactions ordered by date
  const txRows = await db
    .select({
      symbol: portfolioTransactions.instrumentSymbol,
      type: portfolioTransactions.type,
      quantity: portfolioTransactions.quantity,
      executedAt: portfolioTransactions.executedAt,
      instrumentCurrency: portfolioTransactions.instrumentCurrency,
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

  if (txRows.length === 0) return []

  // Collect unique symbols + their instrument currencies (null = unknown,
  // never guessed — plan §45.3)
  const symbolCcy = new Map<string, string | null>()
  for (const tx of txRows) {
    if (tx.symbol) symbolCcy.set(tx.symbol, tx.instrumentCurrency)
  }

  // 3. Build cumulative qty_held per symbol per day.
  //    For each symbol: sorted list of (date, deltaQty) then accumulated.
  type QtyEvent = { date: string; delta: number }
  const symbolEvents = new Map<string, QtyEvent[]>()
  for (const tx of txRows) {
    if (!tx.symbol) continue
      const delta =
        tx.type === "BUY" ? Number(tx.quantity) : -Number(tx.quantity)
      const date = toDateStr(tx.executedAt) ?? ""
      if (!date) continue
    const arr = symbolEvents.get(tx.symbol) ?? []
    arr.push({ date, delta })
    symbolEvents.set(tx.symbol, arr)
  }

  // 4. Portfolio base currency (needed before the price fetch — plan §48.3
  //    converts server-side INTO the base, so the target must be known up front).
  const [portfolio] = await db
    .select({ baseCurrency: portfolios.baseCurrency })
    .from(portfolios)
    .where(eq(portfolios.id, portfolioId))
    .limit(1)
  const base = (portfolio?.baseCurrency ?? "USD").toUpperCase()

  // Per-symbol conversion target: known non-base instrument currencies are
  // converted server-side (?currency=<base>); unknown or already-base
  // currencies stay native. The value path then multiplies qty × close with
  // no FX lookup (the "qty-only" property, plan §48.3).
  const targetCcy = new Map<string, string | null>()
  for (const [sym, ccy] of symbolCcy) {
    targetCcy.set(sym, ccy && ccy.toUpperCase() !== base ? base : null)
  }

  // 5. Fetch price series per symbol from instruments (bounded fan-out —
  //    see fetchPriceSeries; an aborted signal rejects promptly)
  const symbols = [...symbolCcy.keys()]
  const priceSeries = await fetchPriceSeries(symbols, from, to, authToken, fetchPriceBars, signal, targetCcy)
  throwIfAborted(signal)

  // Cost-basis currency conversion for `invested` — a genuine rate-only need
  // (the stored avgCost is denominated in the instrument currency, plan §48.3).
  const toBase = await fxTo(authToken, base)

  // 6. Build daily value series
  const days = calendarDays(from, to)

  // Daily net cash flows (BUY − SELL) in base currency populate netFlow so the
  // portfolio's own TWR/MWR/simple columns are flow-aware (D49/D50).
  const dailyFlows = await dailyNetCashFlows(db, authToken, portfolioId, from, to, base)
  throwIfAborted(signal)

  // Pre-build carry-forward price maps per symbol
  const priceMaps = new Map<string, Map<string, number>>()
  for (const sym of symbols) {
    const series = priceSeries.get(sym)
    if (series) {
      priceMaps.set(sym, buildPriceMap(series.dates, series.closes, days))
    }
  }

  // Pre-build cumulative qty per symbol per day
  // qty_held(sym, day) = sum of deltas where date <= day
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

  // Also need invested = cost basis at each day
  // invested(day) = Σ sym: qty_held(sym,day) × avg_cost(sym,day) × fx
  // avg_cost is harder to track daily; approximate as total_invested from positions
  // For simplicity (matching the plan): invested = Σ qty×avgCost from current positions
  // (static — we upsert value_snapshots.invested as the current total invested each day)
  // A more accurate per-day invested is left for H9 refinement.
  const currentPositions = await db
    .select({
      symbol: positions.symbol,
      averageCostBasis: positions.averageCostBasis,
      instrumentCurrency: positions.instrumentCurrency,
    })
    .from(positions)
    .where(and(eq(positions.portfolioId, portfolioId), eq(positions.isOpen, true)))

  const costPerSymbol = new Map<string, { avg: number; ccy: string }>()
  for (const p of currentPositions) {
    costPerSymbol.set(p.symbol, {
      avg: Number(p.averageCostBasis),
      ccy: p.instrumentCurrency ?? "USD",
    })
  }

  // 7. Build the snapshot batch
  const snapBatch: SnapshotRow[] = []

  for (const day of days) {
    let totalValue = 0
    let totalInvested = 0
    for (const sym of symbols) {
      const qty = qtyMaps.get(sym)?.get(day) ?? 0
      if (qty <= 0) continue
      const price = priceMaps.get(sym)?.get(day)
      if (!price) continue
      // plan §48.3 — the close is already in the portfolio base currency
      // (server-side conversion); the value path is qty × close.
      totalValue += qty * price
      const cost = costPerSymbol.get(sym)
      if (cost) {
        totalInvested += qty * cost.avg * (await toBase(cost.ccy, 1))
      }
    }
    if (totalValue > 0) {
      snapBatch.push({
        portfolioId,
        snapshotDate: day,
        value: totalValue.toFixed(8),
        invested: totalInvested.toFixed(8),
        netFlow: (dailyFlows.get(day) ?? 0).toFixed(8),
      })
    }
  }

  return snapBatch
}

async function _runBackfillCore(
  db: DB,
  portfolioId: string,
  authToken: string,
  now: Date,
  signal?: AbortSignal,
): Promise<void> {
  const batch = await computeSnapshotBatch(db, portfolioId, authToken, now, signal)
  if (batch.length === 0) return

  // Bulk upsert in chunks to avoid huge parameter lists
  const CHUNK = 100
  for (let i = 0; i < batch.length; i += CHUNK) {
    const chunk = batch.slice(i, i + CHUNK)
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

    await db.transaction(async (tx) => {
      await tx.delete(valueSnapshots).where(eq(valueSnapshots.portfolioId, portfolioId))
      if (batch.length > 0) {
        const CHUNK = 100
        for (let i = 0; i < batch.length; i += CHUNK) {
          await tx.insert(valueSnapshots).values(batch.slice(i, i + CHUNK))
        }
      }
    })

    throwIfAborted(signal)
    await recomputeReturnColumns(db, portfolioId)
    await setBackfillStatus(db, portfolioId, "complete", { completedAt: new Date() })
  } catch (err) {
    // An aborted pass must stay silent: the queue restarts with the latest data.
    if (err instanceof RecalcAbortedError) return
    const msg = err instanceof Error ? err.message : String(err)
    await setBackfillStatus(db, portfolioId, "failed", { errorMessage: msg }).catch(() => undefined)
  }
}
