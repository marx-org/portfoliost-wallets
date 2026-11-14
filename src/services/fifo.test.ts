import { describe, expect, it } from "vitest"
import {
  averageFromLots,
  fifoApplies,
  lotsFromRows,
  quantityFromLots,
  realizedFromDraws,
} from "./fifo.js"
import type { LotDraw, OpenLot } from "./openLots.js"

const at = (iso: string) => new Date(iso)

describe("FIFO sale arithmetic", () => {
  it("books each unit against the lot it came from", () => {
    const draws: LotDraw[] = [
      { txId: "buy-10", price: 10, remaining: 4, quantity: 4, openedAt: at("2024-01-01") },
      { txId: "buy-12", price: 12, remaining: 2, quantity: 1, openedAt: at("2024-01-02") },
    ]
    expect(realizedFromDraws(draws, 15, 0)).toBe(23)
    // The moving average would have booked (15 − 10.80) × 5 = 21.
  })

  it("keeps the weighted cost of the undrawn lots", () => {
    const remaining: OpenLot[] = [
      { txId: "buy-10", price: 10, remaining: 0, openedAt: at("2024-01-01") },
      { txId: "buy-12", price: 12, remaining: 1, openedAt: at("2024-01-02") },
    ].filter((lot) => lot.remaining > 0)
    expect(quantityFromLots(remaining)).toBe(1)
    expect(averageFromLots(remaining)).toBe(12)
  })

  it("excludes short-option premium lots from FIFO", () => {
    expect(fifoApplies({ assetType: "STOCK", direction: null })).toBe(true)
    expect(fifoApplies({ assetType: "STOCK", direction: "LONG" })).toBe(true)
    expect(fifoApplies({ assetType: "OPTION", direction: "SHORT" })).toBe(false)
    expect(fifoApplies({ assetType: "STOCK", direction: "SHORT" })).toBe(false)
  })

  it("folds an imported buy's fee into that lot's cost", () => {
    const lots = lotsFromRows(
      [
        {
          id: "buy",
          type: "BUY",
          executedAt: at("2024-01-01"),
          quantity: 10,
          price: 100,
          originalQuantity: 10,
          originalPrice: 100,
          externalId: "row-1",
          externalSource: "google-sheets:transakcje",
          feesSettled: 19,
          feesType: "fixed",
          feeCurrency: "PLN",
          currency: "USD",
          convertedFees: 19,
          exchangeRate: 4.7975,
        },
      ],
      () => 1,
    )
    expect(lots).toHaveLength(1)
    // (10 × 100 + 19 / 4.7975) / 10 = 100.39604...
    expect(lots[0].price).toBeCloseTo(100.39604, 5)
  })

  it("does not fold a fee into an interactive buy, matching its average", () => {
    const lots = lotsFromRows(
      [
        {
          id: "buy",
          type: "BUY",
          executedAt: at("2024-01-01"),
          quantity: 10,
          price: 150,
          originalQuantity: 10,
          originalPrice: 150,
          externalId: null,
          externalSource: null,
          feesSettled: 4.99,
          feesType: "fixed",
          feeCurrency: "USD",
          currency: "USD",
          convertedFees: 4.99,
          exchangeRate: 1,
        },
      ],
      () => 1,
    )
    expect(lots[0].price).toBe(150)
  })
})