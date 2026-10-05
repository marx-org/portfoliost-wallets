import { describe, expect, it } from "vitest"
import { openLots, drawLots, openQuantity, type LotTx } from "./openLots.js"

const day = (d: string) => new Date(`${d}T12:00:00Z`)

function tx(over: Partial<LotTx> & Pick<LotTx, "id" | "type">): LotTx {
  return {
    executedAt: day("2026-01-01"),
    quantity: "0",
    price: "0",
    originalQuantity: null,
    originalPrice: null,
    ...over,
  }
}

const noSplit = () => 1

describe("openLots — the queue is a pure function of the rows", () => {
  it("is a moving-average-free replay: two buys stay two lots", () => {
    const lots = openLots(
      [
        tx({ id: "b1", type: "BUY", executedAt: day("2026-01-01"), quantity: "4", price: "10" }),
        tx({ id: "b2", type: "BUY", executedAt: day("2026-02-01"), quantity: "6", price: "12" }),
      ],
      noSplit,
    )
    expect(lots).toHaveLength(2)
    expect(lots[0]).toMatchObject({ txId: "b1", price: 10, remaining: 4 })
    expect(lots[1]).toMatchObject({ txId: "b2", price: 12, remaining: 6 })
    expect(openQuantity(lots)).toBe(10)
  })

  it("a SELL consumes FIFO, not pro-rata", () => {
    const lots = openLots(
      [
        tx({ id: "b1", type: "BUY", executedAt: day("2026-01-01"), quantity: "4", price: "10" }),
        tx({ id: "b2", type: "BUY", executedAt: day("2026-02-01"), quantity: "6", price: "12" }),
        tx({ id: "s1", type: "SELL", executedAt: day("2026-03-01"), quantity: "5", price: "15" }),
      ],
      noSplit,
    )
    // 5 shares consumed FIFO: b1's 4 are taken whole and only 1 comes off b2,
    // so b2 keeps 5. A weighted average could not tell you that — which lot the
    // sale touched is the entire point.
    expect(lots).toEqual([{ txId: "b2", price: 12, remaining: 5, openedAt: day("2026-02-01") }])
  })

  it("EXPIRATION and TRANSFER_OUT consume; DIVIDEND is ignored", () => {
    const lots = openLots(
      [
        tx({ id: "b1", type: "BUY", executedAt: day("2026-01-01"), quantity: "10", price: "10" }),
        tx({ id: "d1", type: "DIVIDEND", executedAt: day("2026-02-01"), quantity: "10", price: "1" }),
        tx({ id: "e1", type: "EXPIRATION", executedAt: day("2026-03-01"), quantity: "3" }),
        tx({ id: "x1", type: "TRANSFER_OUT", executedAt: day("2026-04-01"), quantity: "2" }),
      ],
      noSplit,
    )
    expect(lots).toEqual([{ txId: "b1", price: 10, remaining: 5, openedAt: day("2026-01-01") }])
  })

  it("TRANSFER_IN opens a lot at the source lot's price", () => {
    const lots = openLots(
      [
        tx({ id: "xi", type: "TRANSFER_IN", executedAt: day("2026-02-01"), quantity: "4.5", price: "31.25" }),
      ],
      noSplit,
    )
    expect(lots[0]).toMatchObject({ txId: "xi", price: 31.25, remaining: 4.5 })
  })

  it("a same-day tiebreak draws in id order, which is what makes suffixes stable", () => {
    const same = day("2026-01-01")
    const lots = openLots(
      [
        tx({ id: "b2", type: "BUY", executedAt: same, quantity: "6", price: "12" }),
        tx({ id: "b1", type: "BUY", executedAt: same, quantity: "4", price: "10" }),
      ],
      noSplit,
    )
    expect(lots.map((l) => l.txId)).toEqual(["b1", "b2"])
    // Input order must not matter.
    const reversed = openLots(
      [
        tx({ id: "b1", type: "BUY", executedAt: same, quantity: "4", price: "10" }),
        tx({ id: "b2", type: "BUY", executedAt: same, quantity: "6", price: "12" }),
      ],
      noSplit,
    )
    expect(reversed.map((l) => l.txId)).toEqual(["b1", "b2"])
  })

  it("uses restated quantity and price for a lot split since it was opened", () => {
    // A 10-lot bought at 5.00, 2:1 split → 20 @ 2.50.
    const lots = openLots(
      [
        tx({
          id: "b1", type: "BUY", executedAt: day("2026-01-01"),
          quantity: "20", price: "2.5",
          originalQuantity: "10", originalPrice: "5",
        }),
      ],
      () => 2,
    )
    expect(lots[0]).toMatchObject({ price: 2.5, remaining: 20 })
  })

  it("a lot that has NOT split falls back to its plain quantity", () => {
    const lots = openLots(
      [
        tx({
          id: "b1", type: "BUY", executedAt: day("2026-01-01"),
          quantity: "10", price: "5",
          originalQuantity: "10", originalPrice: "5",
        }),
      ],
      () => 1,
    )
    expect(lots[0]).toMatchObject({ price: 5, remaining: 10 })
  })

  it("consumption never goes negative", () => {
    const lots = openLots(
      [
        tx({ id: "b1", type: "BUY", executedAt: day("2026-01-01"), quantity: "2", price: "10" }),
        tx({ id: "s1", type: "SELL", executedAt: day("2026-02-01"), quantity: "9", price: "15" }),
      ],
      noSplit,
    )
    expect(lots).toEqual([])
  })
})

describe("drawLots — the owner's partial cases", () => {
  it("one transfer across two lots is two draws at their own prices", () => {
    const lots = openLots(
      [
        tx({ id: "b1", type: "BUY", executedAt: day("2026-01-01"), quantity: "4", price: "10" }),
        tx({ id: "b2", type: "BUY", executedAt: day("2026-02-01"), quantity: "1", price: "12" }),
      ],
      noSplit,
    )
    const { draws, shortfall } = drawLots(lots, 5)
    expect(shortfall).toBe(0)
    expect(draws).toHaveLength(2)
    expect(draws[0]).toMatchObject({ txId: "b1", quantity: 4, price: 10 })
    expect(draws[1]).toMatchObject({ txId: "b2", quantity: 1, price: 12 })
    // Explicitly NOT one row at 10.80.
    expect(draws).not.toHaveLength(1)
  })

  it("one lot across two transfers: 4.0 then 0.5 from the 4.5 remainder", () => {
    const lots = openLots(
      [
        tx({ id: "b1", type: "BUY", executedAt: day("2026-01-01"), quantity: "4.5", price: "20" }),
      ],
      noSplit,
    )
    const first = drawLots(lots, 4)
    expect(first.draws).toHaveLength(1)
    expect(first.shortfall).toBe(0)

    // Re-read the queue as the next import would, now the lot has moved once.
    const after = openLots(
      [
        tx({ id: "b1", type: "BUY", executedAt: day("2026-01-01"), quantity: "4.5", price: "20" }),
        tx({ id: "x1", type: "TRANSFER_OUT", executedAt: day("2026-02-01"), quantity: "4", price: "20" }),
      ],
      noSplit,
    )
    expect(after).toEqual([{ txId: "b1", price: 20, remaining: 0.5, openedAt: day("2026-01-01") }])
    const second = drawLots(after, 0.5)
    expect(second.draws).toHaveLength(1)
    expect(second.draws[0]).toMatchObject({ txId: "b1", quantity: 0.5, price: 20 })
    expect(second.shortfall).toBe(0)
  })

  it("reports a shortfall instead of moving less than asked", () => {
    const lots = openLots(
      [tx({ id: "b1", type: "BUY", executedAt: day("2026-01-01"), quantity: "2", price: "10" })],
      noSplit,
    )
    const { draws, shortfall } = drawLots(lots, 5)
    expect(draws).toHaveLength(1)
    expect(shortfall).toBe(3)
  })

  it("a draw reports the lot's pre-draw remaining, so provenance stays auditable", () => {
    const lots = openLots(
      [tx({ id: "b1", type: "BUY", executedAt: day("2026-01-01"), quantity: "9", price: "10" })],
      noSplit,
    )
    const { draws } = drawLots(lots, 3)
    expect(draws[0].remaining).toBe(9)
    expect(draws[0].quantity).toBe(3)
  })
})