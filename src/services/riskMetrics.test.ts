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

// Helpers
function linearSeries(start: number, step: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => start + i * step)
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
    expect(maxDrawdown([100, 105, 110, 120])).toBe(0)
  })

  it("returns 0 for a single value", () => {
    expect(maxDrawdown([100])).toBe(0)
  })

  it("computes a simple 50% drawdown", () => {
    // 100 → 200 → 100: peak 200, trough 100, dd = −0.5
    expect(maxDrawdown([100, 200, 100])).toBe(-0.5)
  })

  it("picks the largest drawdown across multiple peaks", () => {
    // [100, 300, 150, 200, 100]
    // Global peak = 300, global trough = 100 → MDD = (100−300)/300 = −0.6667
    const dd = maxDrawdown([100, 300, 150, 200, 100])
    expect(dd).toBeCloseTo(-0.6667, 3)
  })

  it("is negative for any decline after a peak", () => {
    expect(maxDrawdown([100, 90])).toBeLessThan(0)
  })
})

// ---------------------------------------------------------------------------
describe("annualizedVolatility", () => {
  it("returns 0 for fewer than 2 values", () => {
    expect(annualizedVolatility([100])).toBe(0)
    expect(annualizedVolatility([])).toBe(0)
  })

  it("returns 0 for a constant series", () => {
    expect(annualizedVolatility(new Array(30).fill(100))).toBe(0)
  })

  it("returns a positive number for a non-constant series", () => {
    const v = linearSeries(100, 1, 60)
    expect(annualizedVolatility(v)).toBeGreaterThan(0)
  })

  it("is larger for a more volatile series", () => {
    const stable = linearSeries(100, 0.1, 60)
    const volatile_ = linearSeries(100, 5, 60)
    expect(annualizedVolatility(volatile_)).toBeGreaterThan(annualizedVolatility(stable))
  })
})

// ---------------------------------------------------------------------------
describe("sharpeRatio", () => {
  it("returns 0 for fewer than 2 values", () => {
    expect(sharpeRatio([100])).toBe(0)
  })

  it("returns 0 for a constant series (σ = 0)", () => {
    expect(sharpeRatio(new Array(20).fill(100))).toBe(0)
  })

  it("is positive for a rising series above the risk-free rate", () => {
    // Steady 0.5% daily gain far exceeds 5% annual risk-free
    const v = linearSeries(100, 0.5, 60)
    expect(sharpeRatio(v)).toBeGreaterThan(0)
  })

  it("is negative for a declining series", () => {
    const v = linearSeries(200, -1, 60) // from 200 down to 141
    expect(sharpeRatio(v)).toBeLessThan(0)
  })
})

// ---------------------------------------------------------------------------
describe("sortinoRatio", () => {
  it("returns 0 for fewer than 2 values", () => {
    expect(sortinoRatio([100])).toBe(0)
  })

  it("is positive for a steadily rising series", () => {
    const v = linearSeries(100, 0.5, 60)
    expect(sortinoRatio(v)).toBeGreaterThan(0)
  })

  it("is ≥ sharpe for a one-sided-up series (no downside days)", () => {
    const v = linearSeries(100, 1, 60)
    // No downside returns → denominator shrinks → sortino ≥ sharpe
    const sr = sharpeRatio(v)
    const so = sortinoRatio(v)
    expect(so).toBeGreaterThanOrEqual(sr)
  })
})

// ---------------------------------------------------------------------------
describe("calmarRatio", () => {
  it("returns 0 when no drawdown", () => {
    expect(calmarRatio(linearSeries(100, 1, 60))).toBe(0)
  })

  it("returns 0 for fewer than 2 values", () => {
    expect(calmarRatio([100])).toBe(0)
  })

  it("returns a positive number for gain-with-drawdown series", () => {
    // Rises to 200 then drops to 150 (MDD = −25%), ends higher than start
    const v = [...linearSeries(100, 10, 11), ...linearSeries(200, -5, 11)]
    expect(calmarRatio(v)).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
describe("winRate", () => {
  it("returns 0 for fewer than 2 values", () => {
    expect(winRate([100])).toBe(0)
  })

  it("returns 100 for a monotonically increasing series", () => {
    expect(winRate(linearSeries(100, 1, 20))).toBe(100)
  })

  it("returns 0 for a monotonically decreasing series", () => {
    expect(winRate(linearSeries(100, -1, 20))).toBe(0)
  })

  it("returns ~50 for alternating up/down series", () => {
    const v: number[] = []
    for (let i = 0; i < 20; i++) v.push(100 + (i % 2 === 0 ? 1 : -1))
    const wr = winRate(v)
    expect(wr).toBeGreaterThan(0)
    expect(wr).toBeLessThan(100)
  })
})

// ---------------------------------------------------------------------------
describe("annualizedReturn", () => {
  it("returns 0 for fewer than 2 values", () => {
    expect(annualizedReturn([100])).toBe(0)
  })

  it("returns 0 when start value is 0", () => {
    expect(annualizedReturn([0, 100])).toBe(0)
  })

  it("is positive for a gaining series", () => {
    expect(annualizedReturn(linearSeries(100, 1, 252))).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
describe("periodReturnPercent", () => {
  it("returns 0 for fewer than 2 values", () => {
    expect(periodReturnPercent([100])).toBe(0)
  })

  it("returns 0 for a flat series", () => {
    expect(periodReturnPercent([100, 100])).toBe(0)
  })

  it("returns 100 when value doubles", () => {
    expect(periodReturnPercent([100, 200])).toBe(100)
  })

  it("returns -50 when value halves", () => {
    expect(periodReturnPercent([200, 100])).toBe(-50)
  })
})

// ---------------------------------------------------------------------------
describe("annualizedReturnWithheldReason", () => {
  it("withholds for < 60 data points", () => {
    expect(annualizedReturnWithheldReason(new Array(59).fill(100), dates(59))).toBe(
      "insufficient_history",
    )
  })

  it("withholds when date span < 90 days", () => {
    const vals = new Array(60).fill(100)
    const ds = dates(60, "2026-01-01") // 60 calendar days, < 90
    expect(annualizedReturnWithheldReason(vals, ds)).toBe("insufficient_history")
  })

  it("returns null for adequate history (>= 60 points, >= 90 calendar days)", () => {
    // 91 calendar days starting 2025-01-01 → 2025-04-01 (= 90-day span > 90)
    const vals = new Array(91).fill(100)
    const ds = dates(91, "2025-01-01")
    expect(annualizedReturnWithheldReason(vals, ds)).toBeNull()
  })

  it("withholds for Infinity values", () => {
    const vals = [...new Array(90).fill(100), Infinity]
    const ds = dates(91, "2025-01-01")
    expect(annualizedReturnWithheldReason(vals, ds)).toBe("invalid_data")
  })
})

// ---------------------------------------------------------------------------
describe("computeRiskMetrics", () => {
  it("returns all-zero-ish metrics for empty / single-value input", () => {
    const m = computeRiskMetrics([], [])
    expect(m.sharpeRatio).toBe(0)
    expect(m.maxDrawdown).toBe(0)
    expect(m.winRate).toBe(0)
    expect(m.volatility).toBe(0)
    expect(m.annualizedReturn).toBeNull() // withheld: insufficient history
  })

  it("withholds annualizedReturn when history is too short", () => {
    const n = 30
    const m = computeRiskMetrics(new Array(n).fill(100), dates(n))
    expect(m.annualizedReturn).toBeNull()
    expect(m.annualizedReturnWithheldReason).toBe("insufficient_history")
  })

  it("provides annualizedReturn for long enough history", () => {
    const n = 252
    const vals = linearSeries(100, 0.5, n)
    const ds = dates(n)
    const m = computeRiskMetrics(vals, ds)
    expect(m.annualizedReturn).not.toBeNull()
    expect(m.annualizedReturnWithheldReason).toBeNull()
  })

  it("positive sharpe/sortino for a steady uptrend", () => {
    const n = 252
    const vals = linearSeries(100, 0.5, n)
    const ds = dates(n)
    const m = computeRiskMetrics(vals, ds)
    expect(m.sharpeRatio).toBeGreaterThan(0)
    expect(m.sortinoRatio).toBeGreaterThan(0)
  })

  it("maxDrawdown is 0 for monotonically increasing series", () => {
    const m = computeRiskMetrics(linearSeries(100, 1, 50), dates(50))
    expect(m.maxDrawdown).toBe(0)
  })

  it("winRate is 100 for monotonically increasing series", () => {
    const m = computeRiskMetrics(linearSeries(100, 1, 50), dates(50))
    expect(m.winRate).toBe(100)
  })
})
