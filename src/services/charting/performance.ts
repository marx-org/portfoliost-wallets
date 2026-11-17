import { and, gte, inArray, lte } from "drizzle-orm"
import type { DB } from "../../db/index.js"
import { chartEventFacts, positionLabels } from "../../db/schema.js"
import { getScopedDailySeries, publishedFactsCondition, type PublishedGeneration } from "./queries.js"

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