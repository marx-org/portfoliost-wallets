/**
 * TWR — daily chain-linked sub-period returns.
 *
 * §81.1 — the daily flow-neutral sub-period return series (HPR):
 *
 *   HPR_t = V_t / (V_{t-1} + netFlow_t) − 1
 *
 * `netFlow_t` is removed from the denominator so an external cash flow never
 * books as a market return. The sub-period returns are computed by the
 * `@railpath/finance-toolkit` TWR engine; `buildTwr` chains them, and the risk
 * metrics consume the same series, so the chart and the Risk tab cannot drift
 * apart.
 *
 * Length is `values.length − 1` — index 0 has no prior day, hence no return.
 */
import { calculateTimeWeightedReturn } from "@railpath/finance-toolkit"
import { DAYS_PER_YEAR } from "./dates.js"

export function buildDailyReturns(values: number[], flows: number[]): number[] {
  try {
    return calculateTimeWeightedReturn({
      portfolioValues: values,
      cashFlows: flows,
      annualizationFactor: DAYS_PER_YEAR,
    }).periodReturns
  } catch {
    // The library rejects a non-positive denominator (nothing invested and
    // nothing to lose); that day contributes 0 rather than blanking the series.
    return buildDailyReturnsFallback(values, flows)
  }
}

/** In-house HPR, used only when the library rejects a degenerate denominator. */
function buildDailyReturnsFallback(values: number[], flows: number[]): number[] {
  const out: number[] = []
  for (let i = 1; i < values.length; i++) {
    const denom = values[i - 1] + (flows[i] ?? 0)
    out.push(denom !== 0 ? values[i] / denom - 1 : 0)
  }
  return out
}

/** Chain sub-period returns into a flow-neutral index starting at 1. */
export function chainReturns(returns: number[]): number[] {
  const index: number[] = [1]
  let cum = 1
  for (const r of returns) {
    cum *= 1 + r
    index.push(cum)
  }
  return index
}

/** Flow-neutral TWR index (starts at 100), one point per input value. */
export function buildTwr(values: number[], flows: number[]): number[] {
  if (values.length === 0) return []
  return chainReturns(buildDailyReturns(values, flows)).map((v) => Math.round(v * 10000) / 100)
}