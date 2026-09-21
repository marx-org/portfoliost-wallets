import { describe, expect, it } from "vitest"
import { buildMergedPerformance, sumSnapshotsByDate, type SnapshotRow } from "./mergedAnalytics.js"

const RATES: Record<string, number> = { USD: 1.08, PLN: 4.3, EUR: 1 } // 1 EUR = ...

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
    expect(sumSnapshotsByDate(rows, null, "USD")).toEqual([
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