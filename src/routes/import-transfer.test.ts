import { describe, expect, it } from "vitest"
import { and, eq } from "drizzle-orm"
import { makeHarness, type Harness } from "./test-utils.js"
import { Hono } from "hono"
import { createImportRoutes } from "./import.js"
import { portfolioTransactions, positions, portfolios } from "../db/schema.js"

async function boot() {
  const h = await makeHarness()
  const app = new Hono().route("/api/import", createImportRoutes(h.db))
  return { ...h, app }
}

async function seedPortfolio(h: Harness, name: string) {
  const id = crypto.randomUUID()
  await h.db.insert(portfolios).values({ userId: "user-1", id, name, baseCurrency: "PLN" })
  return id
}

function post(h: Harness, transactions: Record<string, unknown>[]) {
  return h.app.request("/api/import/transactions", {
    method: "POST",
    headers: { ...h.headers, "content-type": "application/json" },
    body: JSON.stringify({
      source: { externalSource: "google-sheets:transakcje", spreadsheetId: "spr-1", sheet: "tx" },
      transactions,
    }),
  })
}

function buy(
  portfolioId: string,
  portfolioName: string,
  externalId: string,
  executedAt: string,
  quantity: number,
  price: number,
) {
  return {
    externalId,
    portfolioName,
    executedAt,
    portfolioTx: {
      portfolioId,
      type: "BUY",
      instrumentSymbol: "AAPL",
      assetType: "STOCK",
      quantity,
      price,
      currency: "USD",
      executedAt,
    },
  }
}

function transferRow(
  portfolioId: string,
  portfolioName: string,
  toPortfolioName: string,
  quantity: number,
  executedAt = "2026-06-01T12:00:00Z",
  externalId = "x-1",
) {
  return {
    externalId,
    portfolioName,
    executedAt,
    portfolioTx: {
      portfolioId,
      type: "TRANSFER_OUT",
      toPortfolioName,
      instrumentSymbol: "AAPL",
      assetType: "STOCK",
      quantity,
      currency: "USD",
      executedAt,
    },
  }
}

async function txsFor(h: Harness, portfolioId: string) {
  return h.db
    .select()
    .from(portfolioTransactions)
    .where(eq(portfolioTransactions.portfolioId, portfolioId))
    .orderBy(portfolioTransactions.createdAt)
}

async function positionFor(h: Harness, portfolioId: string) {
  const [p] = await h.db
    .select()
    .from(positions)
    .where(and(eq(positions.portfolioId, portfolioId), eq(positions.symbol, "AAPL")))
  return p
}

async function body(res: Response) {
  return (await res.json()) as {
    inserted?: number
    errors?: { externalId: string; error: string }[]
    issues?: unknown[]
  }
}

describe("an in-kind transfer draws FIFO and keeps each lot's price", () => {
  it("one transfer across two lots is two rows at their own prices", async () => {
    const h = await boot()
    const from = await seedPortfolio(h, "Equate+")
    const to = await seedPortfolio(h, "IBKR")

    await post(h, [
      buy(from, "Equate+", "b1", "2026-01-01T12:00:00Z", 4, 10),
      buy(from, "Equate+", "b2", "2026-02-01T12:00:00Z", 1, 12),
    ])
    const res = await post(h, [transferRow(from, "Equate+", "IBKR", 5)])
    const b = await body(res)
    expect(b.errors ?? []).toEqual([])

    const outs = (await txsFor(h, from)).filter((t) => t.type === "TRANSFER_OUT")
    expect(outs).toHaveLength(2)
    // FIFO: 4 off the 10.00 lot, 1 off the 12.00 lot. Explicitly not one row.
    expect(outs.map((o) => [Number(o.quantity), Number(o.price)])).toEqual([[4, 10], [1, 12]])

    const ins = (await txsFor(h, to)).filter((t) => t.type === "TRANSFER_IN")
    expect(ins).toHaveLength(2)
    expect(ins.map((i) => [Number(i.quantity), Number(i.price)])).toEqual([[4, 10], [1, 12]])
  })

  it("records the source BUY on each TRANSFER_OUT, and nothing was disposed of", async () => {
    const h = await boot()
    const from = await seedPortfolio(h, "Equate+")
    const to = await seedPortfolio(h, "IBKR")
    await post(h, [
      buy(from, "Equate+", "b1", "2026-01-01T12:00:00Z", 4, 10),
      buy(from, "Equate+", "b2", "2026-02-01T12:00:00Z", 1, 12),
    ])
    await post(h, [transferRow(from, "Equate+", "IBKR", 5)])

    const srcBuys = (await txsFor(h, from)).filter((t) => t.type === "BUY")
    const outs = (await txsFor(h, from)).filter((t) => t.type === "TRANSFER_OUT")
    expect(outs[0].sourceTransactionId).toBe(srcBuys[0].id)
    expect(outs[1].sourceTransactionId).toBe(srcBuys[1].id)
    // A transfer is not a sale: no realised P/L on any leg.
    for (const leg of [...outs, ...(await txsFor(h, to))]) {
      expect(leg.realizedGainLoss).toBeNull()
    }
  })

  it("pairs the legs both ways under one transfer group", async () => {
    const h = await boot()
    const from = await seedPortfolio(h, "Equate+")
    const to = await seedPortfolio(h, "IBKR")
    await post(h, [buy(from, "Equate+", "b1", "2026-01-01T12:00:00Z", 4, 10), buy(from, "Equate+", "b2", "2026-02-01T12:00:00Z", 1, 12)])
    await post(h, [transferRow(from, "Equate+", "IBKR", 5)])

    const outs = (await txsFor(h, from)).filter((t) => t.type === "TRANSFER_OUT")
    const ins = (await txsFor(h, to)).filter((t) => t.type === "TRANSFER_IN")
    expect(outs[0].transferGroupId).toBe(outs[1].transferGroupId)
    expect(ins[0].transferGroupId).toBe(outs[0].transferGroupId)
    for (const [o, i] of outs.map((o, n) => [o, ins[n]])) {
      expect(i.linkedTransferId).toBe(o.id)
      expect(o.linkedTransferId).toBe(i.id)
    }
  })

  it("the cost basis travels unchanged, so both sides hold the same average", async () => {
    const h = await boot()
    const from = await seedPortfolio(h, "Equate+")
    const to = await seedPortfolio(h, "IBKR")
    await post(h, [buy(from, "Equate+", "b1", "2026-01-01T12:00:00Z", 4, 10), buy(from, "Equate+", "b2", "2026-02-01T12:00:00Z", 1, 12)])
    await post(h, [transferRow(from, "Equate+", "IBKR", 5)])

    const src = await positionFor(h, from)
    const dst = await positionFor(h, to)
    expect(Number(src.averageCostBasis)).toBe(Number(dst.averageCostBasis))
    expect(Number(dst.averageCostBasis)).toBeCloseTo(10.4, 6)
    expect(Number(src.quantity)).toBe(0)
    expect(Number(dst.quantity)).toBe(5)
  })

  it("a partial transfer leaves the remainder, and a second transfer draws it", async () => {
    const h = await boot()
    const from = await seedPortfolio(h, "Equate+")
    const to = await seedPortfolio(h, "IBKR")
    // The owner's case: 4.5 in one lot, drawn 4.0 then 0.5.
    await post(h, [buy(from, "Equate+", "b1", "2026-01-01T12:00:00Z", 4.5, 20)])

    await post(h, [transferRow(from, "Equate+", "IBKR", 4, "2026-02-01T12:00:00Z")])
    expect(Number((await positionFor(h, from)).quantity)).toBe(0.5)

    await post(h, [
      transferRow(from, "Equate+", "IBKR", 0.5, "2026-03-01T12:00:00Z", "x-2"),
    ])
    expect(Number((await positionFor(h, from)).quantity)).toBe(0)
    expect(Number((await positionFor(h, to)).quantity)).toBe(4.5)
    expect(Number((await positionFor(h, to)).averageCostBasis)).toBeCloseTo(20, 6)
  })

  it("re-importing the same row inserts nothing", async () => {
    const h = await boot()
    const from = await seedPortfolio(h, "Equate+")
    const to = await seedPortfolio(h, "IBKR")
    await post(h, [buy(from, "Equate+", "b1", "2026-01-01T12:00:00Z", 4, 10), buy(from, "Equate+", "b2", "2026-02-01T12:00:00Z", 1, 12)])
    await post(h, [transferRow(from, "Equate+", "IBKR", 5)])
    const first = (await txsFor(h, from)).filter((t) => t.type === "TRANSFER_OUT").map((t) => t.externalId)

    const b = await body(await post(h, [transferRow(from, "Equate+", "IBKR", 5)]))
    expect(b.inserted ?? 0).toBe(0)
    const second = (await txsFor(h, from)).filter((t) => t.type === "TRANSFER_OUT").map((t) => t.externalId)
    // Byte-identical suffixes, so the insert-only sync cannot orphan the group.
    expect(second).toEqual(first)
  })
})

describe("a transfer that cannot be satisfied inserts nothing", () => {
  it("rejects a quantity above the open lots and writes no row", async () => {
    const h = await boot()
    const from = await seedPortfolio(h, "Equate+")
    const to = await seedPortfolio(h, "IBKR")
    await post(h, [buy(from, "Equate+", "b1", "2026-01-01T12:00:00Z", 2, 10)])

    const b = await body(await post(h, [transferRow(from, "Equate+", "IBKR", 5)]))
    expect(b.errors?.[0]?.error).toBe("transfer_exceeds_open_lots")
    expect((await txsFor(h, from)).filter((t) => t.type === "TRANSFER_OUT")).toHaveLength(0)
    expect(await txsFor(h, to)).toHaveLength(0)
    expect(Number((await positionFor(h, from)).quantity)).toBe(2)
  })

  it("rejects an unknown target and a target equal to the source", async () => {
    const h = await boot()
    const from = await seedPortfolio(h, "Equate+")
    await post(h, [buy(from, "Equate+", "b1", "2026-01-01T12:00:00Z", 2, 10)])

    expect((await body(await post(h, [transferRow(from, "Equate+", "Nowhere", 1)]))).errors?.[0]?.error)
      .toBe("transfer_target_not_found")
    expect((await body(await post(h, [transferRow(from, "Equate+", "Equate+", 1)]))).errors?.[0]?.error)
      .toBe("transfer_target_is_source")
    expect((await body(await post(h, [transferRow(from, "Equate+", undefined!, 1)]))).errors?.[0]?.error)
      .toBe("transfer_missing_counterparty")
  })

  it("rejects a transfer of a symbol the source does not hold", async () => {
    const h = await boot()
    const from = await seedPortfolio(h, "Equate+")
    const to = await seedPortfolio(h, "IBKR")
    const b = await body(
      await post(h, [
        {
          externalId: "x-1",
          portfolioName: "Equate+",
          executedAt: "2026-06-01T12:00:00Z",
          portfolioTx: {
            portfolioId: from, type: "TRANSFER_OUT", toPortfolioName: "IBKR",
            instrumentSymbol: "TSLA", assetType: "STOCK", quantity: 1,
            currency: "USD", executedAt: "2026-06-01T12:00:00Z",
          },
        },
      ]),
    )
    expect(b.errors?.[0]?.error).toBe("transfer_exceeds_open_lots")
    expect(await txsFor(h, to)).toHaveLength(0)
  })
})

describe("a SELL after the transfer books its realised P/L on the receiving side", () => {
  it("the pair's total gain is unchanged versus one sale at the source", async () => {
    const h = await boot()
    const from = await seedPortfolio(h, "Equate+")
    const to = await seedPortfolio(h, "IBKR")
    await post(h, [buy(from, "Equate+", "b1", "2026-01-01T12:00:00Z", 5, 10)])
    // The transfer row must come first in the batch: rows are processed in
    // array order, and the sale has to find the delivered lots.
    const b = await body(
      await post(h, [
        transferRow(from, "Equate+", "IBKR", 5, "2026-02-01T12:00:00Z"),
        {
          externalId: "s-1",
          portfolioName: "IBKR",
          executedAt: "2026-02-02T12:00:00Z",
          portfolioTx: {
            portfolioId: to, type: "SELL", instrumentSymbol: "AAPL", assetType: "STOCK",
            quantity: 5, price: 15, currency: "USD", executedAt: "2026-02-02T12:00:00Z",
          },
        },
      ]),
    )
    expect(b.errors ?? []).toEqual([])

    const sell = (await txsFor(h, to)).find((t) => t.type === "SELL")
    // (15 - 10) * 5, booked on IBKR because that is where the sale happened.
    expect(Number(sell!.realizedGainLoss)).toBeCloseTo(25, 6)
    // Nothing realised on Equate+.
    const srcSells = (await txsFor(h, from)).filter((t) => t.type === "SELL")
    expect(srcSells).toHaveLength(0)
    expect(Number((await positionFor(h, to)).quantity)).toBe(0)
  })

  it("the transfer moves no cash — only the sale does", async () => {
    const h = await boot()
    const from = await seedPortfolio(h, "Equate+")
    const to = await seedPortfolio(h, "IBKR")
    await post(h, [buy(from, "Equate+", "b1", "2026-01-01T12:00:00Z", 5, 10)])
    await post(h, [transferRow(from, "Equate+", "IBKR", 5, "2026-02-01T12:00:00Z")])

    // No cash row was ever posted for the transfer: the importer sends none, and
    // #30 pins that a transfer contributes no cash effect at all.
    const { portfolioCashTransactions } = await import("../db/schema.js")
    const cash = await h.db.select().from(portfolioCashTransactions)
    expect(cash).toHaveLength(0)
  })
})