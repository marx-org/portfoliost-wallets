/**
 * Income (dividends) aggregation for the analytics payloads.
 *
 * Income is a flow, not a snapshot, so it is summed from the transaction rows
 * over the window rather than read off a value_snapshots column. A DIVIDEND row's
 * `total_amount` is already NET (gross − withholding tax); `converted_total_amount`
 * is that net in the owning portfolio's base currency, with fallbacks for rows
 * written before the column existed.
 *
 * Interest is not modelled as a transaction type today (POSITION_TX_TYPES has no
 * INTEREST); when it is, add it to the type filter below.
 */

import { and, eq, gte, inArray, lt } from "drizzle-orm"
import type { DB } from "../db/index.js"
import { portfolioTransactions } from "../db/schema.js"

const INCOME_TYPES = ["DIVIDEND"] as const

export interface IncomeRow {
  portfolioId: string
  totalAmount: number | string
  exchangeRate: number | string | null
  convertedTotalAmount: number | string | null
}

/** Net income of one transaction, in the owning portfolio's base currency. */
export function rowIncomeNative(r: IncomeRow): number {
  if (r.convertedTotalAmount != null) return Number(r.convertedTotalAmount)
  const total = Number(r.totalAmount)
  return r.exchangeRate != null ? total * Number(r.exchangeRate) : total
}

/**
 * Sum net income over rows, converting each row from its portfolio base into
 * `target` via `rateFor` (a missing rate degrades to 1:1, matching the chart's
 * constant-currency caveat). Rounded to cents.
 */
export function sumIncome(
  rows: IncomeRow[],
  baseOf: (portfolioId: string) => string,
  rateFor: (from: string) => number | null,
  target: string,
): number {
  const to = target.toUpperCase()
  let sum = 0
  for (const r of rows) {
    const base = (baseOf(r.portfolioId) ?? to).toUpperCase()
    const rate = base === to ? 1 : rateFor(base) ?? 1
    sum += rowIncomeNative(r) * rate
  }
  return Math.round(sum * 100) / 100
}

/** Load DIVIDEND + INTEREST rows for the portfolios within [from, to] (date, inclusive). */
export async function loadIncome(
  db: DB,
  userId: string,
  portfolioIds: string[],
  from: string | undefined,
  to: string | undefined,
): Promise<IncomeRow[]> {
  if (portfolioIds.length === 0 || !from || !to) return []
  const toExclusive = new Date(Date.parse(`${to}T00:00:00Z`) + 86400000).toISOString().slice(0, 10)
  return db
    .select({
      portfolioId: portfolioTransactions.portfolioId,
      totalAmount: portfolioTransactions.totalAmount,
      exchangeRate: portfolioTransactions.exchangeRate,
      convertedTotalAmount: portfolioTransactions.convertedTotalAmount,
    })
    .from(portfolioTransactions)
    .where(
      and(
        eq(portfolioTransactions.userId, userId),
        inArray(portfolioTransactions.portfolioId, portfolioIds),
        inArray(portfolioTransactions.type, [...INCOME_TYPES]),
        gte(portfolioTransactions.executedAt, new Date(`${from}T00:00:00Z`)),
        lt(portfolioTransactions.executedAt, new Date(`${toExclusive}T00:00:00Z`)),
      ),
    )
}