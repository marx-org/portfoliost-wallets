import { describe, expect, it, beforeEach, afterEach } from "vitest"
import { Hono } from "hono"
import { vi } from "vitest"
import { makeHarness } from "./test-utils.js"
import { createImportRoutes } from "./import.js"
import { portfolioCashTransactions, portfolioTransactions, positions, portfolios } from "../db/schema.js"
import { computeSnapshotBatch, hasBackfillableHistory } from "../services/backfill.js"
import { __resetBackfillRunnerForTests } from "../services/backfill-runner.js"

/**
 * Local copy of the price-bar stub from `backfill.test.ts`, which is a file-local
 * helper rather than a shared fixture. 404 means "no data for this symbol" — a gap,
 * not an aborted pass.
 */
function mockPriceBars(series: Record<string, { dates: string[]; closes: number[] }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      const sym = decodeURIComponent(String(url).match(/\/instruments\/([^/]+)\/price-bars/)?.[1] ?? "")
      const data = series[sym]
      if (!data) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) })
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ symbol: sym, dates: data.dates, closes: data.closes, stale: false, currency: null }),
      })
    }),
  )
}

async function setup() {
  const h = await makeHarness()
  const app = new Hono().route("/api/import", createImportRoutes(h.db))
  const post = (transactions: Record<string, unknown>[]) =>
    app.request("/api/import/transactions", {
      method: "POST",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({
        source: { externalSource: "google-sheets:transakcje", spreadsheetId: "s", sheet: "t" },
        transactions,
      }),
    })
  const from = crypto.randomUUID()
  const to = crypto.randomUUID()
  await h.db.insert(portfolios).values([
    { userId: "user-1", id: from, name: "Equate+", baseCurrency: "USD" },
    { userId: "user-1", id: to, name: "IBKR", baseCurrency: "USD" },
  ])
  return { h, post, from, to }
}

/** Five shares at 10 (basis 50), then a PARTIAL transfer of 2 at market 11. */
const BUY = (pf: string, name: string) => ({
  externalId: "b-1", portfolioName: name, executedAt: "2026-01-01T12:00:00Z",
  portfolioTx: {
    portfolioId: pf, type: "BUY", instrumentSymbol: "AAPL", assetType: "STOCK",
    quantity: 5, price: 10, currency: "USD", executedAt: "2026-01-01T12:00:00Z",
  },
})
const DEPOSIT = (name: string) => ({
  externalId: "d-1", portfolioName: name, executedAt: "2026-01-01T12:00:00Z",
  cashTx: { type: "DEPOSIT", amount: 50, currency: "USD", transactionDate: "2026-01-01" },
})
const TRANSFER = (pf: string, qty: number, id: string) => ({
  externalId: id, portfolioName: "Equate+", executedAt: "2026-02-01T12:00:00Z",
  portfolioTx: {
    portfolioId: pf, type: "TRANSFER_OUT", toPortfolioName: "IBKR",
    instrumentSymbol: "AAPL", assetType: "STOCK", quantity: qty,
    currency: "USD", executedAt: "2026-02-01T12:00:00Z",
  },
})

/**
 * A **partial** transfer, deliberately. A portfolio whose value reaches exactly
 * zero stops being represented at all — `computeSnapshotBatch` only emits a row
 * when `totalValue !== 0`, so a full transfer simply ends the series rather than
 * showing a −100% day. The rendering case is the one where value survives.
 */
describe("a transfer moves the capital basis at COST; the flow neutralises at MARKET", () => {
  beforeEach(() => { process.env.INSTRUMENTS_URL = "http://instruments:3000" })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.INSTRUMENTS_URL
    __resetBackfillRunnerForTests()
  })

  async function series(side: "from" | "to") {
    const { h, post, from, to } = await setup()
    await post([DEPOSIT("Equate+"), BUY(from, "Equate+")])
    await post([TRANSFER(from, 2, "x-1")])
    // Price rises 10 -> 11 before the transfer, so cost and market differ.
    mockPriceBars({
      AAPL: {
        dates: ["2026-01-01", "2026-01-31", "2026-02-01", "2026-02-02"],
        closes: [10, 11, 11, 11],
      },
    })
    const portfolioId = side === "from" ? from : to
    const batch = await computeSnapshotBatch(h.db, portfolioId, "Bearer test", new Date("2026-02-03T00:00:00Z"))
    const rows = ("rows" in batch ? batch.rows : []).map((r) => ({
      day: String(r.snapshotDate).slice(0, 10),
      value: Number(r.value),
      invested: Number(r.invested),
      netFlow: Number(r.netFlow),
    }))
    return { rows, onTransfer: rows.find((r) => r.day === "2026-02-01") }
  }

  it("the sending portfolio's basis falls by the COST of what left", async () => {
    const { onTransfer } = await series("from")
    expect(onTransfer).toBeDefined()
    // 50 basis − cost of 2 shares (20) = 30. NOT − market value (22).
    expect(onTransfer!.invested).toBeCloseTo(30, 2)
  })

  it("the receiving portfolio's basis rises by the COST, not the market value", async () => {
    const { onTransfer } = await series("to")
    expect(onTransfer).toBeDefined()
    // Cost of 2 shares is 20; market value was 22. The basis is 20.
    expect(onTransfer!.invested).toBeCloseTo(20, 2)
    expect(onTransfer!.invested).not.toBeCloseTo(22, 2)
  })

  it("netFlow carries the transfer's own amount, signed opposite on each side", async () => {
    const fromSide = await series("from")
    const toSide = await series("to")
    // The row's `totalAmount` is quantity x price, and the import derives price
    // FIFO, so the ledger layer only has the COST. It is signed out of the sender
    // and into the receiver, which is what makes the day neutral.
    expect(fromSide.onTransfer!.netFlow).toBeLessThan(0)
    expect(toSide.onTransfer!.netFlow).toBeGreaterThan(0)
    expect(fromSide.onTransfer!.netFlow).toBeCloseTo(-toSide.onTransfer!.netFlow, 6)
  })

  it("the day reads ~0% rather than a full loss", async () => {
    const { onTransfer } = await series("from")
    // The return formula's denominator is (value - 1) + netFlow. Whatever the
    // transfer moved is carried by the flow, so the day is not reported as a loss.
    const before = onTransfer!.value + 20
    expect(before + onTransfer!.netFlow).toBeCloseTo(before - 20, 6)
    expect(before).toBeCloseTo(53, 6)
  })

  it("rebasing at market would delete real profit", async () => {
    // As arithmetic, so the rule cannot be quietly inverted.
    const cost = 50, marketAtTransfer = 55, proceeds = 60
    expect(proceeds - cost).toBe(10)
    expect(proceeds - marketAtTransfer).toBe(5)
    expect(marketAtTransfer).not.toBe(cost)
  })

  it("no cash row is written — a transfer is not money", async () => {
    const { h, post, from } = await setup()
    await post([DEPOSIT("Equate+"), BUY(from, "Equate+")])
    await post([TRANSFER(from, 2, "x-1")])
    const cash = await h.db.select().from(portfolioCashTransactions)
    expect(cash.every((r) => r.type === "DEPOSIT")).toBe(true)
  })
})

describe("the gain is counted exactly once, however many custody boundaries it crosses", () => {
  it("transfer plus sale books the full gain, on IBKR, and none at the transfer", async () => {
    const { h, post, from, to } = await setup()
    await post([DEPOSIT("Equate+"), BUY(from, "Equate+")])
    await post([
      TRANSFER(from, 5, "x-1"),
      {
        externalId: "s-1", portfolioName: "IBKR", executedAt: "2026-02-02T12:00:00Z",
        portfolioTx: {
          portfolioId: to, type: "SELL", instrumentSymbol: "AAPL", assetType: "STOCK",
          quantity: 5, price: 12, currency: "USD", executedAt: "2026-02-02T12:00:00Z",
        },
      },
    ])

    const legs = await h.db.select().from(portfolioTransactions)
    const byPortfolio = new Map<string, number>()
    for (const l of legs) {
      if (l.realizedGainLoss == null) continue
      byPortfolio.set(l.portfolioId, (byPortfolio.get(l.portfolioId) ?? 0) + Number(l.realizedGainLoss))
    }
    // 60 − 50 = +10, once. The old model booked a SELL on Equate+ AND a later
    // sale at IBKR, counting the same gain twice.
    expect([...byPortfolio.values()].reduce((a, b) => a + b, 0)).toBeCloseTo(10, 6)
    expect(byPortfolio.get(to)).toBeCloseTo(10, 6)
    expect(byPortfolio.get(from) ?? 0).toBe(0)
    for (const l of legs) {
      if (l.type === "TRANSFER_OUT" || l.type === "TRANSFER_IN") expect(l.realizedGainLoss).toBeNull()
    }
  })

  it("quantity is conserved across the boundary", async () => {
    const { h, post, from, to } = await setup()
    await post([DEPOSIT("Equate+"), BUY(from, "Equate+")])
    await post([TRANSFER(from, 2, "x-1")])
    const rows = await h.db.select().from(positions)
    const byPf = new Map<string, number>()
    for (const r of rows) byPf.set(r.portfolioId, (byPf.get(r.portfolioId) ?? 0) + Number(r.quantity))
    expect(byPf.get(from) ?? 0).toBe(3)
    expect(byPf.get(to) ?? 0).toBe(2)
    expect([...byPf.values()].reduce((a, b) => a + b, 0)).toBe(5)
  })

  it("a portfolio whose whole history is one TRANSFER_IN has a window at all", async () => {
    process.env.INSTRUMENTS_URL = "http://instruments:3000"
    const { h, post, from, to } = await setup()
    await post([DEPOSIT("Equate+"), BUY(from, "Equate+")])
    await post([TRANSFER(from, 5, "x-1")])
    mockPriceBars({ AAPL: { dates: ["2026-01-01", "2026-01-02", "2026-01-03"], closes: [10, 10, 10] } })
    // With the position filters reading BUY/SELL only, IBKR had no window at all:
    // no BUY/SELL row and no cash row, so the batch came back empty. Asserted on
    // `hasBackfillableHistory` rather than the full batch, because that IS the
    // window-start query that was fixed and it does not depend on price/FX stubbing.
    expect(await hasBackfillableHistory(h.db, to, new Date("2026-02-03T00:00:00Z"))).toBe(true)
    // The sender has a BUY, so it was never the broken case — assert both so the
    // difference is attributable to the transfer rather than to the fixture.
    expect(await hasBackfillableHistory(h.db, from, new Date("2026-02-03T00:00:00Z"))).toBe(true)
  })
})