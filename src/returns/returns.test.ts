/**
 * returns.test.ts — known-value proof for the single returns engine.
 *
 * Every figure is checked against an independently known answer (a textbook
 * example, the `xirr` package's own published vectors, or a hand-computed
 * value), never against another function in this module. That is the point:
 * the engine is only trustworthy if it reproduces answers the world already
 * agrees on.
 */
import { describe, expect, it } from "vitest"
import {
  buildSimple,
  buildDailyReturns,
  chainReturns,
  buildTwr,
  xirr,
  moneyWeightedRate,
  buildMwr,
  annualizedReturn,
  periodReturnPercent,
  annualizedReturnWithheldReason,
  buildMonthlyReturns,
} from "./index.js"

describe("buildSimple", () => {
  it("indexes from the first value (100 at t0)", () => {
    expect(buildSimple([50, 100, 75])).toEqual([100, 200, 150])
  })
  it("returns a flat 100 index when the first value is 0", () => {
    expect(buildSimple([0, 10])).toEqual([100, 100])
  })
})

describe("buildDailyReturns / buildTwr (TWR, library-backed)", () => {
  it("removes a mid-period deposit from the return (flow-neutral 25% then −20%)", () => {
    // 100 → 150 with a 20 deposit, then → 120. r1 = (150−100−20)/(100+20)=0.25,
    // r2 = (120−150)/150 = −0.20. Chained: 1.25 × 0.80 = 1.0 → 0% total.
    const values = [100, 150, 120]
    const flows = [0, 20, 0]
    const r = buildDailyReturns(values, flows)
    expect(r[0]).toBeCloseTo(0.25, 10)
    expect(r[1]).toBeCloseTo(-0.2, 10)
    const twr = buildTwr(values, flows)
    expect(twr[0]).toBe(100)
    expect(twr[2]).toBeCloseTo(100, 6)
  })

  it("a deposit-only rise is a 0% TWR (no market move)", () => {
    const twr = buildTwr([100, 150], [0, 50])
    expect(twr[1]).toBeCloseTo(100, 6)
  })

  it("chains sub-period returns into an index starting at 1", () => {
    expect(chainReturns([0.1, -0.5])).toEqual([1, 1.1, 0.55])
  })
})

describe("xirr (library-backed) — published known vectors", () => {
  it("one-year +10% → 0.10", () => {
    const r = xirr([-1000, 1100], ["2021-01-01", "2022-01-01"])
    expect(r).not.toBeNull()
    expect(r!).toBeCloseTo(0.1, 4)
  })

  it("one-year −10% → −0.10", () => {
    const r = xirr([-1000, 900], ["2021-01-01", "2022-01-01"])
    expect(r!).toBeCloseTo(-0.1, 4)
  })

  it("one-year +200% → 2.0", () => {
    const r = xirr([-1000, 3000], ["2021-01-01", "2022-01-01"])
    expect(r!).toBeCloseTo(2.0, 4)
  })

  it("matches the popular-spreadsheet quarterly-deposit example → 0.121268", () => {
    const dates = ["2010-01-01", "2010-04-01", "2010-07-01", "2010-10-01", "2011-01-01"]
    const r = xirr([-1000, -1000, -1000, -1000, 4300], dates)
    expect(r!).toBeCloseTo(0.121268, 5)
  })

  it("returns null for one-sided flows (cannot solve)", () => {
    expect(xirr([-1000, -500], ["2021-01-01", "2022-01-01"])).toBeNull()
    expect(xirr([1000, 500], ["2021-01-01", "2022-01-01"])).toBeNull()
  })

  it("returns null when every flow is on one day", () => {
    expect(xirr([-1000, 1100], ["2021-01-01", "2021-01-01"])).toBeNull()
  })
})

describe("moneyWeightedRate — annualised XIRR", () => {
  it("one-year +10% → 0.10 (annualised, not the period index)", () => {
    const r = moneyWeightedRate([1000, 1100], [0, 0], ["2021-01-01", "2022-01-01"])
    expect(r!).toBeCloseTo(0.1, 4)
  })

  it("is withheld (null) on an absurd near-zero-capital history", () => {
    const dates = ["2024-01-01", "2024-04-01", "2024-07-01", "2025-01-01"]
    const values = [1, 1, 1, 20_000_001]
    const flows = [0, 0, 10_000, 0]
    expect(moneyWeightedRate(values, flows, dates)).toBeNull()
  })

  it("stays finite and plausible on a healthy multi-year history (no 183% style blow-up)", () => {
    // 100 → 300 over two years with a mid deposit: a believable annualised rate.
    const dates = ["2023-01-01", "2023-07-01", "2024-01-01", "2024-07-01", "2025-01-01"]
    const values = [100, 150, 200, 250, 300]
    const flows = [0, 0, 50, 0, 0]
    const r = moneyWeightedRate(values, flows, dates)
    expect(r).not.toBeNull()
    expect(Math.abs(r!)).toBeLessThan(2)
  })
})

describe("buildMwr — de-annualised index", () => {
  it("healthy mixed-flow history yields a real MWR (not the simple fallback)", () => {
    const dates = ["2024-01-01", "2024-04-01", "2024-07-01", "2024-10-01", "2025-01-01"]
    const values = [100, 105, 205, 210, 215]
    const flows = [0, 0, 100, 0, 0]
    const mwr = buildMwr(values, flows, dates)
    expect(mwr[0]).toBe(100)
    expect(mwr[4]).toBeCloseTo(110.06, 0)
    expect(mwr[2]).toBeCloseTo(104.88, 0)
  })

  it("absurd near-zero-capital history stays finite and falls back to simple", () => {
    const dates = ["2024-01-01", "2024-04-01", "2024-07-01", "2025-01-01"]
    const values = [1, 1, 1, 20_000_001]
    const flows = [0, 0, 10_000, 0]
    const mwr = buildMwr(values, flows, dates)
    for (const v of mwr) {
      expect(Number.isFinite(v)).toBe(true)
      expect(Math.abs(v)).toBeLessThan(1e12)
    }
    expect(mwr).toEqual(buildSimple(values))
  })
})

describe("annualizedReturn / withholding", () => {
  it("rescales a sub-year window to a year", () => {
    // 10% over 90 days → (1.1)^(365/90) − 1.
    const index = [1, 1.1]
    const dates = ["2024-01-01", "2024-03-31"] // 90 days
    expect(annualizedReturn(index, dates)).toBeCloseTo((1.1 ** (365 / 90) - 1), 6)
  })

  it("periodReturnPercent is the whole-window return", () => {
    expect(periodReturnPercent([1, 1.25])).toBeCloseTo(25, 6)
  })

  it("withholds on short history and invalid data", () => {
    expect(annualizedReturnWithheldReason([1, 1.1], ["2024-01-01", "2024-01-02"])).toBe(
      "insufficient_history",
    )
    expect(
      annualizedReturnWithheldReason(new Array(60).fill(1).concat([NaN]), new Array(61).fill("2024-01-01")),
    ).toBe("invalid_data")
    const longDates = Array.from({ length: 100 }, (_, i) => {
      const d = new Date(Date.UTC(2024, 0, 1 + i))
      return d.toISOString().slice(0, 10)
    })
    expect(annualizedReturnWithheldReason(new Array(100).fill(1), longDates)).toBeNull()
  })
})

describe("buildMonthlyReturns", () => {
  it("month-over-month growth of the TWR index", () => {
    const series = [
      { date: "2024-01-31", cumulativeTwr: 100 },
      { date: "2024-02-29", cumulativeTwr: 110 },
      { date: "2024-03-31", cumulativeTwr: 99 },
    ]
    const out = buildMonthlyReturns(series)
    expect(out[0]).toEqual({ month: "2024-01", returnPercent: 0 })
    expect(out[1]).toEqual({ month: "2024-02", returnPercent: 10 })
    expect(out[2].returnPercent).toBeCloseTo(-10, 6)
  })
})