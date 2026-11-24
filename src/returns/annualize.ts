/**
 * Annualisation constructs and their withholding rules.
 *
 * `annualizedReturn` measures a *span* (exponent pairs 365 days/year with
 * elapsed calendar days). `periodReturnPercent` is the whole-window return.
 * `annualizedReturnWithheldReason` decides when a rate must not be shown.
 */

import { daysBetween } from "./dates.js"

const DAYS_PER_YEAR = 365

/**
 * Annualised return of a flow-neutral index (fraction, e.g. 0.10 = 10 %).
 *
 *   (index_last / index_first) ^ (365 / elapsedDays) − 1
 *
 * Reads the dates rather than `index.length − 1` so the exponent stays honest
 * across gaps in the series. Returns 0 for a degenerate series.
 */
export function annualizedReturn(index: number[], dates: string[]): number {
  if (index.length < 2 || dates.length < 2) return 0
  const i0 = index[0]
  const iN = index[index.length - 1]
  if (i0 <= 0 || iN <= 0) return 0
  const elapsedDays = daysBetween(dates[0], dates[dates.length - 1])
  if (elapsedDays <= 0) return 0
  return (iN / i0) ** (DAYS_PER_YEAR / elapsedDays) - 1
}

/**
 * Period return = (index_last / index_first − 1) as a percentage.
 */
export function periodReturnPercent(index: number[]): number {
  if (index.length < 2) return 0
  const i0 = index[0]
  const iN = index[index.length - 1]
  if (i0 <= 0) return 0
  return Math.round((iN / i0 - 1) * 100 * 100) / 100
}

/**
 * Returns a reason string if the annualised return should be withheld (not
 * shown), or null if it is safe to display.
 *
 *  - < 60 data points (< ~3 months of trading days) → "insufficient_history"
 *  - Series spans < 90 calendar days → "insufficient_history"
 *  - Values contain any NaN/Infinity → "invalid_data"
 */
export function annualizedReturnWithheldReason(index: number[], dates: string[]): string | null {
  if (index.length < 60) return "insufficient_history"
  if (index.some((v) => !isFinite(v))) return "invalid_data"
  if (dates.length >= 2) {
    if (daysBetween(dates[0], dates[dates.length - 1]) < 90) return "insufficient_history"
  }
  return null
}