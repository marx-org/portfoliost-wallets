/**
 * Risk metrics computation for portfolio analytics (D46 plan step 2.6).
 *
 * All functions take a series of portfolio values (or returns) indexed by
 * calendar day.  Volatility is already computed per benchmark series in
 * returnColumns / backfill — here we re-use the same √252 annualisation
 * convention for the portfolio itself.
 *
 * Public API:
 *   computeRiskMetrics(values, dates, netFlows, riskFreeRate?) → PortfolioRiskMetrics
 */

/** TRADING_DAYS_PER_YEAR — used for annualisation of daily returns. */
const TRADING_DAYS = 252

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Daily log-return series from an array of values (length = values.length − 1). */
function dailyLogReturns(values: number[]): number[] {
  const out: number[] = []
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] > 0 && values[i] > 0) {
      out.push(Math.log(values[i] / values[i - 1]))
    } else {
      out.push(0)
    }
  }
  return out
}

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
 * Annualised volatility of daily log-returns (√TRADING_DAYS × σ_daily).
 * Returned as a fraction (e.g. 0.18 = 18 %).
 */
export function annualizedVolatility(values: number[]): number {
  if (values.length < 2) return 0
  const rets = dailyLogReturns(values)
  return stddev(rets) * Math.sqrt(TRADING_DAYS)
}

/**
 * Maximum drawdown from peak to trough as a fraction (e.g. −0.25 = −25 %).
 * Returns a negative number (or 0 when values are monotonically increasing).
 */
export function maxDrawdown(values: number[]): number {
  if (values.length < 2) return 0
  let peak = values[0]
  let mdd = 0
  for (const v of values) {
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
 * @param riskFreeRate  Annual risk-free rate as a fraction (default 0.05 = 5 %).
 */
export function sharpeRatio(values: number[], riskFreeRate = 0.05): number {
  if (values.length < 2) return 0
  const rets = dailyLogReturns(values)
  const dailyRf = riskFreeRate / TRADING_DAYS
  const excessMean = mean(rets) - dailyRf
  const sd = stddev(rets)
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
 * @param riskFreeRate  Annual risk-free rate as a fraction (default 0.05).
 */
export function sortinoRatio(values: number[], riskFreeRate = 0.05): number {
  if (values.length < 2) return 0
  const rets = dailyLogReturns(values)
  const dailyRf = riskFreeRate / TRADING_DAYS
  const excessMean = mean(rets) - dailyRf
  const downside = rets.map((r) => Math.min(r - dailyRf, 0))
  const downsideVar =
    downside.reduce((s, r) => s + r * r, 0) / Math.max(downside.length - 1, 1)
  const downsideSd = Math.sqrt(downsideVar)
  // No downside days → fall back to Sharpe (conservative lower bound)
  if (downsideSd === 0) return sharpeRatio(values, riskFreeRate)
  return Math.round((excessMean / downsideSd) * Math.sqrt(TRADING_DAYS) * 100) / 100
}

/**
 * Calmar ratio = annualised return / |maxDrawdown|.
 * Returns 0 when maxDrawdown is 0 (no drawdown period).
 */
export function calmarRatio(values: number[]): number {
  if (values.length < 2) return 0
  const ann = annualizedReturn(values)
  const mdd = maxDrawdown(values)
  if (mdd === 0) return 0
  return Math.round((ann / Math.abs(mdd)) * 100) / 100
}

/**
 * Win rate = fraction of trading days with a positive return.
 * Returned as a percentage (0–100).
 */
export function winRate(values: number[]): number {
  if (values.length < 2) return 0
  const rets = dailyLogReturns(values)
  const wins = rets.filter((r) => r > 0).length
  return Math.round((wins / rets.length) * 10000) / 100  // 2 dp percentage
}

/**
 * Annualised return from a value series, compounded daily.
 * annReturn = (V_last / V_first) ^ (TRADING_DAYS / n) − 1, where n = trading days in series.
 * Falls back to 0 for series too short or with zero start.
 */
export function annualizedReturn(values: number[]): number {
  if (values.length < 2) return 0
  const v0 = values[0]
  const vn = values[values.length - 1]
  if (v0 <= 0 || vn <= 0) return 0
  const n = values.length - 1  // number of 1-day steps
  return (vn / v0) ** (TRADING_DAYS / n) - 1
}

/**
 * Period return = (V_last / V_first − 1) as a percentage.
 */
export function periodReturnPercent(values: number[]): number {
  if (values.length < 2) return 0
  const v0 = values[0]
  const vn = values[values.length - 1]
  if (v0 <= 0) return 0
  return Math.round(((vn / v0 - 1) * 100) * 100) / 100
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
  values: number[],
  dates: string[],
): string | null {
  if (values.length < 60) return "insufficient_history"
  if (values.some((v) => !isFinite(v))) return "invalid_data"
  if (dates.length >= 2) {
    const spanDays =
      (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / 86400000
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
 * Compute all risk metrics from a daily value series.
 *
 * @param values         Portfolio values in chronological order.
 * @param dates          ISO date strings matching `values` (same length).
 * @param riskFreeRate   Annual risk-free rate as a fraction (default 0.05).
 */
export function computeRiskMetrics(
  values: number[],
  dates: string[],
  riskFreeRate = 0.05,
): RiskMetricsResult {
  const withheldReason = annualizedReturnWithheldReason(values, dates)
  const annReturn = withheldReason === null ? annualizedReturn(values) : null

  return {
    sharpeRatio: sharpeRatio(values, riskFreeRate),
    sortinoRatio: sortinoRatio(values, riskFreeRate),
    calmarRatio: calmarRatio(values),
    volatility: annualizedVolatility(values),
    maxDrawdown: maxDrawdown(values),
    winRate: winRate(values),
    periodReturnPercent: periodReturnPercent(values),
    annualizedReturn: annReturn !== null ? Math.round(annReturn * 10000) / 10000 : null,
    annualizedReturnWithheldReason: withheldReason,
  }
}
