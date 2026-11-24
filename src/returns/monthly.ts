/**
 * Monthly returns — month-over-month growth of the TWR index.
 *
 * §83.2 — moved here from `routes/portfolios.ts`, which is where it was born
 * for `/:id/analytics`. `/merged` needs the same derivation over its aggregate
 * index, and two copies of one month-boundary rule is how the per-portfolio
 * and the cumulative bars end up disagreeing about the same month.
 *
 * Month-over-month growth of the already flow-adjusted TWR index, so a deposit
 * inflating the raw value does not inflate the monthly return. A point with no
 * index is skipped rather than read as 0 — 0 in the index is a −100% day.
 */
export function buildMonthlyReturns(
  series: Array<{ date: string; cumulativeTwr: number | null }>,
): Array<{ month: string; returnPercent: number }> {
  const byMonth = new Map<string, number>()
  for (const { date, cumulativeTwr } of series) {
    const month = date.slice(0, 7)
    if (cumulativeTwr == null) continue
    byMonth.set(month, cumulativeTwr)
  }
  let prevTwr = 100
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, lastTwr]) => {
      const returnPercent = prevTwr > 0 ? Math.round((lastTwr / prevTwr - 1) * 100 * 100) / 100 : 0
      prevTwr = lastTwr
      return { month, returnPercent }
    })
}