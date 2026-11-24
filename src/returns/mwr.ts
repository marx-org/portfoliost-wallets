/**
 * MWR — money-weighted return via XIRR, then de-annualised per point.
 *
 * XIRR is solved by the `xirr` library (a proven Newton-Raphson
 * implementation), wrapped here behind a `number | null` contract. The
 * library throws on degenerate inputs (all one sign, all one day, no
 * convergence); the wrapper turns every such case into `null` so the caller
 * can withhold the figure rather than display a confident wrong number.
 */

import xirrLib from "xirr"
import { daysBetween } from "./dates.js"
import { buildSimple } from "./simple.js"

// §53.1 — Newton on near-zero-capital / one-sided-flow histories "converges"
// to absurd roots (|r| up to 1e10); such a rate is nonsense, and
// Math.pow(1+r, t) then overflows the cumulative_mwr numeric column.
// Rejecting it makes buildMwr take its buildSimple fallback.
const MAX_ABS_XIRR = 10

function saneRate(r: number): boolean {
  return Number.isFinite(r) && Math.abs(r) <= MAX_ABS_XIRR
}

/**
 * Solve the money-weighted rate for a cash-flow series.
 *
 * @param cfs   Cash flows: negative for money paid in, positive for money out.
 * @param dates ISO date per cash flow.
 * @returns The annualised rate as a fraction, or `null` when it cannot be
 *          solved (fewer than two flows, one-sided, all one day, no
 *          convergence, or an absurd root).
 */
export function xirr(cfs: number[], dates: string[]): number | null {
  if (cfs.length < 2 || dates.length !== cfs.length) return null
  const hasPos = cfs.some((c) => c > 0)
  const hasNeg = cfs.some((c) => c < 0)
  if (!hasPos || !hasNeg) return null

  const txns = cfs.map((amount, i) => ({ amount, when: Date.parse(dates[i]) }))
  // The library rejects a series whose flows all fall on one epoch day.
  const days = new Set(txns.map((t) => Math.floor(t.when / 86400000)))
  if (days.size < 2) return null

  try {
    const rate = xirrLib(txns)
    return saneRate(rate) ? rate : null
  } catch {
    return null
  }
}

/**
 * Build the MWR index (starts at 100): `-V0` at the start, `-flow_i` for each
 * deposit, `+V_last` at the end, solved by `xirr` and de-annualised per point.
 * Falls back to `buildSimple` when no sane rate exists.
 */
export function buildMwr(values: number[], flows: number[], dates: string[]): number[] {
  if (values.length === 0) return []
  const xCF: number[] = [-values[0]]
  const xDates: string[] = [dates[0]]
  for (let i = 1; i < values.length - 1; i++) {
    if (flows[i] !== 0) {
      xCF.push(-flows[i])
      xDates.push(dates[i])
    }
  }
  xCF.push(values[values.length - 1])
  xDates.push(dates[dates.length - 1])

  const rate = xirr(xCF, xDates)
  const totalDays = daysBetween(dates[0], dates[dates.length - 1])

  if (rate !== null && totalDays > 0) {
    return dates.map((d) => {
      const t = daysBetween(dates[0], d)
      return Math.round(Math.pow(1 + rate, t / 365) * 10000) / 100
    })
  }
  return buildSimple(values)
}