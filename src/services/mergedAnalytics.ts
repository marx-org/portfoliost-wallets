/**
 * mergedAnalytics.ts — combined all-portfolios value series (§46, plan §41
 * follow-up 1; aggregate returns §83).
 *
 * Each portfolio's `value_snapshots` rows are denominated in that portfolio's
 * `base_currency`. The merged series sums every portfolio's value/invested on
 * each snapshot date into a SINGLE target currency (the aggregate base
 * /total-metrics reports).
 *
 * Rates are resolved upstream via instruments' fx_rates (plan §48.3) and
 * handed in as a from→target cross-rate callback. A row whose rate is
 * unavailable is skipped — never fabricate a 1:1 rate for an unknown currency.
 *
 * §83.2 — the aggregate's RETURN columns are not a sum of the per-portfolio
 * columns, because a sum of indices is meaningless. They are derived from the
 * summed value series and the summed `net_flow`, through the same
 * `returnColumns.ts` builders the per-portfolio path uses:
 *
 *     HPR_t = (ΣV)ₜ / ((ΣV)ₜ₋₁ + ΣFₜ) − 1
 *
 * which is the aggregate's own daily return. No per-portfolio weighting is
 * applied, because none is needed: the aggregate IS the sum, and the flow that
 * moved it is the sum of the flows that moved its parts.
 */

import {
  buildDailyReturns,
  buildMwr,
  buildMonthlyReturns,
  buildSimple,
  buildTwr,
} from "./returnColumns.js"
import {
  annualizedReturn,
  annualizedReturnWithheldReason,
  computeRiskMetrics,
} from "./riskMetrics.js"

export interface SnapshotRow {
  /** Present when the caller groups per portfolio (forward-fill); the naive
   * per-date sum ignores it. */
  portfolioId?: string
  baseCurrency: string | null
  snapshotDate: string
  value: number
  invested: number
  /**
   * §83.2 — cumulative net money-in on this day, same currency as `value`.
   * Required for a return at all: without it a deposit reads as a gain.
   */
  netFlow?: number | null
  /**
   * §83.2 — the §78.5 / §72.31 withheld amounts. `null` means "not measured"
   * (a row predating the column) and is carried through as unknown, never
   * coerced to 0.
   */
  unpricedValue?: number | null
  carriedValue?: number | null
}

export interface MergedPoint {
  date: string
  value: number
  invested: number
  /** Σ net flow on THIS date — a date with no row contributes 0, which is what
   * makes a carried-forward portfolio's slice of that day's return 0. */
  netFlow: number
  /** Σ withheld amounts, or `null` when any contributor did not measure them. */
  unpricedValue: number | null
  carriedValue: number | null
}

function base(row: SnapshotRow): { date: string; value: number; invested: number } {
  return { date: row.snapshotDate, value: Number(row.value), invested: Number(row.invested) }
}

/**
 * §83.2 — the two withheld amounts sum only when EVERY contributor measured
 * them. A row written before the columns existed reports `null`, and the column
 * default is 0, so summing it as 0 would claim "nothing withheld" on exactly the
 * portfolios that most need the warning — the same argument
 * `portfolios.ts:1277` makes for a single portfolio.
 */
function addWithheld(
  acc: number | null,
  row: SnapshotRow,
  pick: (r: SnapshotRow) => number | null | undefined,
): number | null {
  const v = pick(row)
  if (v == null) return null
  return (acc ?? 0) + Number(v)
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
    const acc = byDate.get(row.snapshotDate) ?? {
      date: row.snapshotDate,
      value: 0,
      invested: 0,
      netFlow: 0,
      unpricedValue: null,
      carriedValue: null,
    }
    acc.value += value
    acc.invested += invested
    // Net flow is only ever counted on the date it happened; see MergedPoint.
    acc.netFlow += Number(row.netFlow ?? 0) * rate
    acc.unpricedValue = addWithheld(acc.unpricedValue, row, (r) => r.unpricedValue)
    acc.carriedValue = addWithheld(acc.carriedValue, row, (r) => r.carriedValue)
    byDate.set(row.snapshotDate, acc)
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

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
 *
 * §83.2 — the carried row contributes its carried VALUE and INVESTED but **0
 * flow**: a portfolio nobody re-quoted today neither gained nor lost, so its
 * slice of the day's return is 0. That is correct arithmetic, not an omission,
 * and it is the reason a carried-forward portfolio cannot invent a return.
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
  const perPfSeries = new Map<
    string,
    { date: string; value: number; invested: number; netFlow: number; unpricedValue: number | null; carriedValue: number | null }[]
  >()
  for (const row of sorted) {
    const rate = rateOf(row.baseCurrency ?? to)
    if (rate == null) continue
    const pf = row.portfolioId ?? ""
    const arr = perPfSeries.get(pf) ?? []
    perPfSeries.set(pf, arr)
    arr.push({
      ...base(row),
      value: Number(row.value) * rate,
      invested: Number(row.invested) * rate,
      netFlow: Number(row.netFlow ?? 0) * rate,
      unpricedValue: row.unpricedValue == null ? null : Number(row.unpricedValue) * rate,
      carriedValue: row.carriedValue == null ? null : Number(row.carriedValue) * rate,
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
    let netFlow = 0
    let unpricedValue: number | null = null
    let carriedValue: number | null = null
    let any = false
    let withheldKnown = false
    for (const [pf, series] of perPfSeries) {
      let i = idx.get(pf)!
      while (i < series.length - 1 && series[i + 1].date <= date) i++
      idx.set(pf, i)
      const carried = series[i]
      if (carried.date > date) continue
      any = true
      value += carried.value
      invested += carried.invested
      // Flow counts only on its own date — see MergedPoint.
      if (carried.date === date) netFlow += carried.netFlow
      if (carried.unpricedValue != null && carried.carriedValue != null) {
        withheldKnown = true
        unpricedValue = (unpricedValue ?? 0) + carried.unpricedValue
        carriedValue = (carriedValue ?? 0) + carried.carriedValue
      }
    }
    if (any) {
      out.push({
        date,
        value,
        invested,
        netFlow,
        unpricedValue: withheldKnown ? unpricedValue : null,
        carriedValue: withheldKnown ? carriedValue : null,
      })
    }
  }
  return out
}

/**
 * §83.2 — build the `PortfolioAnalytics.performance` shape from the summed
 * series. The money totals are last-point based, exactly as `/merged` has
 * always done it; the RETURN columns are what §83.2 added, and they come from
 * the shared builders rather than from any stored column:
 *
 * - `cumulativeTwr` per point + `timeWeightedReturn` — `buildTwr` over the
 *   summed values and summed flows. The stored `cumulative_twr` column is
 *   per-portfolio and summing indices is meaningless, so it is not read.
 * - `moneyWeightedReturn` — `buildMwr` at request time, for the same reason:
 *   there is no aggregate `cumulative_mwr` to read.
 * - `simpleReturnPercent` — `buildSimple`.
 * - `annualizedReturn` + `annualizedReturnWithheldReason` — §82.1's two
 *   functions, so the aggregate tile withholds on exactly the predicate the
 *   per-portfolio tile uses and the two can never disagree about a window.
 * - `monthlyReturns` — the same `buildMonthlyReturns` `/:id/analytics` uses.
 * - `maxDrawdown` / `sharpeRatio` / `sortinoRatio` / `calmarRatio` /
 *   `volatility` / `winRate` — §83.4, straight off `computeRiskMetrics`, so the
 *   aggregate Drawdown card and the per-portfolio Risk tab read the same
 *   function and cannot drift. No `/merged/risk-metrics` route: the fields are
 *   already declared on `performance`.
 *
 * Units, deliberately split, because the contract field names do not disambiguate:
 * `annualizedReturn` is a PERCENT here (the analytics transport — `/:id/analytics`
 * ships percents, and §83.2's tile multiplies nothing), while the ratio fields
 * keep `/:id/risk-metrics`' form (fractions; the SPA multiplies `maxDrawdown` by
 * 100 on both routes). Shipping the risk-metrics form of `annualizedReturn` here
 * would put one contract field at two magnitudes on one response — the defect
 * §82.1's comment at the per-portfolio route already records.
 */
export function buildMergedPerformance(series: MergedPoint[]) {
  const values = series.map((p) => p.value)
  const flows = series.map((p) => p.netFlow)
  const dates = series.map((p) => p.date)

  const last = series[series.length - 1]
  const totalValue = last?.value ?? 0
  const totalInvested = last?.invested ?? 0
  const totalReturn = totalValue - totalInvested
  const totalReturnPercent = totalInvested > 0 ? (totalReturn / totalInvested) * 100 : 0

  // One point is a level, not a return: there is no prior day to difference, so
  // no return is claimed. The old code hard-nulled these unconditionally, which
  // is right for "not implemented" and wrong now that they ARE implemented.
  const hasReturn = series.length >= 2
  const twrIndex = buildTwr(values, flows)
  const twrLast = twrIndex[twrIndex.length - 1]
  const mwrIndex = hasReturn ? buildMwr(values, flows, dates) : []
  const simpleIndex = buildSimple(values)

  const annualizedWithheld = annualizedReturnWithheldReason(twrIndex, dates)

  // §83.4 — §81.1 made `computeRiskMetrics` pure: it takes the daily
  // flow-neutral returns and the dates, and this function already holds both. So
  // the aggregate risk fields are a CALL, not a new route and not SPA-side
  // arithmetic — the per-portfolio Risk tab and this Drawdown card read the same
  // numbers because they read the same function.
  const risk = computeRiskMetrics(buildDailyReturns(values, flows), dates)

  return {
    timeSeries: series.map((p, i) => ({
      date: p.date,
      value: p.value,
      invested: p.invested,
      // 100-based, like the stored per-portfolio column the SPA's Yearly view
      // differences. Absent rather than null on index 0 only if the builder
      // produced no index at all.
      cumulativeTwr: twrIndex[i] === undefined ? undefined : twrIndex[i],
      // Absent means "not measured" (see SnapshotRow.unpricedValue) — the chart
      // chip must be able to say "unknown", not "nothing withheld".
      unpricedValue: p.unpricedValue ?? undefined,
      carriedValue: p.carriedValue ?? undefined,
    })),
    totalValue,
    totalInvested,
    totalReturn,
    totalReturnPercent,
    monthlyReturns: buildMonthlyReturns(
      series.map((p, i) => ({ date: p.date, cumulativeTwr: twrIndex[i] ?? null })),
    ),
    timeWeightedReturn: hasReturn && twrLast !== undefined
      ? Math.round((twrLast - 100) * 100) / 100
      : null,
    // §82.1 recorded `moneyWeightedReturnWithheldReason: null` on `/:id/analytics`
    // because `buildMwr` silently falls back to `buildSimple` when XIRR has no
    // sign change. The aggregate keeps that contract rather than inventing a
    // reason the per-portfolio route does not send — a value with a null reason
    // is not proof of an XIRR, and both routes now say it the same way.
    moneyWeightedReturn: hasReturn ? Math.round((mwrIndex[mwrIndex.length - 1] - 100) * 100) / 100 : null,
    simpleReturnPercent: hasReturn
      ? Math.round((simpleIndex[simpleIndex.length - 1] - 100) * 100) / 100
      : undefined,
    annualizedReturn:
      annualizedWithheld === null
        ? Math.round(annualizedReturn(twrIndex, dates) * 10000) / 100
        : null,
    annualizedReturnWithheldReason: annualizedWithheld,
    // §83.4 — the Risk tab's numbers, on the analytics transport. `annualizedReturn`
    // is deliberately NOT copied from here: `computeRiskMetrics` returns a
    // FRACTION and the field above is the analytics PERCENT, both written from the
    // same index by §82.1's function. One answer, one field, one unit.
    maxDrawdown: risk.maxDrawdown,
    sharpeRatio: risk.sharpeRatio,
    sortinoRatio: risk.sortinoRatio,
    calmarRatio: risk.calmarRatio,
    volatility: risk.volatility,
    winRate: risk.winRate,
  }
}