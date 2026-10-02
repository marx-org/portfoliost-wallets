/**
 * Risk metrics computation for portfolio analytics (D46 plan step 2.6).
 *
 * All functions take a flow-neutral daily series built by `returnColumns`:
 * `buildDailyReturns` for the per-day returns, `chainReturns` for the index
 * those returns compound into. Volatility is already computed per benchmark
 * series in returnColumns / backfill — here we re-use the same √252
 * annualisation convention for the portfolio itself.
 *
 * §81.1 — none of these functions take a raw portfolio *value* series. A
 * deposit moves `value` with no market move behind it, so deriving returns from
 * it booked every cash flow as a portfolio return.
 *
 * Public API:
 *   computeRiskMetrics(returns, dates, riskFreeRate?) → PortfolioRiskMetrics
 */

import { chainReturns } from "./returnColumns.js"

/** TRADING_DAYS_PER_YEAR — used for annualisation of daily returns. */
const TRADING_DAYS = 252

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((s, x) => s + x, 0) / xs.length
}

function stddev(xs: number[], mu?: number): number {
  if (xs.length < 2) return 0
  const m = mu ?? mean(xs)
  const variance = xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1)
  return Math.sqrt(variance)
}

// ---------------------------------------------------------------------------
// Exported metric functions
// ---------------------------------------------------------------------------

/**
 * Annualised volatility of the daily return series (√TRADING_DAYS × σ_daily).
 * Returned as a fraction (e.g. 0.18 = 18 %).
 *
 * @param returns Daily flow-neutral returns (`buildDailyReturns` output).
 */
export function annualizedVolatility(returns: number[]): number {
  if (returns.length < 2) return 0
  return stddev(returns) * Math.sqrt(TRADING_DAYS)
}

/**
 * Maximum drawdown from peak to trough as a fraction (e.g. −0.25 = −25 %).
 * Returns a negative number (or 0 when the series is monotonically increasing).
 *
 * @param index Flow-neutral index (`chainReturns` output), starting at 1.
 */
export function maxDrawdown(index: number[]): number {
  if (index.length < 2) return 0
  let peak = index[0]
  let mdd = 0
  for (const v of index) {
    if (v > peak) peak = v
    const dd = peak > 0 ? (v - peak) / peak : 0
    if (dd < mdd) mdd = dd
  }
  return Math.round(mdd * 10000) / 10000  // 4 dp
}

/**
 * Sharpe ratio = (mean daily return − daily risk-free rate) / σ_daily,
 * annualised by √TRADING_DAYS.
 *
 * @param returns      Daily flow-neutral returns.
 * @param riskFreeRate Annual risk-free rate as a fraction (default 0.05 = 5 %).
 */
export function sharpeRatio(returns: number[], riskFreeRate = 0.05): number {
  if (returns.length < 2) return 0
  const dailyRf = riskFreeRate / TRADING_DAYS
  const excessMean = mean(returns) - dailyRf
  const sd = stddev(returns)
  if (sd === 0) return 0
  return Math.round((excessMean / sd) * Math.sqrt(TRADING_DAYS) * 100) / 100
}

/**
 * Sortino ratio — same as Sharpe but uses downside deviation (only negative
 * excess returns) instead of total σ.
 *
 * When there are no downside days (downside deviation = 0), falls back to the
 * Sharpe ratio — which is a conservative lower bound for a purely positive
 * return series.
 *
 * @param returns      Daily flow-neutral returns.
 * @param riskFreeRate Annual risk-free rate as a fraction (default 0.05).
 */
export function sortinoRatio(returns: number[], riskFreeRate = 0.05): number {
  if (returns.length < 2) return 0
  const dailyRf = riskFreeRate / TRADING_DAYS
  const excessMean = mean(returns) - dailyRf
  const downside = returns.map((r) => Math.min(r - dailyRf, 0))
  const downsideVar =
    downside.reduce((s, r) => s + r * r, 0) / Math.max(downside.length - 1, 1)
  const downsideSd = Math.sqrt(downsideVar)
  // No downside days → fall back to Sharpe (conservative lower bound)
  if (downsideSd === 0) return sharpeRatio(returns, riskFreeRate)
  return Math.round((excessMean / downsideSd) * Math.sqrt(TRADING_DAYS) * 100) / 100
}

/**
 * Calmar ratio = annualised return / |maxDrawdown|.
 * Returns 0 when maxDrawdown is 0 (no drawdown period).
 *
 * @param index Flow-neutral index (`chainReturns` output), starting at 1.
 * @param dates ISO date strings matching `index`.
 */
export function calmarRatio(index: number[], dates: string[]): number {
  if (index.length < 2) return 0
  const ann = annualizedReturn(index, dates)
  const mdd = maxDrawdown(index)
  if (mdd === 0) return 0
  return Math.round((ann / Math.abs(mdd)) * 100) / 100
}

/**
 * Win rate = fraction of days with a positive return.
 * Returned as a percentage (0–100).
 *
 * @param returns Daily flow-neutral returns.
 */
export function winRate(returns: number[]): number {
  if (returns.length === 0) return 0
  const wins = returns.filter((r) => r > 0).length
  return Math.round((wins / returns.length) * 10000) / 100  // 2 dp percentage
}

/**
 * Annualised return from the flow-neutral index, compounded daily.
 *
 * @param index Flow-neutral index (`chainReturns` output), starting at 1.
 * @param dates ISO date strings matching `index`.
 */
export function annualizedReturn(index: number[], dates: string[]): number {
  if (index.length < 2) return 0
  const i0 = index[0]
  const iN = index[index.length - 1]
  if (i0 <= 0 || iN <= 0) return 0
  const n = index.length - 1  // number of 1-day steps
  return (iN / i0) ** (TRADING_DAYS / n) - 1
}

/**
 * Period return = (index_last / index_first − 1) as a percentage.
 *
 * @param index Flow-neutral index (`chainReturns` output), starting at 1.
 */
export function periodReturnPercent(index: number[]): number {
  if (index.length < 2) return 0
  const i0 = index[0]
  const iN = index[index.length - 1]
  if (i0 <= 0) return 0
  return Math.round(((iN / i0 - 1) * 100) * 100) / 100
}

// ---------------------------------------------------------------------------
// Annualised return withholding rules
// ---------------------------------------------------------------------------

/**
 * Returns a reason string if the annualised return should be withheld (not
 * shown), or null if it is safe to display.
 *
 * Rules (conservative subset of example-service behaviour):
 *  - < 60 data points (< ~3 months of trading days) → "insufficient_history"
 *  - Series spans < 90 calendar days → "insufficient_history"
 *  - Values contain any NaN/Infinity → "invalid_data"
 */
export function annualizedReturnWithheldReason(
  index: number[],
  dates: string[],
): string | null {
  if (index.length < 60) return "insufficient_history"
  if (index.some((v) => !isFinite(v))) return "invalid_data"
  if (dates.length >= 2) {
    const spanDays = (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / 86400000
    if (spanDays < 90) return "insufficient_history"
  }
  return null
}

// ---------------------------------------------------------------------------
// Composite
// ---------------------------------------------------------------------------

export interface RiskMetricsResult {
  sharpeRatio: number
  sortinoRatio: number
  calmarRatio: number
  volatility: number
  maxDrawdown: number
  winRate: number
  periodReturnPercent: number
  annualizedReturn: number | null
  annualizedReturnWithheldReason: string | null
}

/**
 * Compute all risk metrics from the daily flow-neutral return series.
 *
 * @param returns       Daily flow-neutral returns (`buildDailyReturns`).
 * @param dates         ISO date strings for the *values* series, i.e. one per
 *                      return plus the opening day (length = returns.length + 1).
 * @param riskFreeRate  Annual risk-free rate as a fraction (default 0.05).
 */
export function computeRiskMetrics(
  returns: number[],
  dates: string[],
  riskFreeRate = 0.05,
): RiskMetricsResult {
  const index = chainReturns(returns)
  const withheldReason = annualizedReturnWithheldReason(index, dates)
  const annReturn = withheldReason === null ? annualizedReturn(index, dates) : null

  return {
    sharpeRatio: sharpeRatio(returns, riskFreeRate),
    sortinoRatio: sortinoRatio(returns, riskFreeRate),
    calmarRatio: calmarRatio(index, dates),
    volatility: annualizedVolatility(returns),
    maxDrawdown: maxDrawdown(index),
    winRate: winRate(returns),
    periodReturnPercent: periodReturnPercent(index),
    annualizedReturn: annReturn !== null ? Math.round(annReturn * 10000) / 10000 : null,
    annualizedReturnWithheldReason: withheldReason,
  }
}
