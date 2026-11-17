import { and, eq, gte, inArray, lte, sql } from "drizzle-orm"
import type { DB } from "../../db/index.js"
import { chartEventFacts, chartPositionDaily, positionLabels, portfolios } from "../../db/schema.js"
import { getScopedDailySeries, publishedFactsCondition, type PublishedGeneration } from "./queries.js"
import { resolvedFxRate } from "../instruments-fx.js"
import { buildBenchmarkSeries } from "../backfill.js"
import { buildTwr } from "../returnColumns.js"

/**
 * Scoped performance series (feature #253, sub-issue #272).
 *
 * One row per day with the absolute portfolio `value`, the remaining `capital
 * basis`, the cumulative external net contributions (`invested`) and the
 * cumulative received income (dividends + interest) and option receipts. The
 * income/capital overlays are informative components — they are NOT added to
 * `value`, which already includes them. This is the same scoped query the
 * Charting → Performance page and the portfolio Performance tab share; it reads
 * published facts and never replays trades or rebuilds prices.
 */

export interface ScopedPerformancePoint {
  date: string
  value: number
  capitalBasis: number
  /** Cumulative external net contributions (deposits − withdrawals). */
  invested: number
  /** Cumulative dividends + interest received. */
  cumulativeIncome: number
  /** Cumulative option receipts. */
  cumulativeOptions: number
}

export interface ScopedPerformance {
  generation: number
  points: ScopedPerformancePoint[]
}

function round(n: number): number {
  return Math.round(n * 1e8) / 1e8
}

export async function getScopedPerformance(
  db: DB,
  published: PublishedGeneration[],
  opts: { from?: string | null; to?: string | null; labelIds?: string[] } = {},
): Promise<ScopedPerformance> {
  const labelIds = opts.labelIds ?? []
  const daily = await getScopedDailySeries(db, published, opts.from, opts.to, labelIds)
  if (daily.points.length === 0) return { generation: daily.generation, points: [] }

  const conds = [publishedFactsCondition(chartEventFacts.portfolioId, chartEventFacts.generation, published)]
  if (opts.from) conds.push(gte(chartEventFacts.eventDate, opts.from))
  if (opts.to) conds.push(lte(chartEventFacts.eventDate, opts.to))
  if (labelIds.length > 0) {
    const labelled = db
      .select({ id: positionLabels.positionId })
      .from(positionLabels)
      .where(inArray(positionLabels.labelId, labelIds))
    conds.push(inArray(chartEventFacts.positionId, labelled))
  }

  const rows = await db
    .select({
      date: chartEventFacts.eventDate,
      kind: chartEventFacts.receiptKind,
      amount: chartEventFacts.amountBase,
    })
    .from(chartEventFacts)
    .where(and(...conds))

  interface Totals {
    income: number
    options: number
    invested: number
  }
  const byDate = new Map<string, Totals>()
  for (const r of rows) {
    const amount = Number(r.amount)
    if (!Number.isFinite(amount)) continue
    const t = byDate.get(r.date) ?? { income: 0, options: 0, invested: 0 }
    if (r.kind === "dividend" || r.kind === "interest") t.income += amount
    else if (r.kind === "option") t.options += amount
    else if (r.kind === "contribution") t.invested += Math.abs(amount)
    else if (r.kind === "withdrawal") t.invested -= Math.abs(amount)
    byDate.set(r.date, t)
  }

  // Cumulative totals at every date that matters (daily facts + event dates), so
  // an event on a non-fact day still shows up on the next chart point.
  const dates = [...new Set([...daily.points.map((p) => p.date), ...byDate.keys()])].sort()
  let income = 0
  let options = 0
  let invested = 0
  const cumulative = new Map<string, Totals>()
  for (const d of dates) {
    const t = byDate.get(d)
    if (t) {
      income += t.income
      options += t.options
      invested += t.invested
    }
    cumulative.set(d, { income, options, invested })
  }

  return {
    generation: daily.generation,
    points: daily.points.map((p) => {
      const c = cumulative.get(p.date) ?? { income: 0, options: 0, invested: 0 }
      return {
        date: p.date,
        value: p.value,
        capitalBasis: p.remainingBasis,
        invested: round(c.invested),
        cumulativeIncome: round(c.income),
        cumulativeOptions: round(c.options),
      }
    }),
  }
}
/**
 * Flow-mirrored benchmark series for the scoped accounts (feature #253,
 * sub-issue #273).
 *
 * Reuses the SAME engine as the portfolio analytics overlay
 * (`buildBenchmarkSeries`): the scoped accounts' external cash flows are
 * aggregated per day, the scope's starting value seeds the mirror, and each
 * requested symbol is mirrored into that flow schedule. No new pricing source
 * and no second benchmark engine. A symbol with no price history is omitted
 * (a coverage gap), never a flat/zero line.
 */

export interface BenchmarkSeries {
  symbol: string
  name: string
  /** Flow-mirrored absolute values (same currency as the portfolio line). */
  absoluteTimeSeries: Array<{ date: string; value: number }>
  /** Indexed values (first point = 100). */
  timeSeries: Array<{ date: string; value: number }>
  returnPercent: number
  volatility: number
}

export async function getScopedBenchmarkSeries(
  db: DB,
  published: PublishedGeneration[],
  opts: {
    from: string
    to: string
    baseCurrency: string
    authToken: string | null
    symbols: string[]
    labelIds?: string[]
  },
): Promise<BenchmarkSeries[]> {
  if (published.length === 0 || opts.symbols.length === 0) return []
  const labelIds = opts.labelIds ?? []
  const base = opts.baseCurrency.toUpperCase()

  const convert = async (from: string, amount: number): Promise<number | null> => {
    const f = (from || "").toUpperCase()
    if (!f) return null
    if (f === base) return amount
    const r = await resolvedFxRate(opts.authToken, f, base)
    return r ? amount * r.rate : null
  }

  const scopeCondition = publishedFactsCondition(chartEventFacts.portfolioId, chartEventFacts.generation, published)
  const positionScope = publishedFactsCondition(chartPositionDaily.portfolioId, chartPositionDaily.generation, published)
  const flowConds = [
    scopeCondition,
    gte(chartEventFacts.eventDate, opts.from),
    lte(chartEventFacts.eventDate, opts.to),
    inArray(chartEventFacts.receiptKind, ["contribution", "withdrawal"]),
  ]
  if (labelIds.length > 0) {
    const labelled = db
      .select({ id: positionLabels.positionId })
      .from(positionLabels)
      .where(inArray(positionLabels.labelId, labelIds))
    flowConds.push(inArray(chartEventFacts.positionId, labelled))
  }
  const flowRows = await db
    .select({
      date: chartEventFacts.eventDate,
      kind: chartEventFacts.receiptKind,
      amount: chartEventFacts.amountBase,
      baseCurrency: portfolios.baseCurrency,
    })
    .from(chartEventFacts)
    .innerJoin(portfolios, eq(portfolios.id, chartEventFacts.portfolioId))
    .where(and(...flowConds))

  const flows = new Map<string, number>()
  for (const r of flowRows) {
    const amount = Number(r.amount)
    if (!Number.isFinite(amount)) continue
    const converted = await convert(r.baseCurrency || "", Math.abs(amount))
    if (converted == null) continue
    const delta = r.kind === "contribution" ? converted : -converted
    flows.set(r.date, (flows.get(r.date) ?? 0) + delta)
  }

  // Seed = the scoped portfolio value at the first visible day, converted into
  // the display currency (per account base, then summed).
  const daily = await getScopedDailySeries(db, published, opts.from, opts.to, labelIds)
  const firstDay = daily.points[0]?.date
  let seedValue = 0
  if (firstDay) {
    const seedRows = await db
      .select({
        baseCurrency: portfolios.baseCurrency,
        value: sql<string>`coalesce(sum(${chartPositionDaily.value}), 0)`,
      })
      .from(chartPositionDaily)
      .innerJoin(portfolios, eq(portfolios.id, chartPositionDaily.portfolioId))
      .where(and(positionScope, eq(chartPositionDaily.day, firstDay)))
      .groupBy(portfolios.id, portfolios.baseCurrency)
    for (const r of seedRows) {
      const converted = await convert(r.baseCurrency || "", Number(r.value))
      if (converted != null) seedValue += converted
    }
  }

  const out: BenchmarkSeries[] = []
  for (const symbol of opts.symbols) {
    try {
      const series = await buildBenchmarkSeries(symbol, opts.from, opts.to, opts.authToken ?? "", symbol, {
        db,
        baseCurrency: base,
        flows,
        seedValue,
        calcType: "timeWeighted",
      })
      if (!series) continue
      out.push({
        symbol: series.symbol,
        name: series.name,
        absoluteTimeSeries: series.absoluteTimeSeries,
        timeSeries: series.timeSeries,
        returnPercent: series.returnPercent,
        volatility: series.volatility,
      })
    } catch {
      // No price history / instruments unavailable: a coverage gap, not a 500
      // and never a fabricated flat benchmark line.
    }
  }
  return out
}

/**
 * Quarterly returns (feature #253, sub-issue #274).
 *
 * Two modes on the SAME quarter boundaries, from the scoped value/capital series:
 *   - `twr`: index-chained time-weighted return between quarter boundaries
 *     (flow-neutral, so a deposit is not a market gain).
 *   - `netGainChange`: the sheet-style `100 * ((Vq − Cq) − (Vprev − Cprev)) / Vq`,
 *     where `C` is cumulative EXTERNAL NET CONTRIBUTIONS — not remaining cost
 *     basis. A zero/unknown denominator is `null`, never 0 or infinity.
 * The first quarter is measured from the first visible point (or flagged
 * partial), and the current calendar quarter is always partial.
 */

export interface QuarterlyReturnPoint {
  quarter: string
  endingValue: number
  cumulativeNetContributions: number
  twr: number | null
  netGainChange: number | null
  partial: boolean
}

function quarterOf(date: string): { key: string; year: number; q: number; start: string } {
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  const q = Math.floor((month - 1) / 3) + 1
  return { key: `${year}-Q${q}`, year, q, start: `${year}-${String((q - 1) * 3 + 1).padStart(2, "0")}-01` }
}

export function quarterlyReturns(series: ScopedPerformancePoint[], now: Date = new Date()): QuarterlyReturnPoint[] {
  if (series.length === 0) return []

  // Flow-neutral index over the whole series; daily flows are the change in
  // cumulative external net contributions (invested).
  const values = series.map((p) => p.value)
  const flows = series.map((p, i) => (i === 0 ? 0 : p.invested - series[i - 1].invested))
  const twrIndex = buildTwr(values, flows)

  const groups = new Map<string, { endingValue: number; invested: number; twrIndex: number; partial: boolean }>()
  for (let i = 0; i < series.length; i++) {
    const p = series[i]
    const { key } = quarterOf(p.date)
    groups.set(key, {
      endingValue: p.value,
      invested: p.invested,
      twrIndex: twrIndex[i] ?? 1,
      partial: false,
    })
  }

  const quarters = [...groups.keys()].sort()
  const current = quarterOf(new Date().toISOString().slice(0, 10)).key
  const firstKey = quarters[0]
  const firstStart = quarterOf(series[0].date).start
  const firstPartial = series[0].date > firstStart

  return quarters.map((q, idx) => {
    const g = groups.get(q)!
    const prev = idx > 0 ? groups.get(quarters[idx - 1]) : undefined
    const prevValue = prev?.endingValue ?? series[0].value
    const prevInvested = prev?.invested ?? series[0].invested
    // buildTwr's index is in percent (first point = 100), so the first quarter's
    // base is the first index, not 1.
    const prevIndex = prev?.twrIndex ?? twrIndex[0] ?? 100

    const twr =
      Number.isFinite(g.twrIndex) && prevIndex !== 0 ? round((g.twrIndex / prevIndex - 1) * 100) : null
    const denominator = g.endingValue
    const netGainChange =
      denominator !== 0
        ? round(100 * ((g.endingValue - g.invested) - (prevValue - prevInvested)) / denominator)
        : null

    return {
      quarter: q,
      endingValue: round(g.endingValue),
      cumulativeNetContributions: round(g.invested),
      twr,
      netGainChange,
      partial: q === current || (q === firstKey && firstPartial),
    }
  })
}
