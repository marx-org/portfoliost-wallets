/**
 * mergedAnalytics.ts — combined all-portfolios value series (§46, plan §41
 * follow-up 1).
 *
 * Each portfolio's `value_snapshots` rows are denominated in that portfolio's
 * `base_currency`. The merged series sums every portfolio's value/invested on
 * each snapshot date into a SINGLE target currency (USD, the currency the SPA
 * assumes for the combined chart via `total-metrics.baseCurrency`), converting
 * per portfolio with the shared EUR-based latest-rates table
 * (`@marx2/contracts/fx`). A row whose rate is unavailable is skipped — never
 * fabricate a 1:1 rate for an unknown currency.
 */

import { convert } from "@marx2/contracts/fx"

export interface SnapshotRow {
  baseCurrency: string | null
  snapshotDate: string
  value: number
  invested: number
}

export interface MergedPoint {
  date: string
  value: number
  invested: number
}

/**
 * Group snapshot rows by date, convert each row from its portfolio's base
 * currency into `target`, and sum value/invested. Rows that cannot be
 * converted (no rate for either side) are skipped. Ascending by date.
 */
export function sumSnapshotsByDate(
  rows: SnapshotRow[],
  rates: Record<string, number> | null,
  target: string,
): MergedPoint[] {
  const to = target.toUpperCase()
  const byDate = new Map<string, MergedPoint>()
  for (const row of rows) {
    const from = (row.baseCurrency ?? to).toUpperCase()
    const value = convert(Number(row.value), from, to, rates ?? {})
    if (value === undefined) continue
    const invested = convert(Number(row.invested), from, to, rates ?? {})
    if (invested === undefined) continue
    const acc = byDate.get(row.snapshotDate) ?? { date: row.snapshotDate, value: 0, invested: 0 }
    acc.value += value
    acc.invested += invested
    byDate.set(row.snapshotDate, acc)
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Build the `PortfolioAnalytics.performance` shape from the summed series,
 * mirroring `/portfolios/:id/analytics` scalars (last-point based). The merged
 * chart plots `value` only, so the TWR/MWR/simple scalar return fields are
 * left null and monthlyReturns is empty.
 */
export function buildMergedPerformance(series: MergedPoint[]) {
  const last = series[series.length - 1]
  const totalValue = last?.value ?? 0
  const totalInvested = last?.invested ?? 0
  const totalReturn = totalValue - totalInvested
  const totalReturnPercent = totalInvested > 0 ? (totalReturn / totalInvested) * 100 : 0
  return {
    timeSeries: series.map((p) => ({ date: p.date, value: p.value })),
    totalValue,
    totalInvested,
    totalReturn,
    totalReturnPercent,
    monthlyReturns: [],
    timeWeightedReturn: null,
    moneyWeightedReturn: null,
    simpleReturnPercent: null,
  }
}