import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Hono } from "hono"
import { and, eq } from "drizzle-orm"
import { createPortfolioRoutes } from "./portfolios.js"
import { createTransactionRoutes } from "./portfolio-transactions.js"
import { makeHarness, type Harness } from "./test-utils.js"
import { mockInstrumentsFx, unmockInstrumentsFx } from "../test-fx-mock.js"
import { portfolios, portfolioTransactions, portfolioCashTransactions } from "../db/schema.js"
import { __resetBackfillRunnerForTests } from "../services/backfill-runner.js"

/**
 * §74 — the interactive in-kind transfer.
 *
 * The leg expansion is shared with the bulk importer (services/transferLegs.ts),
 * so these tests are about the ROUTE: what it refuses, what it writes, and that a
 * transfer is not a trade — no cash row, no realised P/L, no external flow.
 */
const CLOSE = 11

function stubTransferPrices() {
  const previousFetch = globalThis.fetch
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (!url.includes("/price-bars?")) return previousFetch(input, init)
    const q = new URL(url)
    return new Response(
      JSON.stringify({
        symbol: "AAPL",
        stale: false,
        dates: [q.searchParams.get("from")!],
        closes: [CLOSE],
        currency: q.searchParams.get("currency") ?? "USD",
      }),
      { status: 200 },
    )
  }))
}

beforeEach(() => {
  process.env.INSTRUMENTS_SERVICE_TOKEN = "test-instruments-service-token"
  mockInstrumentsFx({ table: { USD: 1.0 } })
  stubTransferPrices()
})

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.INSTRUMENTS_URL
  delete process.env.INSTRUMENTS_SERVICE_TOKEN
  __resetBackfillRunnerForTests()
})

async function boot() {
  const h = await makeHarness()
  const app = new Hono()
    .route("/api/portfolios", createPortfolioRoutes(h.db))
    .route("/api/portfolios", createTransactionRoutes(h.db))
  return { ...h, app }
}

async function createPortfolio(app: Harness["app"], headers: Harness["headers"], name: string) {
  const res = await app.request("/api/portfolios", {
    method: "POST",
    headers,
    body: JSON.stringify({ name, currency: "USD" }),
  })
  return (await res.json()) as { id: string }
}

async function buy(h: Harness, portfolioId: string, quantity: number, price: number, executedAt: string) {
  const res = await h.app.request(`/api/portfolios/${portfolioId}/transactions`, {
    method: "POST",
    headers: h.headers,
    body: JSON.stringify({
      type: "BUY",
      symbol: "AAPL",
      instrumentName: "Apple Inc",
      quantity,
      price,
      currency: "USD",
      assetType: "STOCK",
      executedAt,
    }),
  })
  if (res.status !== 201) throw new Error(`seed BUY failed: ${res.status} ${await res.text()}`)
}

async function rowsFor(db: Harness["db"], portfolioId: string, type: string) {
  return db
    .select()
    .from(portfolioTransactions)
    .where(and(eq(portfolioTransactions.portfolioId, portfolioId), eq(portfolioTransactions.type, type)))
    .orderBy(portfolioTransactions.executedAt)
}

function transfer(
  h: Harness,
  from: string,
  to: string,
  body: Record<string, unknown>,
) {
  return h.app.request(`/api/portfolios/${from}/transfers`, {
    method: "POST",
    headers: h.headers,
    body: JSON.stringify(body),
  })
}

describe("POST /:id/transfers (§74)", () => {
  it("draws FIFO across lots and writes a matching leg in the receiving portfolio", { timeout: 30_000 }, async () => {
    const h = await boot()
    const from = await createPortfolio(h.app, h.headers, "Equate+")
    const to = await createPortfolio(h.app, h.headers, "IBKR")
    await buy(h, from.id, 4, 10, "2026-01-01T12:00:00Z")
    await buy(h, from.id, 1, 12, "2026-02-01T12:00:00Z")

    const res = await transfer(h, from.id, to.id, { symbol: "AAPL", quantity: 5, toPortfolioId: to.id })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.transferGroupId).toBeTruthy()
    expect(body.quantity).toBe(5)
    // One pair per lot drawn: 4 off the 10.00 lot, 1 off the 12.00 lot.
    expect(body.legs).toHaveLength(4)
    expect(body.legs.map((l: { type: string; quantity: number; price: number }) => [l.type, l.quantity, l.price])).toEqual([
      ["TRANSFER_OUT", 4, 10],
      ["TRANSFER_IN", 4, 10],
      ["TRANSFER_OUT", 1, 12],
      ["TRANSFER_IN", 1, 12],
    ])
    expect(new Set(body.legs.map((l: { transferGroupId: string }) => l.transferGroupId)).size).toBe(1)

    const outs = await rowsFor(h.db, from.id, "TRANSFER_OUT")
    const ins = await rowsFor(h.db, to.id, "TRANSFER_IN")
    expect(outs).toHaveLength(2)
    expect(ins).toHaveLength(2)
    // Every OUT points at its IN, and every IN back at its OUT.
    expect(outs.map((o) => o.linkedTransferId)).toEqual(ins.map((i) => i.id))
    expect(ins.every((i) => i.linkedTransferId)).toBe(true)
    // The lot each draw came from is named, so the receiving queue is correct
    // without re-deriving anything.
    expect(outs.every((o) => o.sourceTransactionId)).toBe(true)
    // Nothing was disposed of: no realised P/L on either side.
    expect(outs.some((o) => o.realizedGainLoss != null)).toBe(false)
    expect(ins.some((i) => i.realizedGainLoss != null)).toBe(false)
    // No provenance tag — this row was created in the UI, not by a sync.
    expect(outs.some((o) => o.externalId != null)).toBe(false)
  })

  it("moves no cash and closes nothing", { timeout: 30_000 }, async () => {
    const h = await boot()
    const from = await createPortfolio(h.app, h.headers, "Equate+")
    const to = await createPortfolio(h.app, h.headers, "IBKR")
    await buy(h, from.id, 10, 10, "2026-01-01T12:00:00Z")

    const res = await transfer(h, from.id, to.id, { symbol: "AAPL", quantity: 4, toPortfolioId: to.id })
    expect(res.status).toBe(201)

    const cash = await h.db.select().from(portfolioCashTransactions)
    expect(cash).toHaveLength(0)

    const legs = await h.db.select().from(portfolioTransactions)
    // The sender keeps 6 of the 10; the receiver now holds 4 at the same cost.
    const outs = legs.filter((l) => l.type === "TRANSFER_OUT")
    expect(outs).toHaveLength(1)
    expect(Number(outs[0].quantity)).toBe(4)
    expect(Number(outs[0].totalAmount)).toBe(40)
    expect(Number(outs[0].convertedTotalAmount)).toBe(40)
    expect(Number(outs[0].exchangeRate)).toBe(1)
  })

  it("refuses the whole request when the quantity exceeds what is open", { timeout: 30_000 }, async () => {
    const h = await boot()
    const from = await createPortfolio(h.app, h.headers, "Equate+")
    const to = await createPortfolio(h.app, h.headers, "IBKR")
    await buy(h, from.id, 4, 10, "2026-01-01T12:00:00Z")

    const res = await transfer(h, from.id, to.id, { symbol: "AAPL", quantity: 5, toPortfolioId: to.id })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBe("ValidationError")
    expect(body.code).toBe("transfer_exceeds_open_lots")
    expect(body.message).toContain("exceeds 4 open in AAPL")

    // Atomic: nothing half-written.
    const legs = await h.db.select().from(portfolioTransactions)
    expect(legs.filter((l) => l.type === "TRANSFER_OUT")).toHaveLength(0)
    expect(legs.filter((l) => l.type === "TRANSFER_IN")).toHaveLength(0)
  })

  it("rejects a self-transfer, an unknown target, and a virtual portfolio", { timeout: 30_000 }, async () => {
    const h = await boot()
    const from = await createPortfolio(h.app, h.headers, "Equate+")
    await buy(h, from.id, 10, 10, "2026-01-01T12:00:00Z")

    const self = await transfer(h, from.id, from.id, { symbol: "AAPL", quantity: 2, toPortfolioId: from.id })
    expect(self.status).toBe(422)
    expect((await self.json()).message).toContain("cannot transfer to itself")

    const missing = await transfer(h, from.id, "00000000-0000-4000-8000-000000000000", {
      symbol: "AAPL",
      quantity: 2,
      toPortfolioId: "00000000-0000-4000-8000-000000000000",
    })
    expect(missing.status).toBe(404)

    const [virtual] = await h.db
      .insert(portfolios)
      .values({ userId: "user-1", name: "Virtual", baseCurrency: "USD", isVirtual: true })
      .returning()

    const intoVirtual = await transfer(h, from.id, virtual.id, { symbol: "AAPL", quantity: 2, toPortfolioId: virtual.id })
    expect(intoVirtual.status).toBe(409)

    const outOfVirtual = await transfer(h, virtual.id, from.id, { symbol: "AAPL", quantity: 2, toPortfolioId: from.id })
    expect(outOfVirtual.status).toBe(409)

    // Nothing moved in any of the refusals.
    const legs = await h.db
      .select()
      .from(portfolioTransactions)
      .where(eq(portfolioTransactions.type, "TRANSFER_OUT"))
    expect(legs).toHaveLength(0)
  })

  it("both legs show up in the transactions feed of each portfolio", { timeout: 30_000 }, async () => {
    const h = await boot()
    const from = await createPortfolio(h.app, h.headers, "Equate+")
    const to = await createPortfolio(h.app, h.headers, "IBKR")
    await buy(h, from.id, 6, 10, "2026-01-01T12:00:00Z")

    const res = await transfer(h, from.id, to.id, {
      symbol: "AAPL",
      quantity: 2,
      toPortfolioId: to.id,
      executedAt: "2026-06-01T12:00:00Z",
      notes: "moved to IBKR",
    })
    expect(res.status).toBe(201)

    for (const [portfolioId, expected] of [[from.id, "TRANSFER_OUT"], [to.id, "TRANSFER_IN"]] as const) {
      const feed = await h.app.request(`/api/portfolios/${portfolioId}/transactions`, { headers: h.headers })
      const items = ((await feed.json()) as { items: Array<{ type: string; notes: string | null }> }).items
      const leg = items.find((i) => i.type === expected)
      expect(leg, `${expected} visible in ${portfolioId}`).toBeTruthy()
      expect(leg!.notes).toBe("moved to IBKR")
    }
  })
})
