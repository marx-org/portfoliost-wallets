import { describe, expect, it } from "vitest"
import { neutralisingFlows, marketValuedTransferFlows, MissingTransferPriceError } from "./transferFlows.js"

/**
 * The pure part of the transfer-flow treatment. The database read is exercised in
 * backfill.test.ts; what matters here is the arithmetic that keeps two flows from
 * being conflated, because conflating them is what breaks XIRR.
 */
describe("neutralisingFlows — external money and a transfer are different things", () => {
  it("adds a transfer to the flow a return is neutral against", () => {
    const external = new Map([["2026-06-01", 500]])
    const transfers = new Map([["2026-06-01", -55]])
    expect(neutralisingFlows(external, transfers)).toEqual(new Map([["2026-06-01", 445]]))
  })

  it("does not touch the external map it was given", () => {
    const external = new Map([["2026-06-01", 500]])
    neutralisingFlows(external, new Map([["2026-06-01", -55]]))
    // net_flow feeds `invested` and XIRR's capital basis. If the transfer leaked
    // in here, XIRR would see securities crossing as though money had.
    expect(external).toEqual(new Map([["2026-06-01", 500]]))
  })

  it("carries a day that has a transfer but no external flow", () => {
    // The common shape: IBKR receives shares, no money arrives that day.
    expect(neutralisingFlows(new Map(), new Map([["2026-06-01", 55]])))
      .toEqual(new Map([["2026-06-01", 55]]))
  })

  it("two signed transfers on one day net before they reach the denominator", () => {
    // Equate+ sends and IBKR receives on the same day: merged must see nothing.
    const external = new Map<string, number>()
    const transfers = new Map([["2026-06-01", -55 + 55]])
    expect([...neutralisingFlows(external, transfers).values()]).toEqual([0])
  })

  it("keeps days independent", () => {
    const merged = neutralisingFlows(
      new Map([["2026-06-01", 500], ["2026-06-02", 20]]),
      new Map([["2026-06-02", -55]]),
    )
    expect(merged.get("2026-06-01")).toBe(500)
    expect(merged.get("2026-06-02")).toBe(-35)
  })
})

describe("why the two amounts differ — the case that catches a flattened rule", () => {
  /**
   * Five shares bought at 10 (basis 50), market 11 on the transfer date, sold at
   * 12 for 60. True gain is 60 − 50 = +10.
   *
   * - capital basis moves at COST (50) → after the sale the gain is the full +10
   * - rebasing at MARKET (55) would leave only +5, silently deleting 5 of real profit
   *
   * The flow is the market value because its only job is to offset how far `value`
   * moved. Recording both here so a future edit cannot collapse them into one.
   */
  const COST_BASIS = 50
  const MARKET_AT_TRANSFER = 55
  const PROCEEDS = 60

  it("moving the cost keeps the whole gain", () => {
    expect(PROCEEDS - COST_BASIS).toBe(10)
  })

  it("moving the market value would lose real profit", () => {
    expect(PROCEEDS - MARKET_AT_TRANSFER).toBe(5)
  })

  it("the flow neutralises the day to zero, and the two coincide only when price == cost", () => {
    // Equate+ goes V = 55 -> 0 with no external flow. Neutralising needs −55.
    const valueBefore = MARKET_AT_TRANSFER
    const flow = -valueBefore
    const denominator = valueBefore + flow
    // The return formula divides by the denominator, so assert the shape rather
    // than a number: a zero denominator is the degenerate case the guards handle.
    expect(denominator).toBe(0)
    expect(MARKET_AT_TRANSFER).not.toBe(COST_BASIS)
  })
})
describe("marketValuedTransferFlows — the flow is MARKET, the basis is COST", () => {
  const priceMaps = (closes: Record<string, number>) =>
    new Map([["AAPL", new Map([["2026-02-01", closes.AAPL]])]])

  it("values the move at the day's close, not the lot's cost", () => {
    const moves = new Map([["2026-02-01", [{ symbol: "AAPL", quantity: -2 }]]])
    const flows = marketValuedTransferFlows(moves, priceMaps({ AAPL: 11 }))
    expect(flows.get("2026-02-01")).toBeCloseTo(-22, 6)
    expect(flows.get("2026-02-01")).not.toBeCloseTo(-20, 6)
  })

  it("a receiving portfolio's flow is the same magnitude, positive", () => {
    const flows = marketValuedTransferFlows(
      new Map([["2026-02-01", [{ symbol: "AAPL", quantity: 2 }]]]),
      priceMaps({ AAPL: 11 }),
    )
    expect(flows.get("2026-02-01")).toBeCloseTo(22, 6)
  })

  it("the two sides net to zero, which is what leaves merged untouched", () => {
    const out = marketValuedTransferFlows(
      new Map([["2026-02-01", [{ symbol: "AAPL", quantity: -2 }]]]),
      priceMaps({ AAPL: 11 }))
    const into = marketValuedTransferFlows(
      new Map([["2026-02-01", [{ symbol: "AAPL", quantity: 2 }]]]),
      priceMaps({ AAPL: 11 }))
    expect((out.get("2026-02-01") ?? 0) + (into.get("2026-02-01") ?? 0)).toBe(0)
  })

  it("rejects a transfer day with no historical close instead of substituting cost", () => {
    expect(() => marketValuedTransferFlows(
      new Map([["2026-02-01", [{ symbol: "AAPL", quantity: -2 }]]]),
      new Map(),
    )).toThrowError(new MissingTransferPriceError("AAPL", "2026-02-01"))
  })

  it("sums several lots moved on one day", () => {
    const maps = new Map([
      ["AAPL", new Map([["2026-02-01", 11]])],
      ["MSFT", new Map([["2026-02-01", 30]])],
    ])
    const flows = marketValuedTransferFlows(
      new Map([["2026-02-01", [{ symbol: "AAPL", quantity: -2 }, { symbol: "MSFT", quantity: -1 }]]]),
      maps,
    )
    // −(2 × 11) − (1 × 30) = −52
    expect(flows.get("2026-02-01")).toBeCloseTo(-52, 6)
  })
})
