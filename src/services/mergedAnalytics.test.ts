import { describe, expect, it } from "vitest"
import { crossRate } from "@marx2/contracts/fx"
import {
  buildMergedPerformance,
  sumSnapshotsByDate,
  sumSnapshotsByDateForwardFilled,
  type SnapshotRow,
} from "./mergedAnalytics.js"

// EUR-quoted table (D27): the rate callback resolves from→USD cross-rates the
// same way the real service does (plan §48.3 — resolved upstream, passed in).
const TABLE = { USD: 1.08, PLN: 4.3, EUR: 1 }
const RATES = (from: string): number | null => crossRate(from, "USD", TABLE) ?? null
const NULL_RATES = (_from: string): number | null => null

describe("sumSnapshotsByDate (§46.1)", () => {
  it("single portfolio in its own currency == its own series, no FX", () => {
    const rows: SnapshotRow[] = [
      { baseCurrency: "USD", snapshotDate: "2026-01-01", value: 1000, invested: 900 },
      { baseCurrency: "USD", snapshotDate: "2026-01-02", value: 1100, invested: 900 },
    ]
    expect(sumSnapshotsByDate(rows, RATES, "USD")).toEqual([
      { date: "2026-01-01", value: 1000, invested: 900 },
      { date: "2026-01-02", value: 1100, invested: 900 },
    ])
  })

  it("sums USD + PLN portfolios into USD at known rates, grouped by date", () => {
    const rows: SnapshotRow[] = [
      { baseCurrency: "USD", snapshotDate: "2026-01-01", value: 1000, invested: 800 },
      { baseCurrency: "PLN", snapshotDate: "2026-01-01", value: 4300, invested: 4000 },
      { baseCurrency: "USD", snapshotDate: "2026-01-02", value: 1200, invested: 800 },
      { baseCurrency: "PLN", snapshotDate: "2026-01-02", value: 8600, invested: 4000 },
    ]
    // USD rate is 1 (target), PLN→USD = 1.08/4.3 = 0.25116...
    const result = sumSnapshotsByDate(rows, RATES, "USD")
    expect(result).toHaveLength(2)
    expect(result[0].date).toBe("2026-01-01")
    expect(result[0].value).toBeCloseTo(1000 + 4300 * (1.08 / 4.3), 6)
    expect(result[0].invested).toBeCloseTo(800 + 4000 * (1.08 / 4.3), 6)
    expect(result[1].date).toBe("2026-01-02")
    expect(result[1].value).toBeCloseTo(1200 + 8600 * (1.08 / 4.3), 6)
  })

  it("skips rows whose rate is unavailable — never fabricates a 1:1 rate", () => {
    const rows: SnapshotRow[] = [
      { baseCurrency: "USD", snapshotDate: "2026-01-01", value: 1000, invested: 900 },
      { baseCurrency: "ZZZ", snapshotDate: "2026-01-01", value: 5000, invested: 4000 },
    ]
    const result = sumSnapshotsByDate(rows, RATES, "USD")
    expect(result).toEqual([{ date: "2026-01-01", value: 1000, invested: 900 }])
  })

  it("with no rates table at all, only same-currency rows survive", () => {
    const rows: SnapshotRow[] = [
      { baseCurrency: "USD", snapshotDate: "2026-01-01", value: 1000, invested: 900 },
      { baseCurrency: "PLN", snapshotDate: "2026-01-01", value: 4300, invested: 4000 },
    ]
    expect(sumSnapshotsByDate(rows, NULL_RATES, "USD")).toEqual([
      { date: "2026-01-01", value: 1000, invested: 900 },
    ])
  })

  it("empty input → empty series", () => {
    expect(sumSnapshotsByDate([], RATES, "USD")).toEqual([])
  })

  it("returns ascending by date regardless of input order", () => {
    const rows: SnapshotRow[] = [
      { baseCurrency: "USD", snapshotDate: "2026-02-01", value: 2000, invested: 1500 },
      { baseCurrency: "USD", snapshotDate: "2026-01-01", value: 1000, invested: 1500 },
    ]
    expect(sumSnapshotsByDate(rows, RATES, "USD").map((p) => p.date)).toEqual([
      "2026-01-01",
      "2026-02-01",
    ])
  })
})

describe("sumSnapshotsByDateForwardFilled (§63 follow-up)", () => {
  it("carries a portfolio's last value forward when it has no row on a date", () => {
    // B is only snapshotted on day 1 (not yet re-quoted on day 2). The naive
    // sum collapses day 2 to just A; forward-fill keeps B at its last value.
    const rows: SnapshotRow[] = [
      { portfolioId: "A", baseCurrency: "USD", snapshotDate: "2026-01-01", value: 1000, invested: 800 },
      { portfolioId: "B", baseCurrency: "USD", snapshotDate: "2026-01-01", value: 500, invested: 400 },
      { portfolioId: "A", baseCurrency: "USD", snapshotDate: "2026-01-02", value: 1200, invested: 800 },
    ]
    expect(sumSnapshotsByDate(rows, RATES, "USD")).toEqual([
      { date: "2026-01-01", value: 1500, invested: 1200 },
      { date: "2026-01-02", value: 1200, invested: 800 }, // B dropped out
    ])
    expect(sumSnapshotsByDateForwardFilled(rows, RATES, "USD")).toEqual([
      { date: "2026-01-01", value: 1500, invested: 1200 },
      { date: "2026-01-02", value: 1700, invested: 1200 }, // B carried forward
    ])
  })

  it("a portfolio whose first snapshot is after a date contributes 0 there", () => {
    const rows: SnapshotRow[] = [
      { portfolioId: "A", baseCurrency: "USD", snapshotDate: "2026-01-01", value: 1000, invested: 800 },
      { portfolioId: "B", baseCurrency: "USD", snapshotDate: "2026-01-02", value: 300, invested: 300 },
    ]
    expect(sumSnapshotsByDateForwardFilled(rows, RATES, "USD")).toEqual([
      { date: "2026-01-01", value: 1000, invested: 800 },
      { date: "2026-01-02", value: 1300, invested: 1100 },
    ])
  })

  it("converts via FX when carrying values forward", () => {
    const rows: SnapshotRow[] = [
      { portfolioId: "A", baseCurrency: "PLN", snapshotDate: "2026-01-01", value: 4300, invested: 4000 },
      { portfolioId: "B", baseCurrency: "USD", snapshotDate: "2026-01-02", value: 500, invested: 500 },
    ]
    const pln = (1.08 / 4.3)
    const result = sumSnapshotsByDateForwardFilled(rows, RATES, "USD")
    expect(result).toHaveLength(2)
    expect(result[0].value).toBeCloseTo(4300 * pln, 6)
    expect(result[1].value).toBeCloseTo(4300 * pln + 500, 6)
  })

  it("skips rows with unresolvable rates and is empty for empty input", () => {
    const rows: SnapshotRow[] = [
      { portfolioId: "A", baseCurrency: "USD", snapshotDate: "2026-01-01", value: 1000, invested: 800 },
      { portfolioId: "B", baseCurrency: "ZZZ", snapshotDate: "2026-01-02", value: 500, invested: 500 },
    ]
    expect(sumSnapshotsByDateForwardFilled(rows, RATES, "USD")).toEqual([
      { date: "2026-01-01", value: 1000, invested: 800 },
      { date: "2026-01-02", value: 1000, invested: 800 },
    ])
    expect(sumSnapshotsByDateForwardFilled([], RATES, "USD")).toEqual([])
  })

  it("matches the naive sum when every portfolio has a row on every date", () => {
    const rows: SnapshotRow[] = [
      { portfolioId: "A", baseCurrency: "USD", snapshotDate: "2026-01-01", value: 1000, invested: 800 },
      { portfolioId: "B", baseCurrency: "USD", snapshotDate: "2026-01-01", value: 500, invested: 400 },
      { portfolioId: "A", baseCurrency: "USD", snapshotDate: "2026-01-02", value: 1100, invested: 800 },
      { portfolioId: "B", baseCurrency: "USD", snapshotDate: "2026-01-02", value: 600, invested: 400 },
    ]
    expect(sumSnapshotsByDateForwardFilled(rows, RATES, "USD")).toEqual(sumSnapshotsByDate(rows, RATES, "USD"))
  })
})

describe("buildMergedPerformance (§46.1)", () => {
  it("derives totalValue/totalInvested/totalReturn from the last point", () => {
    const perf = buildMergedPerformance([
      { date: "2026-01-01", value: 1000, invested: 800 },
      { date: "2026-01-02", value: 1200, invested: 800 },
    ])
    expect(perf.totalValue).toBe(1200)
    expect(perf.totalInvested).toBe(800)
    expect(perf.totalReturn).toBe(400)
    expect(perf.totalReturnPercent).toBeCloseTo(50, 6)
    expect(perf.timeSeries).toEqual([
      { date: "2026-01-01", value: 1000 },
      { date: "2026-01-02", value: 1200 },
    ])
    expect(perf.monthlyReturns).toEqual([])
    expect(perf.timeWeightedReturn).toBeNull()
    expect(perf.moneyWeightedReturn).toBeNull()
    expect(perf.simpleReturnPercent).toBeUndefined()
  })

  it("empty series → zeros", () => {
    const perf = buildMergedPerformance([])
    expect(perf.totalValue).toBe(0)
    expect(perf.totalInvested).toBe(0)
    expect(perf.totalReturn).toBe(0)
    expect(perf.totalReturnPercent).toBe(0)
    expect(perf.timeSeries).toEqual([])
  })
})