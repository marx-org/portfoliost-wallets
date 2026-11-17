import { and, eq, inArray, sql } from "drizzle-orm"
import type { DB } from "../../db/index.js"
import { chartEventFacts, positionLabels, positions } from "../../db/schema.js"
import { publishedFactsCondition, type PublishedGeneration } from "./queries.js"

/**
 * Monthly dividend-payer coverage for current holdings (feature #253, sub-issue
 * #265).
 *
 * The sheet counted declared payment dates from a per-instrument calendar; this
 * counts RECORDED dividend events already stored in wallets, so there is no
 * provider calendar fetch, no 50-symbol truncation and no missing-calendar
 * unknown state. A month's count is the number of DISTINCT currently-held
 * stocks (canonical symbol + instrument currency) with a recorded dividend in
 * that month — a stock held in two accounts, or paying twice in one month, still
 * counts once. A stock sold before the as-of date is excluded by joining the
 * CURRENT open positions, even though its past dividends remain in the facts.
 *
 * The current calendar month and later months of the current year are marked
 * `partial`: the year is in progress, not a full-year forecast.
 */

export interface PayerCoverageMonth {
  year: number
  /** 1–12. */
  month: number
  /** Distinct currently-held payers with a recorded dividend in the month. */
  count: number
  partial: boolean
}

/** Canonical stock identity: two listings/currencies of one ticker stay distinct. */
function payerKey(symbol: string | null, instrumentCurrency: string | null): string {
  return `${symbol ?? ""}\u0000${instrumentCurrency ?? ""}`
}

export async function monthlyPayerCoverage(
  db: DB,
  userId: string,
  published: PublishedGeneration[],
  opts: { labelIds?: string[] } = {},
): Promise<PayerCoverageMonth[]> {
  if (published.length === 0) return []

  const labelIds = opts.labelIds ?? []
  const conds = [
    publishedFactsCondition(chartEventFacts.portfolioId, chartEventFacts.generation, published),
    eq(chartEventFacts.receiptKind, "dividend"),
    // Current holdings only: a closed position's past dividends do not count.
    eq(positions.isOpen, true),
    eq(positions.userId, userId),
  ]
  if (labelIds.length > 0) {
    // A subquery, not a join: a position carrying two selected labels is read
    // once (overlapping labels intersect, not add).
    const labelled = db
      .select({ id: positionLabels.positionId })
      .from(positionLabels)
      .where(inArray(positionLabels.labelId, labelIds))
    conds.push(inArray(chartEventFacts.positionId, labelled))
  }

  const rows = await db
    .select({
      symbol: positions.symbol,
      instrumentCurrency: positions.instrumentCurrency,
      month: sql<string>`to_char(${chartEventFacts.eventDate}, 'YYYY-MM')`,
    })
    .from(chartEventFacts)
    .innerJoin(positions, eq(positions.id, chartEventFacts.positionId))
    .where(and(...conds))

  const payersByMonth = new Map<string, Set<string>>()
  for (const r of rows) {
    const month = r.month
    if (!month) continue
    let set = payersByMonth.get(month)
    if (!set) {
      set = new Set()
      payersByMonth.set(month, set)
    }
    set.add(payerKey(r.symbol, r.instrumentCurrency))
  }
  if (payersByMonth.size === 0) return []

  const months = [...payersByMonth.keys()].sort()
  const firstYear = Number(months[0].slice(0, 4))
  const lastYear = Number(months[months.length - 1].slice(0, 4))
  const now = new Date()
  const currentYear = now.getUTCFullYear()
  const currentMonth = now.getUTCMonth() + 1

  const out: PayerCoverageMonth[] = []
  for (let year = firstYear; year <= lastYear; year++) {
    for (let month = 1; month <= 12; month++) {
      const key = `${year}-${String(month).padStart(2, "0")}`
      const count = payersByMonth.get(key)?.size ?? 0
      out.push({
        year,
        month,
        count,
        partial: year === currentYear && month >= currentMonth,
      })
    }
  }
  return out
}