/**
 * mergedAnalytics.ts — combined all-portfolios value series (§46, plan §41
 * follow-up 1).
 *
 * Each portfolio's `value_snapshots` rows are denominated in that portfolio's
 * `base_currency`. The merged series sums every portfolio's value/invested on
 * each snapshot date into a SINGLE target currency (USD, the currency the SPA
 * assumes for the combined chart via `total-metrics.baseCurrency`).
 *
 * Rates are resolved upstream via instruments' fx_rates (plan §48.3) and
 * handed in as a from→target cross-rate callback. A row whose rate is
 * unavailable is skipped — never fabricate a 1:1 rate for an unknown currency.
 */

export interface SnapshotRow {
  /** Present when the caller groups per portfolio (forward-fill); the naive
   * per-date sum ignores it. */
  portfolioId?: string
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
 * currency into `target`, and sum value/invested. `rateFor(from)` returns the
 * from→target cross rate (resolved upstream, D27) or null; the identity
 * (from === target) needs no rate. Rows that cannot be converted are skipped.
 * Ascending by date.
 */
export function sumSnapshotsByDate(
  rows: SnapshotRow[],
  rateFor: (from: string) => number | null,
  target: string,
): MergedPoint[] {
  const to = target.toUpperCase()
  const byDate = new Map<string, MergedPoint>()
  for (const row of rows) {
    const from = (row.baseCurrency ?? to).toUpperCase()
    const rate = from === to ? 1 : rateFor(from)
    if (rate == null) continue
    const value = Number(row.value) * rate
    const invested = Number(row.invested) * rate
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
/**
 * Same as {@link sumSnapshotsByDate}, but each portfolio's value is
 * forward-filled: on a date where the portfolio has no snapshot, it carries
 * its latest earlier value instead of contributing 0.
 *
 * Why: today's snapshot is written lazily (snapshot-on-read / recompute), so
 * early in the day only the portfolios the user opened have a "today" row.
 * A naive per-date sum then collapses the combined total to just those
 * portfolios (the "sudden drop at the head of the composed chart"). A
 * portfolio's value is a step function — it does not vanish on days nobody
 * opened it — so the combined series sums each portfolio's last-known value
 * as of each date. Historical (complete) dates are unaffected: every
 * portfolio already has a row there, so forward-fill is a no-op.
 *
 * Portfolios whose first snapshot is *after* a given date contribute 0 on
 * that date (nothing to carry from the past — the combined total ramps up as
 * each portfolio's history begins, matching the naive sum).
 */
export function sumSnapshotsByDateForwardFilled(
  rows: SnapshotRow[],
  rateFor: (from: string) => number | null,
  target: string,
): MergedPoint[] {
  const to = target.toUpperCase()
  const rateCache = new Map<string, number | null>()
  const rateOf = (from: string): number | null => {
    const f = (from ?? to).toUpperCase()
    if (f === to) return 1
    if (!rateCache.has(f)) rateCache.set(f, rateFor(f))
    return rateCache.get(f) ?? null
  }

  const sorted = [...rows].sort(
    (a, b) =>
      (a.portfolioId ?? "").localeCompare(b.portfolioId ?? "") ||
      a.snapshotDate.localeCompare(b.snapshotDate),
  )

  // Per-portfolio series (converted into `target`), kept sorted by date so
  // each date can walk its pointer forward.
  const perPfSeries = new Map<string, { date: string; value: number; invested: number }[]>()
  for (const row of sorted) {
    const rate = rateOf(row.baseCurrency ?? to)
    if (rate == null) continue
    const pf = row.portfolioId ?? ""
    const arr = perPfSeries.get(pf) ?? []
    perPfSeries.set(pf, arr)
    arr.push({
      date: row.snapshotDate,
      value: Number(row.value) * rate,
      invested: Number(row.invested) * rate,
    })
  }

  // Materialize: for each date in the union of snapshot dates, sum each
  // portfolio's latest value at or before that date (portfolios whose first
  // snapshot is later contribute 0 — nothing to carry from the past).
  const dates = [...new Set(rows.map((r) => r.snapshotDate))].sort()
  const idx = new Map<string, number>()
  for (const pf of perPfSeries.keys()) idx.set(pf, 0)

  const out: MergedPoint[] = []
  for (const date of dates) {
    let value = 0
    let invested = 0
    let any = false
    for (const [pf, series] of perPfSeries) {
      let i = idx.get(pf)!
      while (i < series.length - 1 && series[i + 1].date <= date) i++
      idx.set(pf, i)
      if (series[i].date <= date) {
        value += series[i].value
        invested += series[i].invested
        any = true
      }
    }
    if (any) out.push({ date, value, invested })
  }
  return out
}

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
    simpleReturnPercent: undefined,
  }
}