/** riskMetrics.test.ts — unit tests for plan 2.6 risk-metric functions */
import { describe, expect, it } from "vitest"
import {
  annualizedVolatility,
  maxDrawdown,
  sharpeRatio,
  sortinoRatio,
  calmarRatio,
  winRate,
  annualizedReturn,
  periodReturnPercent,
  annualizedReturnWithheldReason,
  computeRiskMetrics,
} from "../services/riskMetrics.js"
import { buildDailyReturns, chainReturns } from "../services/returnColumns.js"

// Helpers
function linearSeries(start: number, step: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => start + i * step)
}

/**
 * §81.1 — the risk metrics take returns, not values. Build the flow-neutral
 * series the way the route does: `values` with a `netFlow` per point.
 */
function returnsOf(values: number[], flows?: number[]): number[] {
  return buildDailyReturns(values, flows ?? new Array(values.length).fill(0))
}

/** Chain returns into the flow-neutral index the metrics read for drawdown. */
function indexOf(values: number[], flows?: number[]): number[] {
  return chainReturns(returnsOf(values, flows))
}

/** UTC-safe ISO date strings starting at startIso, one per day. */
function dates(n: number, startIso = "2025-01-01"): string[] {
  const baseMs = new Date(`${startIso}T00:00:00Z`).getTime()
  return Array.from({ length: n }, (_, i) =>
    new Date(baseMs + i * 86400000).toISOString().slice(0, 10),
  )
}

// ---------------------------------------------------------------------------
describe("maxDrawdown", () => {
  it("returns 0 for monotonically increasing values", () => {
    expect(maxDrawdown(indexOf([100, 105, 110, 120]))).toBe(0)
  })

  it("returns 0 for a single value", () => {
    expect(maxDrawdown([1])).toBe(0)
  })

  it("computes a simple 50% drawdown", () => {
    // 100 → 200 → 100: peak 200, trough 100, dd = −0.5
    expect(maxDrawdown(indexOf([100, 200, 100]))).toBe(-0.5)
  })

  it("picks the largest drawdown across multiple peaks", () => {
    // [100, 300, 150, 200, 100]
    // Global peak = 300, global trough = 100 → MDD = (100−300)/300 = −0.6667
    const dd = maxDrawdown(indexOf([100, 300, 150, 200, 100]))
    expect(dd).toBeCloseTo(-0.6667, 3)
  })

  it("is negative for any decline after a peak", () => {
    expect(maxDrawdown(indexOf([100, 90]))).toBeLessThan(0)
  })

  // §81.1 — a deposit mid-drawdown used to reset the running peak and truncate
  // the drawdown: 100 → 50 → +100 → 150 → 75 is a flow-neutral index of
  // [1, 0.5, 0.5, 0.25], i.e. −75%, but the raw values peak at 150 and report
  // only −50%.
  it("is not truncated by a deposit made during a drawdown", () => {
    const values = [100, 50, 150, 75]
    const flows = [0, 0, 100, 0]
    expect(returnsOf(values, flows)).toEqual([-0.5, 0, -0.5])
    expect(maxDrawdown(indexOf(values, flows))).toBe(-0.75)
  })
})

// ---------------------------------------------------------------------------
describe("annualizedVolatility", () => {
  it("returns 0 for fewer than 2 returns", () => {
    expect(annualizedVolatility([])).toBe(0)
    expect(annualizedVolatility([0.01])).toBe(0)
  })

  it("returns 0 for a constant series", () => {
    expect(annualizedVolatility(new Array(30).fill(0))).toBe(0)
  })

  it("returns a positive number for a non-constant series", () => {
    const v = returnsOf(linearSeries(100, 1, 60))
    expect(annualizedVolatility(v)).toBeGreaterThan(0)
  })

  it("is larger for a more volatile series", () => {
    const stable = returnsOf(linearSeries(100, 0.1, 60))
    const volatile_ = returnsOf(linearSeries(100, 5, 60))
    expect(annualizedVolatility(volatile_)).toBeGreaterThan(annualizedVolatility(stable))
  })
})

// ---------------------------------------------------------------------------
describe("sharpeRatio", () => {
  it("returns 0 for fewer than 2 returns", () => {
    expect(sharpeRatio([])).toBe(0)
  })

  it("returns 0 for a constant series (σ = 0)", () => {
    expect(sharpeRatio(new Array(20).fill(0))).toBe(0)
  })

  it("is positive for a rising series above the risk-free rate", () => {
    // Steady 0.5% daily gain far exceeds 5% annual risk-free
    const v = returnsOf(linearSeries(100, 0.5, 60))
    expect(sharpeRatio(v)).toBeGreaterThan(0)
  })

  it("is negative for a declining series", () => {
    const v = returnsOf(linearSeries(200, -1, 60)) // from 200 down to 141
    expect(sharpeRatio(v)).toBeLessThan(0)
  })
})

// ---------------------------------------------------------------------------
describe("sortinoRatio", () => {
  it("returns 0 for fewer than 2 returns", () => {
    expect(sortinoRatio([])).toBe(0)
  })

  it("is positive for a steadily rising series", () => {
    const v = returnsOf(linearSeries(100, 0.5, 60))
    expect(sortinoRatio(v)).toBeGreaterThan(0)
  })

  it("is ≥ sharpe for a one-sided-up series (no downside days)", () => {
    const v = returnsOf(linearSeries(100, 1, 60))
    // No downside returns → denominator shrinks → sortino ≥ sharpe
    const sr = sharpeRatio(v)
    const so = sortinoRatio(v)
    expect(so).toBeGreaterThanOrEqual(sr)
  })
})

// ---------------------------------------------------------------------------
describe("calmarRatio", () => {
  it("returns 0 when no drawdown", () => {
    const v = linearSeries(100, 1, 60)
    expect(calmarRatio(indexOf(v), dates(60))).toBe(0)
  })

  it("returns 0 for fewer than 2 points", () => {
    expect(calmarRatio([1], dates(1))).toBe(0)
  })

  it("returns a positive number for gain-with-drawdown series", () => {
    // Rises to 200 then drops to 150 (MDD = −25%), ends higher than start
    const v = [...linearSeries(100, 10, 11), ...linearSeries(200, -5, 11)]
    expect(calmarRatio(indexOf(v), dates(22))).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
describe("winRate", () => {
  it("returns 0 for no returns", () => {
    expect(winRate([])).toBe(0)
  })

  it("returns 100 for a monotonically increasing series", () => {
    expect(winRate(returnsOf(linearSeries(100, 1, 20)))).toBe(100)
  })

  it("returns 0 for a monotonically decreasing series", () => {
    expect(winRate(returnsOf(linearSeries(100, -1, 20)))).toBe(0)
  })

  it("returns ~50 for alternating up/down series", () => {
    const v: number[] = []
    for (let i = 0; i < 20; i++) v.push(100 + (i % 2 === 0 ? 1 : -1))
    const wr = winRate(returnsOf(v))
    expect(wr).toBeGreaterThan(0)
    expect(wr).toBeLessThan(100)
  })
})

// ---------------------------------------------------------------------------
describe("annualizedReturn", () => {
  it("returns 0 for fewer than 2 points", () => {
    expect(annualizedReturn([1], dates(1))).toBe(0)
  })

  it("returns 0 for a series with no growth", () => {
    expect(annualizedReturn(indexOf([100, 100]), dates(2))).toBe(0)
  })

  it("is positive for a gaining series", () => {
    const v = linearSeries(100, 1, 252)
    expect(annualizedReturn(indexOf(v), dates(252))).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
describe("periodReturnPercent", () => {
  it("returns 0 for fewer than 2 points", () => {
    expect(periodReturnPercent([1])).toBe(0)
  })

  it("returns 0 for a flat series", () => {
    expect(periodReturnPercent(indexOf([100, 100]))).toBe(0)
  })

  it("returns 100 when value doubles", () => {
    expect(periodReturnPercent(indexOf([100, 200]))).toBe(100)
  })

  it("returns -50 when value halves", () => {
    expect(periodReturnPercent(indexOf([200, 100]))).toBe(-50)
  })
})

// ---------------------------------------------------------------------------
describe("annualizedReturnWithheldReason", () => {
  it("withholds for < 60 data points", () => {
    expect(annualizedReturnWithheldReason(new Array(59).fill(1), dates(59))).toBe(
      "insufficient_history",
    )
  })

  it("withholds when date span < 90 days", () => {
    const idx = new Array(60).fill(1)
    const ds = dates(60, "2026-01-01") // 60 calendar days, < 90
    expect(annualizedReturnWithheldReason(idx, ds)).toBe("insufficient_history")
  })

  it("returns null for adequate history (>= 60 points, >= 90 calendar days)", () => {
    // 91 calendar days starting 2025-01-01 → 2025-04-01 (= 90-day span > 90)
    const idx = new Array(91).fill(1)
    const ds = dates(91, "2025-01-01")
    expect(annualizedReturnWithheldReason(idx, ds)).toBeNull()
  })

  it("withholds for Infinity values", () => {
    const idx = [...new Array(90).fill(1), Infinity]
    const ds = dates(91, "2025-01-01")
    expect(annualizedReturnWithheldReason(idx, ds)).toBe("invalid_data")
  })
})

// ---------------------------------------------------------------------------
describe("computeRiskMetrics", () => {
  it("returns all-zero-ish metrics for empty input", () => {
    const m = computeRiskMetrics([], [])
    expect(m.sharpeRatio).toBe(0)
    expect(m.maxDrawdown).toBe(0)
    expect(m.winRate).toBe(0)
    expect(m.volatility).toBe(0)
    expect(m.annualizedReturn).toBeNull() // withheld: insufficient history
  })

  it("withholds annualizedReturn when history is too short", () => {
    const n = 30
    const m = computeRiskMetrics(returnsOf(new Array(n).fill(100)), dates(n))
    expect(m.annualizedReturn).toBeNull()
    expect(m.annualizedReturnWithheldReason).toBe("insufficient_history")
  })

  it("provides annualizedReturn for long enough history", () => {
    const n = 252
    const vals = linearSeries(100, 0.5, n)
    const m = computeRiskMetrics(returnsOf(vals), dates(n))
    expect(m.annualizedReturn).not.toBeNull()
    expect(m.annualizedReturnWithheldReason).toBeNull()
  })

  it("positive sharpe/sortino for a steady uptrend", () => {
    const n = 252
    const vals = linearSeries(100, 0.5, n)
    const m = computeRiskMetrics(returnsOf(vals), dates(n))
    expect(m.sharpeRatio).toBeGreaterThan(0)
    expect(m.sortinoRatio).toBeGreaterThan(0)
  })

  it("maxDrawdown is 0 for monotonically increasing series", () => {
    const v = linearSeries(100, 1, 50)
    const m = computeRiskMetrics(returnsOf(v), dates(50))
    expect(m.maxDrawdown).toBe(0)
  })

  it("winRate is 100 for monotonically increasing series", () => {
    const v = linearSeries(100, 1, 50)
    const m = computeRiskMetrics(returnsOf(v), dates(50))
    expect(m.winRate).toBe(100)
  })
})

// ---------------------------------------------------------------------------
// §81.1 — cash-flow invariance. Every metric above used to be derived from the
// raw `value` column, so a deposit booked as a portfolio return.
// ---------------------------------------------------------------------------

describe("§81.1 a deposit is not a return", () => {
  it("books a deposit as a zero return, not a portfolio return", () => {
    // A €50k deposit into a €1k portfolio with flat prices. The raw-value path
    // logged log(51000/1000) — a 200% day — and every downstream metric
    // inherited it.
    expect(returnsOf([1000, 51000], [0, 50000])).toEqual([0])
    // The plan's own example: €50k into €50k.
    expect(returnsOf([50000, 100000], [0, 50000])).toEqual([0])
  })

  it("keeps the market move that follows a deposit", () => {
    // The deposit lands first, then the portfolio gains 10% of the enlarged base.
    expect(returnsOf([1000, 51000, 56100], [0, 50000, 0])[1]).toBeCloseTo(0.1, 12)
  })
})

// ---------------------------------------------------------------------------
// §81.1 — cash-flow invariance across the whole metric set.
//
// A deposit leaves every metric untouched exactly when no price moves after it.
// End-of-day values cannot recover a daily return against a capital base that
// changed, so once the post-deposit portfolio really does trade, its percentage
// returns legitimately differ — the same €3 on €51,017 is a smaller return than
// on €1,017. The series below therefore moves for the first 39 days and is flat
// from the deposit onwards, which makes the invariant exact while keeping every
// metric non-degenerate.
// ---------------------------------------------------------------------------

const N = 90
const DEPOSIT_DAY = 40
const DEPOSIT = 50_000

/** Alternating +3 / −2 moves up to DEPOSIT_DAY, flat prices thereafter. */
function baseValues(): number[] {
  const v = [1000]
  for (let i = 1; i < N; i++) {
    v.push(v[i - 1] + (i >= DEPOSIT_DAY ? 0 : i % 2 === 0 ? 3 : -2))
  }
  return v
}

function withDeposit(values: number[], day: number, amount: number) {
  const flows = new Array(values.length).fill(0)
  flows[day] = amount
  const shifted = values.map((v, i) => v + (i >= day ? amount : 0))
  return { values: shifted, flows }
}

describe("§81.1 a deposit leaves every metric unchanged", () => {
  const base = baseValues()
  const { values: depValues, flows } = withDeposit(base, DEPOSIT_DAY, DEPOSIT)
  const noFlow = returnsOf(base)
  const withFlow = returnsOf(depValues, flows)

  it("produces an identical daily return series", () => {
    expect(withFlow).toHaveLength(noFlow.length)
    expect(withFlow).toEqual(noFlow)
  })

  it("annualizedVolatility is unchanged by the deposit", () => {
    expect(annualizedVolatility(withFlow)).toBeCloseTo(annualizedVolatility(noFlow), 10)
    expect(annualizedVolatility(noFlow)).toBeGreaterThan(0)
  })

  it("sharpeRatio is unchanged by the deposit", () => {
    expect(sharpeRatio(withFlow)).toBe(sharpeRatio(noFlow))
  })

  it("sortinoRatio is unchanged by the deposit", () => {
    expect(sortinoRatio(withFlow)).toBe(sortinoRatio(noFlow))
  })

  it("winRate is unchanged by the deposit", () => {
    expect(winRate(withFlow)).toBe(winRate(noFlow))
    expect(winRate(noFlow)).toBeGreaterThan(0)
    expect(winRate(noFlow)).toBeLessThan(100)
  })

  it("maxDrawdown is unchanged by the deposit", () => {
    const a = maxDrawdown(indexOf(depValues, flows))
    const b = maxDrawdown(indexOf(base))
    expect(a).toBe(b)
    expect(b).toBeLessThan(0) // the base series really does draw down
  })

  it("periodReturnPercent is unchanged by the deposit", () => {
    expect(periodReturnPercent(indexOf(depValues, flows))).toBe(periodReturnPercent(indexOf(base)))
    // The deposit alone doubled the raw value, so the old raw-value path read
    // the deposit as profit.
    const rawPath = depValues[depValues.length - 1] / depValues[0] - 1
    expect(periodReturnPercent(indexOf(base))).toBeLessThan(rawPath)
  })

  it("calmarRatio is unchanged by the deposit", () => {
    const ds = dates(N)
    expect(calmarRatio(indexOf(depValues, flows), ds)).toBe(calmarRatio(indexOf(base), ds))
    expect(calmarRatio(indexOf(base), ds)).toBeGreaterThan(0)
  })

  it("computeRiskMetrics returns identical metrics with and without the deposit", () => {
    const ds = dates(N)
    const withDep = computeRiskMetrics(withFlow, ds)
    const without = computeRiskMetrics(noFlow, ds)
    expect(withDep.volatility).toBeCloseTo(without.volatility, 10)
    expect(withDep.sharpeRatio).toBe(without.sharpeRatio)
    expect(withDep.sortinoRatio).toBe(without.sortinoRatio)
    expect(withDep.winRate).toBe(without.winRate)
    expect(withDep.maxDrawdown).toBe(without.maxDrawdown)
    expect(withDep.calmarRatio).toBe(without.calmarRatio)
    expect(withDep.periodReturnPercent).toBe(without.periodReturnPercent)
    expect(withDep.annualizedReturn).toBe(without.annualizedReturn)
  })

  it("does not truncate a drawdown that a deposit lands inside", () => {
    // 100 → 50 → +100 → 150 → 75: the deposit lands on a flat price day, then
    // the portfolio halves. Flow-neutral index [1, .5, .5, .25] → MDD −75%.
    // The raw-value peak of 150 truncated it to −50%.
    const m = computeRiskMetrics(returnsOf([100, 50, 150, 75], [0, 0, 100, 0]), dates(4))
    expect(m.maxDrawdown).toBe(-0.75)
    expect(m.periodReturnPercent).toBe(-75)
  })
})
