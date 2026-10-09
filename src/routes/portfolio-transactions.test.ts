import { describe, expect, it, vi } from "vitest"
import { Hono } from "hono"
import { createPortfolioRoutes } from "./portfolios.js"
import { createPortfolioCashRoutes } from "./portfolio-cash.js"
import { createPublicShareRoutes } from "./portfolios.js"
import { createCrossPortfolioTransactionsRoute } from "./portfolio-transactions.js"
import { makeHarness, priceOpenPositions } from "./test-utils.js"
import { mockInstrumentsFx, unmockInstrumentsFx } from "../test-fx-mock.js"
import { crossRate } from "@marx2/contracts/fx"
import {
  portfolios,
  positions,
  portfolioTransactions,
  portfolioCashTransactions,
  valueSnapshots,
} from "../db/schema.js"
import { positionInPortfolio } from "../db/position-membership.js"
import { and, eq, sql } from "drizzle-orm"

function app(db: Parameters<typeof makeHarness>[0] extends string ? never : Parameters<typeof createPortfolioRoutes>[0]) {
  const a = new Hono()
  // Cross-portfolio feed must be mounted BEFORE portfolio routes to avoid /:id collision
  a.route("/api/portfolios/transactions", createCrossPortfolioTransactionsRoute(db))
  a.route("/api/portfolios", createPortfolioRoutes(db))
  return a
}

function publicApp(db: Parameters<typeof makeHarness>[0] extends string ? never : Parameters<typeof createPortfolioRoutes>[0]) {
  const a = new Hono()
  a.route("/api/portfolios/public", createPublicShareRoutes(db))
  return a
}

const BUY_BODY = {
  type: "BUY",
  symbol: "AAPL",
  instrumentName: "Apple Inc",
  quantity: 10,
  price: 150,
  currency: "USD",
  sector: "Technology",
  country: "US",
  assetType: "STOCK",
  fees: 4.99,
}

const SELL_BODY = {
  type: "SELL",
  symbol: "AAPL",
  quantity: 5,
  price: 170,
  currency: "USD",
  fees: 2.5,
}

describe("Portfolio transactions (§15 Phase C)", () => {
  // 30s, following import.test.ts:91. Three sequential POSTs each in their own DB
  // transaction, plus two table reads — under vitest's 5s default with
  // `singleFork` and 33 files this intermittently timed out, which reads as a
  // logic failure and is not one. It failed ~1 run in 4 before the explicit budget.
  it("POST /:id/transactions — a type the interactive route cannot build is a 422, not a wrong row", { timeout: 30_000 }, async () => {
    // This route's cash leg maps anything that is not BUY to a WITHDRAWAL, so
    // accepting TRANSFER_OUT would have booked a cash payment for an event that
    // moved no cash — the exact thing the transfer type exists to stop.
    const h = await makeHarness()
    const a = app(h.db)
    const portfolio = await (
      await a.request("/api/portfolios", {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify({ name: "P", currency: "USD" }),
      })
    ).json()

    for (const type of ["TRANSFER_OUT", "TRANSFER_IN", "EXPIRATION"]) {
      const res = await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify({ ...BUY_BODY, type, cashLeg: true }),
      })
      expect(res.status, `${type} must be rejected here`).toBe(422)
      expect((await res.json()).error).toBe("UnsupportedTransactionType")
    }

    // Nothing was written — not a transaction, and critically not a cash row.
    const txs = await h.db.select().from(portfolioTransactions)
    expect(txs).toHaveLength(0)
    const cash = await h.db.select().from(portfolioCashTransactions)
    expect(cash).toHaveLength(0)
  })

  it("POST /:id/transactions — BUY creates position + transaction", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    const res = await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.type).toBe("BUY")
    expect(body.instrumentSymbol).toBe("AAPL")
    expect(body.quantity).toBe(10)
    expect(body.price).toBe(150)
    expect(body.totalAmount).toBe(1500)
    expect(body.feesSettled).toBeGreaterThanOrEqual(0)
    expect(body.exchangeRate).toBe(1)
    expect(body.rateSource).toBe("automatic")

    // Position was created
    const detail = await a.request(`/api/portfolios/${portfolio.id}`, { headers: h.headers })
    const detailBody = await detail.json()
    expect(detailBody.positions.length).toBe(1)
    expect(detailBody.positions[0].symbol).toBe("AAPL")
    expect(Number(detailBody.positions[0].quantity)).toBe(10)
  })

  it("POST /:id/transactions — second BUY on same symbol merges into position", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })

    await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ ...BUY_BODY, quantity: 5, price: 160 }),
    })

    const detail = await a.request(`/api/portfolios/${portfolio.id}`, { headers: h.headers })
    const body = await detail.json()
    expect(body.positions.length).toBe(1) // merged, not 2
    expect(Number(body.positions[0].quantity)).toBe(15) // 10 + 5
    // avg cost: (10*150 + 5*160)/15 = 2300/15 ≈ 153.33
    expect(body.positions[0].averageCostBasis).toBeCloseTo(153.33, 1)
  })

  it("POST /:id/transactions — SELL computes realized P/L", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    // Buy first
    await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })

    // Sell half at a profit
    const sellRes = await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(SELL_BODY),
    })
    expect(sellRes.status).toBe(201)
    const sellBody = await sellRes.json()
    expect(sellBody.type).toBe("SELL")
    expect(sellBody.realizedGainLoss).toBeCloseTo((170 - 150) * 5 - 2.5, 1)

    // Position should have 5 remaining
    const detail = await a.request(`/api/portfolios/${portfolio.id}`, { headers: h.headers })
    const body = await detail.json()
    expect(body.positions.length).toBe(1)
    expect(Number(body.positions[0].quantity)).toBe(5)
    expect(body.positions[0].isOpen).toBe(true)
  })

  it("POST /:id/transactions — SELL all closes position", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })

    await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ ...SELL_BODY, quantity: 10 }),
    })

    const detail = await a.request(`/api/portfolios/${portfolio.id}`, { headers: h.headers })
    const body = await detail.json()
    expect(body.positions.length).toBe(1)
    expect(body.positions[0].isOpen).toBe(false)
  })

  it("POST /:id/transactions — SELL more than owned → 422", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })

    const res = await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ ...SELL_BODY, quantity: 20 }),
    })
    expect(res.status).toBe(422)
  })

  it("POST /:id/transactions — SELL no position → 422", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    const res = await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(SELL_BODY),
    })
    expect(res.status).toBe(422)
  })

  it("POST /:id/transactions — missing type → 422", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    const res = await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ symbol: "AAPL", quantity: 1, price: 100, currency: "USD" }),
    })
    expect(res.status).toBe(422)
  })

  it("POST /:id/transactions — manual exchangeRate accepted", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "PLN" }),
    })
    const portfolio = await createRes.json()

    const res = await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({
        ...BUY_BODY,
        currency: "USD",
        rateSource: "manual",
        exchangeRate: 4.0,
      }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.exchangeRate).toBe(4)
    expect(body.rateSource).toBe("manual")
    expect(body.convertedTotalAmount).toBe(6000)
  })

  it("POST /:id/transactions — invalid manual rate → 422", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "PLN" }),
    })
    const portfolio = await createRes.json()

    const res = await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({
        ...BUY_BODY,
        currency: "USD",
        rateSource: "manual",
        exchangeRate: -1,
      }),
    })
    expect(res.status).toBe(422)
  })

  it("POST /:id/transactions — DIVIDEND creates tx without position", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    const res = await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({
        type: "DIVIDEND",
        symbol: "AAPL",
        quantity: 1,
        price: 2.5,
        currency: "USD",
      }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.type).toBe("DIVIDEND")
    expect(body.totalAmount).toBe(2.5)

    // No position created for dividends
    const detail = await a.request(`/api/portfolios/${portfolio.id}`, { headers: h.headers })
    const detailBody = await detail.json()
    expect(detailBody.positions.length).toBe(0)
  })

  it("PATCH /:id/transactions/:txId — updates quantity + recomputes", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    const buyRes = await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })
    const tx = await buyRes.json()

    const patchRes = await a.request(`/api/portfolios/${portfolio.id}/transactions/${tx.id}`, {
      method: "PATCH",
      headers: h.headers,
      body: JSON.stringify({ quantity: 20, price: 160 }),
    })
    expect(patchRes.status).toBe(200)
    const patched = await patchRes.json()
    expect(patched.quantity).toBe(20)
    expect(patched.price).toBe(160)
    expect(patched.totalAmount).toBe(3200)
  })

  it("DELETE /:id/transactions/:txId — reverses position + recomputes", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    const buyRes = await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })
    const tx = await buyRes.json()

    const delRes = await a.request(`/api/portfolios/${portfolio.id}/transactions/${tx.id}`, {
      method: "DELETE",
      headers: h.headers,
    })
    expect(delRes.status).toBe(204)

    // Position should be gone or quantity zero
    const detail = await a.request(`/api/portfolios/${portfolio.id}`, { headers: h.headers })
    const body = await detail.json()
    const openPositions = body.positions.filter((p: any) => p.isOpen)
    expect(openPositions.length).toBe(0)
  })

  it("DELETE /:id/transactions/:txId — SELL reversal reopens position", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    const buyRes = await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })
    const buyTx = await buyRes.json()

    const sellRes = await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ ...SELL_BODY, quantity: 5 }),
    })
    const sellTx = await sellRes.json()

    // Delete the sell → position should reopen with full 10 qty
    await a.request(`/api/portfolios/${portfolio.id}/transactions/${sellTx.id}`, {
      method: "DELETE",
      headers: h.headers,
    })

    const detail = await a.request(`/api/portfolios/${portfolio.id}`, { headers: h.headers })
    const body = await detail.json()
    const openPositions = body.positions.filter((p: any) => p.isOpen)
    expect(openPositions.length).toBe(1)
    expect(Number(openPositions[0].quantity)).toBe(10)
  })

  it("PATCH /:id/positions/:positionId — metadata-only update", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })

    const detail = await a.request(`/api/portfolios/${portfolio.id}`, { headers: h.headers })
    const detailBody = await detail.json()
    const posId = detailBody.positions[0].id

    const patchRes = await a.request(`/api/portfolios/${portfolio.id}/positions/${posId}`, {
      method: "PATCH",
      headers: h.headers,
      body: JSON.stringify({ sector: "Consumer Tech", currentPrice: 180 }),
    })
    expect(patchRes.status).toBe(200)
    const patched = await patchRes.json()
    expect(patched.sector).toBe("Consumer Tech")
    expect(Number(patched.currentPrice)).toBe(180)
    expect(Number(patched.marketValue)).toBe(1800)
    expect(Number(patched.unrealizedGainLoss)).toBeCloseTo(300, 0) // (180-150)*10
  })

  it("DELETE /:id/positions/:positionId — removes position with its transactions (D4.8)", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })

    const detail = await a.request(`/api/portfolios/${portfolio.id}`, { headers: h.headers })
    const detailBody = await detail.json()
    const posId = detailBody.positions[0].id

    const delRes = await a.request(`/api/portfolios/${portfolio.id}/positions/${posId}`, {
      method: "DELETE",
      headers: h.headers,
    })
    expect(delRes.status).toBe(200)
    const removed = await delRes.json()
    expect(removed.isOpen).toBe(false)

    const txRes = await a.request(`/api/portfolios/${portfolio.id}/transactions`, { headers: h.headers })
    const txBody = await txRes.json()
    expect(txBody.items.length).toBe(0)

    const listRes = await a.request(`/api/portfolios/${portfolio.id}/positions`, { headers: h.headers })
    expect(await listRes.json()).toEqual([])
  })

  it("POST /:id/transactions — BUY persists (cash effect is derived by replay, §62)", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const portfolioRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", baseCurrency: "USD" }),
    })
    const portfolio = await portfolioRes.json()

    const buyRes = await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })
    expect(buyRes.status).toBe(201)
  })

  it("POST /:id/transactions — foreign portfolio → 404", async () => {
    const h = await makeHarness("user-a")
    const h2 = await makeHarness("user-b")
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "A's", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    const a2 = app(h2.db)
    const res = await a2.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h2.headers,
      body: JSON.stringify(BUY_BODY),
    })
    expect(res.status).toBe(404)
  })

  it("POST /:id/transactions — pct fees computed against notional", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    const res = await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({
        ...BUY_BODY,
        fees: 0.1,
        feesType: "pct",
      }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    // 0.1% of 1500 = 1.5
    expect(body.feesSettled).toBeCloseTo(1.5, 2)
  })
})

describe("Portfolio transaction history (§15 Phase D)", () => {
  it("GET /:id/transactions — paginated list", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    // Create 3 transactions
    for (let i = 0; i < 3; i++) {
      await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify({ ...BUY_BODY, quantity: i + 1 }),
      })
    }

    const res = await a.request(`/api/portfolios/${portfolio.id}/transactions?page=1&limit=2`, {
      headers: h.headers,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items.length).toBe(2)
    expect(body.total).toBe(3)
    expect(body.page).toBe(1)
    expect(body.limit).toBe(2)
  })

  it("GET /:id/transactions — filter by type", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })

    await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({
        type: "DIVIDEND",
        symbol: "AAPL",
        quantity: 1,
        price: 2.5,
        currency: "USD",
      }),
    })

    const res = await a.request(`/api/portfolios/${portfolio.id}/transactions?type=dividend`, {
      headers: h.headers,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items.length).toBe(1)
    expect(body.items[0].type).toBe("DIVIDEND")
  })

  it("GET /:id/transactions — filter by positionId", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    // BUY AAPL
    const buyRes = await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })
    const buyTx = await buyRes.json()

    // BUY MSFT (different position)
    await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ ...BUY_BODY, symbol: "MSFT", instrumentName: "Microsoft" }),
    })

    const res = await a.request(
      `/api/portfolios/${portfolio.id}/transactions?positionId=${buyTx.positionId}`,
      { headers: h.headers },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items.length).toBe(1)
    expect(body.items[0].instrumentSymbol).toBe("AAPL")
  })

  it("GET /:id/transactions — filter by instrumentSymbol (case-insensitive)", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })
    await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ ...BUY_BODY, symbol: "MSFT", instrumentName: "Microsoft" }),
    })

    const res = await a.request(
      `/api/portfolios/${portfolio.id}/transactions?instrumentSymbol=aapl`,
      { headers: h.headers },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items.length).toBe(1)
    expect(body.items[0].instrumentSymbol).toBe("AAPL")
  })

  it("GET /:id/transactions — sort by symbol ascending", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ ...BUY_BODY, symbol: "ZZZZ" }),
    })
    await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ ...BUY_BODY, symbol: "AAAA" }),
    })

    const res = await a.request(
      `/api/portfolios/${portfolio.id}/transactions?sortBy=symbol&sortOrder=asc`,
      { headers: h.headers },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items[0].instrumentSymbol).toBe("AAAA")
    expect(body.items[1].instrumentSymbol).toBe("ZZZZ")
  })

  it("GET /transactions — cross-portfolio feed", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const p1Res = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P1", currency: "USD" }),
    })
    const p1 = await p1Res.json()

    const p2Res = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P2", currency: "EUR" }),
    })
    const p2 = await p2Res.json()

    await a.request(`/api/portfolios/${p1.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })
    await a.request(`/api/portfolios/${p2.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ ...BUY_BODY, symbol: "MSFT" }),
    })

    const res = await a.request("/api/portfolios/transactions", { headers: h.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items.length).toBe(2)
    expect(body.total).toBe(2)
    // Both portfolios' transactions appear
    const symbols = body.items.map((t: any) => t.instrumentSymbol).sort()
    expect(symbols).toEqual(["AAPL", "MSFT"])
  })

  it("GET /transactions — filter by instrumentSymbol (case-insensitive)", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const p1Res = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P1", currency: "USD" }),
    })
    const p1 = await p1Res.json()

    const p2Res = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P2", currency: "EUR" }),
    })
    const p2 = await p2Res.json()

    await a.request(`/api/portfolios/${p1.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })
    await a.request(`/api/portfolios/${p2.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ ...BUY_BODY, symbol: "MSFT" }),
    })

    const res = await a.request("/api/portfolios/transactions?instrumentSymbol=msft", {
      headers: h.headers,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items.length).toBe(1)
    expect(body.items[0].instrumentSymbol).toBe("MSFT")
    expect(body.total).toBe(1)
  })

  it("GET /:id/transactions/export — returns all txs", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })

    const res = await a.request(`/api/portfolios/${portfolio.id}/transactions/export`, {
      headers: h.headers,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items.length).toBe(1)
    expect(body.total).toBe(1)
    expect(body.items[0].instrumentSymbol).toBe("AAPL")
  })

  it("GET /:id/transactions — foreign portfolio → 404", async () => {
    const h = await makeHarness("user-a")
    const h2 = await makeHarness("user-b")
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "A's", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    const a2 = app(h2.db)
    const res = await a2.request(`/api/portfolios/${portfolio.id}/transactions`, {
      headers: h2.headers,
    })
    expect(res.status).toBe(404)
  })
})

describe("Portfolio positions & allocation (§15 Phase E)", () => {
  it("GET /:id/allocation — returns breakdown by sector/asset/currency", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    // Create positions via transactions
    await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ ...BUY_BODY, sector: "Technology", country: "US" }),
    })
    await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ ...BUY_BODY, symbol: "MSFT", instrumentName: "Microsoft", sector: "Technology", country: "US" }),
    })

    const res = await a.request(`/api/portfolios/${portfolio.id}/allocation`, { headers: h.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalValue).toBeGreaterThan(0)
    expect(body.bySector.length).toBe(1)
    expect(body.bySector[0].name).toBe("Technology")
    expect(body.byAssetType.length).toBe(1)
    expect(body.byAssetType[0].name).toBe("STOCK")
    // §66.3 — the allocation now states the currency it is denominated in, so the
    // SPA does not have to guess one to label the numbers.
    expect(body.currency).toBe("USD")
    // byCurrency rows carry their OWN currency in `name` and are NOT converted
    for (const row of body.byCurrency) expect(row.name).toMatch(/^[A-Z]{3}$/)
    expect(body.byCurrency.length).toBe(1)
    expect(body.byCurrency[0].name).toBe("USD")
  })

  it("GET /:id/allocation — empty portfolio", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    const res = await a.request(`/api/portfolios/${portfolio.id}/allocation`, { headers: h.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalValue).toBe(0)
    expect(body.bySector).toEqual([])
  })

  it("GET /:id/positions — returns full position list (example-service wire shape)", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })

    const res = await a.request(`/api/portfolios/${portfolio.id}/positions`, { headers: h.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.length).toBe(1)
    const p = body[0]
    expect(p.id).toBeDefined()
    expect(p.portfolioId).toBe(portfolio.id)
    expect(p.symbol).toBe("AAPL")
    expect(p.quantity).toBe(10)
    expect(p.isOpen).toBe(true)
    expect(p.totalCostBasis).toBeCloseTo(10 * BUY_BODY.price, 1)
    expect(p.displayCurrency).toBe("USD")
    expect(p.metrics).toBeNull()
    if (p.currentPrice != null) {
      expect(p.marketValue).toBeCloseTo(p.currentPrice * p.quantity, 1)
      expect(p.percentOfPortfolio).toBeCloseTo(100, 1)
    }
  })

  it("GET /:id/positions — unauthenticated → 401", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    const res = await a.request(`/api/portfolios/${portfolio.id}/positions`)
    expect(res.status).toBe(401)
  })

  it("GET /:id/positions — foreign portfolio → 404", async () => {
    const h = await makeHarness("user-a")
    const a = app(h.db)
    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    const h2 = await makeHarness("user-b")
    const res = await a.request(`/api/portfolios/${portfolio.id}/positions`, { headers: h2.headers })
    expect(res.status).toBe(404)
  })

  it("GET /:id/positions/bare — returns minimal position list", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })

    const res = await a.request(`/api/portfolios/${portfolio.id}/positions/bare`, { headers: h.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.length).toBe(1)
    expect(body[0].symbol).toBe("AAPL")
    expect(body[0].quantity).toBe(10)
    expect(body[0].isOpen).toBe(true)
    // Minimal: no metrics, no marketValue
    expect(body[0].marketValue).toBeUndefined()
  })

  it("GET /:id/positions/cfd-hints — returns enriched hints", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })

    const res = await a.request(`/api/portfolios/${portfolio.id}/positions/cfd-hints`, { headers: h.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.length).toBe(1)
    expect(body[0].symbol).toBe("AAPL")
    expect(body[0].sector).toBe("Technology")
    expect(body[0].quantity).toBe(10)
  })

  it("GET /:id/allocation — foreign portfolio → 404", async () => {
    const h = await makeHarness("user-a")
    const h2 = await makeHarness("user-b")
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "A's", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    const a2 = app(h2.db)
    const res = await a2.request(`/api/portfolios/${portfolio.id}/allocation`, { headers: h2.headers })
    expect(res.status).toBe(404)
  })
})

describe("Position CRUD (§15 D4.2–D4.8)", () => {
  async function setup() {
    const h = await makeHarness()
    const a = app(h.db)
    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "USD" }),
    })
    const portfolio = await createRes.json()
    return { h, a, portfolio }
  }

  it("POST /:id/positions — creates stock position (201, example-service wire)", async () => {
    const { h, a, portfolio } = await setup()

    const res = await a.request(`/api/portfolios/${portfolio.id}/positions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ symbol: "TSLA", quantity: 4, price: 250, fees: 2.5, assetType: "STOCK" }),
    })
    expect(res.status).toBe(201)
    const p = await res.json()
    expect(p.symbol).toBe("TSLA")
    expect(p.quantity).toBe(4)
    expect(p.averageCostBasis).toBe(250)
    expect(p.totalCostBasis).toBe(1000)
    expect(p.isOpen).toBe(true)
    expect(p.displayCurrency).toBe("USD")
    expect(p.portfolioId).toBe(portfolio.id)

    const listRes = await a.request(`/api/portfolios/${portfolio.id}/positions`, { headers: h.headers })
    const list = await listRes.json()
    expect(list.length).toBe(1)
    expect(list[0].id).toBe(p.id)
  })

  it("POST /:id/positions — same symbol merges into existing position", async () => {
    const { h, a, portfolio } = await setup()

    await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })

    const res = await a.request(`/api/portfolios/${portfolio.id}/positions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ symbol: "AAPL", quantity: 5, price: 200 }),
    })
    expect(res.status).toBe(201)
    const p = await res.json()
    expect(p.quantity).toBe(15)
    expect(p.averageCostBasis).toBeCloseTo((10 * 150 + 5 * 200) / 15, 1)
  })

  it("POST /:id/positions — option position persists contract fields", async () => {
    const { h, a, portfolio } = await setup()

    const res = await a.request(`/api/portfolios/${portfolio.id}/positions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({
        symbol: "AAPL260919C320",
        quantity: 1,
        price: 550,
        assetType: "OPTION",
        contractSize: 100,
        optionType: "CALL",
        strikePrice: 320,
        expirationDate: "2026-09-19",
      }),
    })
    expect(res.status).toBe(201)
    const p = await res.json()
    expect(p.assetType).toBe("OPTION")
    expect(p.contractSize).toBe(100)
    expect(p.optionType).toBe("CALL")
    expect(p.strikePrice).toBe(320)
    expect(p.expirationDate).toBe("2026-09-19")
  })

  it("POST /:id/positions — missing price+averageCostBasis → 422", async () => {
    const { h, a, portfolio } = await setup()

    const res = await a.request(`/api/portfolios/${portfolio.id}/positions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ symbol: "TSLA", quantity: 4 }),
    })
    expect(res.status).toBe(422)
  })

  it("POST /:id/positions — unauthenticated → 401", async () => {
    const { a, portfolio } = await setup()
    const res = await a.request(`/api/portfolios/${portfolio.id}/positions`, {
      method: "POST",
      body: JSON.stringify({ symbol: "TSLA", quantity: 4, price: 250 }),
    })
    expect(res.status).toBe(401)
  })

  it("POST /:id/positions — foreign portfolio → 404", async () => {
    const { h, a, portfolio } = await setup()
    const h2 = await makeHarness("user-b")
    const res = await a.request(`/api/portfolios/${portfolio.id}/positions`, {
      method: "POST",
      headers: h2.headers,
      body: JSON.stringify({ symbol: "TSLA", quantity: 4, price: 250 }),
    })
    expect(res.status).toBe(404)
  })

  it("PATCH /:id/positions/:positionId — quantity + averageCostBasis sync", async () => {
    const { h, a, portfolio } = await setup()

    const createRes = await a.request(`/api/portfolios/${portfolio.id}/positions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ symbol: "TSLA", quantity: 10, price: 200 }),
    })
    const pos = await createRes.json()

    const res = await a.request(`/api/portfolios/${portfolio.id}/positions/${pos.id}`, {
      method: "PATCH",
      headers: h.headers,
      body: JSON.stringify({ quantity: 25, averageCostBasis: 180, avgCostBasis: 180 }),
    })
    expect(res.status).toBe(200)
    const p = await res.json()
    expect(p.quantity).toBe(25)
    expect(p.averageCostBasis).toBe(180)
    expect(p.totalCostBasis).toBe(4500)
  })

  it("DELETE /:id/positions/:positionId — removes position + transactions", async () => {
    const { h, a, portfolio } = await setup()

    await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })
    const listRes = await a.request(`/api/portfolios/${portfolio.id}/positions`, { headers: h.headers })
    const [pos] = await listRes.json()

    const delRes = await a.request(`/api/portfolios/${portfolio.id}/positions/${pos.id}`, {
      method: "DELETE",
      headers: h.headers,
    })
    expect(delRes.status).toBe(200)
    const removed = await delRes.json()
    expect(removed.isOpen).toBe(false)
    expect(removed.closedAt).toBeTruthy()

    const afterList = await a.request(`/api/portfolios/${portfolio.id}/positions`, { headers: h.headers })
    expect(await afterList.json()).toEqual([])

    const txRes = await a.request(`/api/portfolios/${portfolio.id}/transactions`, { headers: h.headers })
    const txBody = await txRes.json()
    expect(txBody.items.length).toBe(0)
  })

  it("DELETE /:id/positions/:positionId — unauthenticated → 401", async () => {
    const { h, a, portfolio } = await setup()
    await a.request(`/api/portfolios/${portfolio.id}/positions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ symbol: "TSLA", quantity: 4, price: 250 }),
    })
    const listRes = await a.request(`/api/portfolios/${portfolio.id}/positions`, { headers: h.headers })
    const [pos] = await listRes.json()

    const res = await a.request(`/api/portfolios/${portfolio.id}/positions/${pos.id}`, { method: "DELETE" })
    expect(res.status).toBe(401)
  })
})

describe("Aggregates & metrics (§15 Phase G)", () => {
  it("GET /total-metrics — aggregate from real data", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P1", currency: "USD" }),
    })
    const list = await a.request("/api/portfolios", { headers: h.headers })
    const portfolios = await list.json()
    const pid = portfolios[0].id

    // Fund the buy (notional + fee) so the deposit is the invested basis;
    // the BUY POST recompute reads net external flow for total_invested.
    await h.db.insert(portfolioCashTransactions).values({
      userId: h.user.id, portfolioId: pid, type: "DEPOSIT", amount: "1504.99", currency: "USD",
    })
    // BUY
    await a.request(`/api/portfolios/${pid}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })

    // §70 — the BUY leaves the position unpriced; give it a market price.
    await priceOpenPositions(h.db, pid, 150)
    const res = await a.request("/api/portfolios/total-metrics", { headers: h.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalValue).toBeGreaterThan(0)
    expect(body.capitalBasis).toBeGreaterThan(0)
    expect(body.portfolioBreakdown.length).toBe(1)
    expect(body.portfolioBreakdown[0].name).toBe("P1")
  })

  // §70.5 — PROD's IBKR held +64,898 EUR against −45,434 USD, so the net nearly
  // cancelled and the old `converted / net` produced weights of +648% and −398%
  // that cannot sum to 100%. The weight is a share of GROSS exposure; the
  // signed balance is still reported, because the user confirms the sign split
  // is real. This test pins both halves against exactly that shape.
  it("two consecutive /total-metrics calls are BYTE-IDENTICAL (§63.3)", async () => {
    // PROD 2026-09-27: `totalValue` came back 196,514.50 on one call and
    // 270,027.49 on the next, a minute apart, then stable — a 73,513 swing in a
    // number the user reads as a headline. "A headline that flickers is worse than
    // a wrong one, because it cannot be reasoned about."
    //
    // The mechanism was observed but never pinned, and that is why this sat open:
    // it was blocked on a PROD measurement nobody could reproduce. Since §76.1
    // reads calculate nothing and §76.4 left one writer per (portfolio, date),
    // the plausible cause is the read-path refresh that USED to run behind this
    // route. So the claim is testable rather than historical — and what is
    // asserted is the property, not the explanation.
    const h = await makeHarness()
    const a = app(h.db)
    mockInstrumentsFx({ table: { USD: 1.08, PLN: 4.3 } })
    try {
      for (const [name, cash, mv] of [["A", 1000, 0], ["B", 300, 700], ["C", 0, 0]] as const) {
        const res = await a.request("/api/portfolios", {
          method: "POST", headers: h.headers,
          body: JSON.stringify({ name, currency: "USD", baseCurrency: "PLN" }),
        })
        const { id } = await res.json()
        if (cash > 0) {
          await h.db.insert(portfolioCashTransactions).values({
            userId: h.user.id, portfolioId: id, type: "DEPOSIT", amount: String(cash), currency: "PLN",
          })
        }
        if (mv > 0) {
          await a.request(`/api/portfolios/${id}/positions`, {
            method: "POST", headers: h.headers,
            body: JSON.stringify({ symbol: "SNT.WA", quantity: 1, price: mv, currency: "PLN" }),
          })
          await priceOpenPositions(h.db, id, mv)
        }
      }

      const first = await (await a.request("/api/portfolios/total-metrics", { headers: h.headers })).text()
      const second = await (await a.request("/api/portfolios/total-metrics", { headers: h.headers })).text()
      // Byte-identical, not `toBeCloseTo`: a headline that rounds differently
      // between calls is the same defect at a smaller scale.
      expect(second).toBe(first)

      // …and still identical after a portfolio read, which is the call that used
      // to trigger the write behind the flicker.
      const list = await (await a.request("/api/portfolios", { headers: h.headers })).json()
      await a.request(`/api/portfolios/${list[0].id}/positions`, { headers: h.headers })
      const third = await (await a.request("/api/portfolios/total-metrics", { headers: h.headers })).text()
      expect(third).toBe(first)
    } finally { unmockInstrumentsFx() }
  })

  it("a /total-metrics read writes nothing — the mechanism behind §63.3's flicker", async () => {
    // The stronger form, and the one that catches a regression rather than a
    // coincidence: whatever the 73,513 swing was, it required this route to MOVE
    // stored state between calls. If a future edit reintroduces a write this fails
    // even when the two calls happen to agree.
    const h = await makeHarness()
    const a = app(h.db)
    mockInstrumentsFx({ table: { USD: 1.08, PLN: 4.3 } })
    try {
      const res = await a.request("/api/portfolios", {
        method: "POST", headers: h.headers,
        body: JSON.stringify({ name: "P", currency: "USD", baseCurrency: "PLN" }),
      })
      const { id } = await res.json()
      await h.db.insert(portfolioCashTransactions).values({
        userId: h.user.id, portfolioId: id, type: "DEPOSIT", amount: "1000", currency: "PLN",
      })
      await a.request(`/api/portfolios/${id}/positions`, {
        method: "POST", headers: h.headers,
        body: JSON.stringify({ symbol: "SNT.WA", quantity: 1, price: 700, currency: "PLN" }),
      })
      await priceOpenPositions(h.db, id, 700)

      const state = async () => ({
        positions: await h.db
          .select({ mv: positions.marketValue, asOf: positions.priceAsOf })
          .from(positions).where(positionInPortfolio(id)),
        currentValue: (await h.db.select({ v: portfolios.currentValue })
          .from(portfolios).where(eq(portfolios.id, id)))[0].v,
        snapshots: await h.db.select().from(valueSnapshots).where(eq(valueSnapshots.portfolioId, id)),
      })

      const before = await state()
      await a.request("/api/portfolios/total-metrics", { headers: h.headers })
      const after = await state()

      expect(after.positions).toEqual(before.positions)
      expect(after.currentValue).toBe(before.currentValue)
      expect(after.snapshots).toEqual(before.snapshots)
    } finally { unmockInstrumentsFx() }
  })

  it("cashBreakdown weights are shares of GROSS exposure, and always sum to 100% (§70.5)", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    // Identity rate for USD→USD so the numbers below are the raw balances.
    mockInstrumentsFx({ table: { USD: 1, EUR: 1, PLN: 1 } })
    try {
      const res0 = await a.request("/api/portfolios", {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify({ name: "MIXED", baseCurrency: "USD" }),
      })
      const pf = await res0.json()
      await h.db.insert(portfolioCashTransactions).values([
        { userId: h.user.id, portfolioId: pf.id, type: "DEPOSIT", amount: "64898", currency: "EUR" },
        // The sign lives on the amount, not the type — a WITHDRAWAL row is
        // stored negative.
        { userId: h.user.id, portfolioId: pf.id, type: "WITHDRAWAL", amount: "-45434", currency: "USD" },
      ])

      const res = await a.request("/api/portfolios/total-metrics", { headers: h.headers })
      expect(res.status).toBe(200)
      const body = await res.json()
      const rows = body.cashBreakdown as Array<{ currency: string; balance: number; weight: number }>
      expect(rows.map((r) => r.currency)).toEqual(["EUR", "USD"])

      // The signed balance is reported as-is — the sign split is real.
      expect(rows.find((r) => r.currency === "EUR")!.balance).toBe(64898)
      expect(rows.find((r) => r.currency === "USD")!.balance).toBe(-45434)

      // Every weight is in [0, 100] and they sum to 100. The net is 19,464, so
      // the old formula would have printed 333% and −233%.
      for (const r of rows) {
        expect(r.weight).toBeGreaterThanOrEqual(0)
        expect(r.weight).toBeLessThanOrEqual(100)
      }
      const sum = rows.reduce((s, r) => s + r.weight, 0)
      expect(sum).toBeCloseTo(100, 1)
      // EUR 64,898 of a 110,332 gross = 58.83%
      expect(rows.find((r) => r.currency === "EUR")!.weight).toBeCloseTo(58.83, 1)
    } finally {
      unmockInstrumentsFx()
    }
  })

  it("cashBreakdown weight is 0, not NaN, when the account holds no cash (§70.5)", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    mockInstrumentsFx({ table: { USD: 1, PLN: 1 } })
    try {
      const res0 = await a.request("/api/portfolios", {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify({ name: "EMPTY", baseCurrency: "USD" }),
      })
      const pf = await res0.json()
      await h.db.insert(portfolioCashTransactions).values({
        userId: h.user.id, portfolioId: pf.id, type: "DEPOSIT", amount: "100", currency: "USD",
      })
      await a.request(`/api/portfolios/${pf.id}/positions`, {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify({ symbol: "AAPL", quantity: 1, price: 100, currency: "USD" }),
      })
      await priceOpenPositions(h.db, pf.id, 100)
      // Spend the whole deposit so nothing is left in cash.
      await h.db.insert(portfolioCashTransactions).values({
        userId: h.user.id, portfolioId: pf.id, type: "WITHDRAWAL", amount: "-100", currency: "USD",
      })

      const res = await a.request("/api/portfolios/total-metrics", { headers: h.headers })
      const body = await res.json()
      const rows = (body.cashBreakdown ?? []) as Array<{ weight: number }>
      for (const r of rows) expect(Number.isFinite(r.weight)).toBe(true)
    } finally {
      unmockInstrumentsFx()
    }
  })

  it("GET /total-metrics — converts per-portfolio values to the aggregate base (§48.6e B5)", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    // EUR-quoted table: PLN→USD = 2/4 = 0.5 (the D27 cross-rate).
    // Declare the USD preference explicitly so the aggregate base is USD
    // deterministically — otherwise it is a fragile row-order tie-break
    // between the two portfolio bases (1 PLN + 1 USD).
    mockInstrumentsFx({ table: { USD: 2, PLN: 4 }, preferences: { baseCurrency: "USD" } })
    try {
      // PLN-base portfolio (prod shape: `currency` left at the API default,
      // base declared separately) holding a PLN position.
      const plnRes = await a.request("/api/portfolios", {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify({ name: "PLN P", currency: "USD", baseCurrency: "PLN" }),
      })
      const pln = await plnRes.json()
      // 1500 PLN deposit = the invested basis for the PLN position.
      await h.db.insert(portfolioCashTransactions).values({
        userId: h.user.id, portfolioId: pln.id, type: "DEPOSIT", amount: "1500", currency: "PLN",
      })
      await a.request(`/api/portfolios/${pln.id}/positions`, {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify({ symbol: "SNT.WA", quantity: 10, price: 150, currency: "PLN" }),
      })
      await priceOpenPositions(h.db, pln.id, 150) // §70

      // Plain USD portfolio (identity rate) for the cross-currency sum.
      await a.request("/api/portfolios", {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify({ name: "P1", currency: "USD" }),
      })
      const list = await a.request("/api/portfolios", { headers: h.headers })
      const usd = (await list.json()).find((p: { name: string }) => p.name === "P1")
      // Fund the P1 buy (1500 + 4.99 fee) — the deposit is its invested basis.
      await h.db.insert(portfolioCashTransactions).values({
        userId: h.user.id, portfolioId: usd.id, type: "DEPOSIT", amount: "1504.99", currency: "USD",
      })
      await a.request(`/api/portfolios/${usd.id}/transactions`, {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify(BUY_BODY),
      })
      await priceOpenPositions(h.db, usd.id, 150) // §70: BUY leaves it unpriced

      const res = await a.request("/api/portfolios/total-metrics", { headers: h.headers })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.baseCurrency).toBe("USD")
      // 10×150 PLN × 0.5 = 750 USD — never 1,500 raw PLN as USD.
      expect(body.totalValue).toBeCloseTo(750 + 1500, 2)
      // invested = net external flow (the deposits): 1500 PLN→750 + 1504.99 USD.
      expect(body.capitalBasis).toBeCloseTo(750 + 1504.99, 2)
      const byName = (n: string) => body.portfolioBreakdown.find((r: { name: string }) => r.name === n)
      expect(byName("PLN P").totalValue).toBeCloseTo(750, 2)
      expect(byName("PLN P").capitalBasis).toBeCloseTo(750, 2)
      expect(byName("P1").totalValue).toBeCloseTo(1500, 2)
      expect(byName("P1").capitalBasis).toBeCloseTo(1504.99, 2)
    } finally {
      unmockInstrumentsFx()
    }
  })

  it("GET /held-stocks — open positions grouped by symbol", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P1", currency: "USD" }),
    })
    const list = await a.request("/api/portfolios", { headers: h.headers })
    const portfolios = await list.json()

    await a.request(`/api/portfolios/${portfolios[0].id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })

    const res = await a.request("/api/portfolios/held-stocks", { headers: h.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.stocks.length).toBe(1)
    expect(body.stocks[0].symbol).toBe("AAPL")
    expect(body.stocks[0].totalQuantity).toBe(10)
    expect(body.stocks[0].currentPrice).toBe(150)
  })

  it("GET /:id/summary-metrics — per-portfolio computed metrics", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P1", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })
    // §62.4 — fund the position so cash nets to 0 and totalValue = the
    // position value. A BUY draws (notional + fee) from the account, so the
    // funding deposit is 1500 + 4.99.
    await h.db.insert(portfolioCashTransactions).values({
      userId: h.user.id,
      portfolioId: portfolio.id,
      type: "DEPOSIT",
      amount: "1504.99",
      currency: "USD",
    })
    await priceOpenPositions(h.db, portfolio.id, 150) // §70: BUY leaves it unpriced

    const res = await a.request(`/api/portfolios/${portfolio.id}/summary-metrics`, { headers: h.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalValue).toBe(1500)
    expect(body.costBasis).toBe(1500)
    expect(body.positionCount).toBe(1)
    expect(body.realizedGain).toBe(0)
  })

  it("GET /:id/summary-metrics — with realized PnL after SELL", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P1", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    // BUY then SELL at profit
    await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })
    await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ ...BUY_BODY, type: "SELL", quantity: 5, price: 170 }),
    })

    const res = await a.request(`/api/portfolios/${portfolio.id}/summary-metrics`, { headers: h.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.positionCount).toBe(1)
    // realizedGain should be > 0 (sell proceeds minus cost basis minus fees)
    expect(body.realizedGain).toBeGreaterThan(0)
  })
})

describe("Shares CRUD (§15 Phase G3/G4)", () => {
  it("POST /shares — create share", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P1", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    const res = await a.request("/api/portfolios/shares", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ portfolioId: portfolio.id, displayName: "My P1" }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.portfolioId).toBe(portfolio.id)
    expect(body.displayName).toBe("My P1")
    expect(body.viewCount).toBe(0)
    expect(body.privacySettings.showValues).toBe(true)
  })

  it("POST /shares — portfolio not found → 404", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const res = await a.request("/api/portfolios/shares", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ portfolioId: "00000000-0000-0000-0000-000000000000" }),
    })
    expect(res.status).toBe(404)
  })

  it("POST /shares — 10-limit enforcement", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P1", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    // Create 10 shares
    for (let i = 0; i < 10; i++) {
      await a.request("/api/portfolios/shares", {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify({ portfolioId: portfolio.id, displayName: `Share ${i}` }),
      })
    }

    // 11th should fail
    const res = await a.request("/api/portfolios/shares", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ portfolioId: portfolio.id, displayName: "Too many" }),
    })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBe("LimitReached")
  })

  it("GET /shares — list user shares", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P1", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    await a.request("/api/portfolios/shares", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ portfolioId: portfolio.id, displayName: "My Share" }),
    })

    const res = await a.request("/api/portfolios/shares", { headers: h.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.length).toBe(1)
    expect(body[0].portfolioName).toBe("P1")
  })

  it("DELETE /shares/:id — delete share", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P1", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    const shareRes = await a.request("/api/portfolios/shares", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ portfolioId: portfolio.id, displayName: "To Delete" }),
    })
    const share = await shareRes.json()

    const res = await a.request(`/api/portfolios/shares/${share.id}`, {
      method: "DELETE",
      headers: h.headers,
    })
    expect(res.status).toBe(204)

    // Verify deleted
    const listRes = await a.request("/api/portfolios/shares", { headers: h.headers })
    const body = await listRes.json()
    expect(body.length).toBe(0)
  })

  it("GET /public/:shareId — public view increments view count", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    const pa = publicApp(h.db)

    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P1", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    const shareRes = await a.request("/api/portfolios/shares", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ portfolioId: portfolio.id, displayName: "Public" }),
    })
    const share = await shareRes.json()

    // View public share (no auth needed)
    const res = await pa.request(`/api/portfolios/public/${share.id}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.displayName).toBe("Public")
    expect(body.portfolio.name).toBe("P1")
  })

  it("GET /public/:shareId — not found → 404", async () => {
    const h = await makeHarness()
    const pa = publicApp(h.db)

    const res = await pa.request("/api/portfolios/public/00000000-0000-0000-0000-000000000000")
    expect(res.status).toBe(404)
  })
})

describe("Portfolio dividends (§49)", () => {
  async function makeTestPortfolio(h: Awaited<ReturnType<typeof makeHarness>>, a: ReturnType<typeof app>) {
    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", baseCurrency: "USD" }),
    })
    return await createRes.json()
  }

  it("DIVIDEND with tax — net totalAmount persisted, wallet credited net (§49.3)", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    const portfolio = await makeTestPortfolio(h, a)

    const res = await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({
        type: "DIVIDEND",
        symbol: "AAPL",
        quantity: 10,
        price: 2,
        currency: "USD",
        taxes: 3,
        notes: "april payout",
        executedAt: "2026-01-10T00:00:00Z",
      }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.type).toBe("DIVIDEND")
    expect(body.totalAmount).toBe(17) // 10×2 − 3 withholding
    expect(body.taxes).toBe(3)
    expect(body.notes).toBe("april payout")
  })

  it("DIVIDEND without tax — net = gross, taxes null (§49.3)", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    const portfolio = await makeTestPortfolio(h, a)

    const res = await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({
        type: "DIVIDEND",
        symbol: "MSFT",
        quantity: 5,
        price: 4,
        currency: "USD",
        executedAt: "2026-02-10T00:00:00Z",
      }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.totalAmount).toBe(20) // net = gross
    expect(body.taxes).toBeNull()
  })

  it("DIVIDEND taxes > gross → 422 (§49.3)", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    const portfolio = await makeTestPortfolio(h, a)

    const res = await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({
        type: "DIVIDEND",
        symbol: "AAPL",
        quantity: 1,
        price: 2,
        currency: "USD",
        taxes: 2.5,
      }),
    })
    expect(res.status).toBe(422)
  })

  it("PATCH DIVIDEND — taxes/notes change re-derives net totalAmount + wallet delta (§49.3)", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    const portfolio = await makeTestPortfolio(h, a)

    const post = await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({
        type: "DIVIDEND",
        symbol: "AAPL",
        quantity: 10,
        price: 2,
        currency: "USD",
        taxes: 1,
        executedAt: "2026-03-10T00:00:00Z",
      }),
    })
    const tx = await post.json()
    expect(tx.totalAmount).toBe(19)

    const patchRes = await a.request(`/api/portfolios/${portfolio.id}/transactions/${tx.id}`, {
      method: "PATCH",
      headers: h.headers,
      body: JSON.stringify({ taxes: 3, notes: "corrected withholding" }),
    })
    expect(patchRes.status).toBe(200)
    const patched = await patchRes.json()
    expect(patched.totalAmount).toBe(17)
    expect(patched.taxes).toBe(3)
    expect(patched.notes).toBe("corrected withholding")

    // taxes > gross on patch → 422
    const bad = await a.request(`/api/portfolios/${portfolio.id}/transactions/${tx.id}`, {
      method: "PATCH",
      headers: h.headers,
      body: JSON.stringify({ taxes: 99 }),
    })
    expect(bad.status).toBe(422)
  })

  it("GET /:id/dividends — aggregates real DIVIDEND rows, date desc + totals (§49.3)", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    const portfolio = await makeTestPortfolio(h, a)

    const record = (body: Record<string, unknown>) =>
      a.request(`/api/portfolios/${portfolio.id}/transactions`, {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify(body),
      })

    // older dividend WITH tax
    await record({ type: "DIVIDEND", symbol: "AAPL", quantity: 10, price: 2, currency: "USD", taxes: 3, executedAt: "2026-01-10T00:00:00Z" })
    // newer dividend without tax
    await record({ type: "DIVIDEND", symbol: "MSFT", quantity: 5, price: 4, currency: "USD", executedAt: "2026-02-10T00:00:00Z" })

    const res = await a.request(`/api/portfolios/${portfolio.id}/dividends`, { headers: h.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.count).toBe(2)
    expect(body.items).toHaveLength(2)
    // newest first (MSFT recorded later)
    expect(body.items[0].symbol).toBe("MSFT")
    expect(body.items[0].gross).toBe(20)
    expect(body.items[0].taxes).toBeNull()
    expect(body.items[0].amount).toBe(20)
    expect(body.items[1].symbol).toBe("AAPL")
    expect(body.items[1].gross).toBe(20)
    expect(body.items[1].taxes).toBe(3)
    expect(body.items[1].amount).toBe(17)
    expect(body.items[1].notes).toBeNull()
    expect(body.totalDividends).toBe(37) // 20 + 17 (display ccy net sum)
  })

  it("GET /:id/dividends — items carry the instrument identity, null when absent (§61.3)", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    const portfolio = await makeTestPortfolio(h, a)

    const record = (body: Record<string, unknown>) =>
      a.request(`/api/portfolios/${portfolio.id}/transactions`, {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify(body),
      })

    // newer, WITH an identity — newest first, so it comes back at index 0.
    // §116: country is read from the joined position, so establish the holding
    // and link the dividend to it (the SPA's RecordDividendDialog always passes
    // positionId).
    const buyRes = await record({
      type: "BUY",
      symbol: "SAP.DE",
      quantity: 5,
      price: 2,
      currency: "EUR",
      assetType: "ETF",
      country: "PL",
      executedAt: "2026-04-01T00:00:00Z",
    })
    const buyBody = await buyRes.json()
    await record({
      type: "DIVIDEND",
      symbol: "SAP.DE",
      quantity: 5,
      price: 2,
      currency: "EUR",
      assetType: "ETF",
      positionId: buyBody.position.id,
      executedAt: "2026-05-10T00:00:00Z",
    })
    // older, WITHOUT one
    await record({
      type: "DIVIDEND",
      symbol: "AAPL",
      quantity: 10,
      price: 2,
      currency: "USD",
      executedAt: "2026-01-10T00:00:00Z",
    })

    const res = await a.request(`/api/portfolios/${portfolio.id}/dividends`, { headers: h.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items[0].symbol).toBe("SAP.DE")
    expect(body.items[0].assetType).toBe("ETF")
    expect(body.items[0].country).toBe("PL")
    // A row without them reports null — never a guessed class or country.
    expect(body.items[1].symbol).toBe("AAPL")
    expect(body.items[1].assetType).toBe("STOCK") // the route's own default
    expect(body.items[1].country).toBeNull()
  })

  it("BUY/SELL totals unchanged by §49 dividend changes (§49.3)", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    const portfolio = await makeTestPortfolio(h, a)

    await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })
    const sellRes = await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ ...SELL_BODY, quantity: 5 }),
    })
    const sell = await sellRes.json()
    expect(sell.totalAmount).toBe(170 * 5) // gross, unchanged
    expect(sell.taxes).toBeNull()
  })
})

/**
 * §68 — cash is a first-class citizen: the headline total is instruments + cash.
 *
 * These exist because the three code paths that answered "what is this
 * portfolio worth" had already drifted — quotes.ts added cash, /total-metrics did
 * not (so the dashboard headline missed the cash balance by exactly the cash
 * balance, §63.3), and /summary-metrics summed positions with no FX conversion
 * at all while declaring the portfolio's base currency on the same object.
 */
describe("§68: instruments + cash == total, everywhere", () => {
  it("a portfolio with positions AND cash: currentValue == instrumentsValue + cashValue", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    mockInstrumentsFx({ table: { USD: 1.08, PLN: 4.3 } })
    try {
      const res = await a.request("/api/portfolios", {
        method: "POST", headers: h.headers,
        body: JSON.stringify({ name: "P", currency: "USD", baseCurrency: "PLN" }),
      })
      const { id } = await res.json()
      // deposit, then spend only part of it so cash remains
      await h.db.insert(portfolioCashTransactions).values([
        { userId: h.user.id, portfolioId: id, type: "DEPOSIT", amount: "2000", currency: "PLN" },
        { userId: h.user.id, portfolioId: id, type: "WITHDRAWAL", amount: "500", currency: "PLN" },
      ])
      await a.request(`/api/portfolios/${id}/positions`, {
        method: "POST", headers: h.headers,
        body: JSON.stringify({ symbol: "SNT.WA", quantity: 10, price: 100, currency: "PLN" }),
      })
      // §70 — a position is inserted UNPRICED; state its market price explicitly.
      // Valued at cost it would coincidentally be 100 too, which is exactly why
      // the cost fallback went unnoticed: buy price == market price on day one.
      await priceOpenPositions(h.db, id, 100)

      const m = await (await a.request(`/api/portfolios/${id}/summary-metrics`, { headers: h.headers })).json()
      expect(m.cashValue).toBe(1500)
      expect(m.positionValue).toBe(1000)
      expect(m.totalValue).toBe(2500)
      // the identity the whole section exists to enforce
      expect(m.totalValue).toBeCloseTo(m.positionValue + m.cashValue, 2)
    } finally { unmockInstrumentsFx() }
  })

  it("the headline total equals Σ per-portfolio totals, and equals instruments + cash", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    mockInstrumentsFx({ table: { USD: 1.08, PLN: 4.3 } })
    try {
      for (const [name, cash, mv] of [["A", 1000, 0], ["B", 300, 700]] as const) {  // §70: price B below
        const res = await a.request("/api/portfolios", {
          method: "POST", headers: h.headers,
          body: JSON.stringify({ name, currency: "USD", baseCurrency: "PLN" }),
        })
        const { id } = await res.json()
        await h.db.insert(portfolioCashTransactions).values({
          userId: h.user.id, portfolioId: id, type: "DEPOSIT", amount: String(cash), currency: "PLN",
        })
        if (mv > 0) {
          await a.request(`/api/portfolios/${id}/positions`, {
            method: "POST", headers: h.headers,
            body: JSON.stringify({ symbol: "SNT.WA", quantity: 1, price: mv, currency: "PLN" }),
          })
          await priceOpenPositions(h.db, id, mv)
        }
      }

      const body = await (await a.request("/api/portfolios/total-metrics", { headers: h.headers })).json()
      // EXACT equality, not toBeCloseTo: PROD caught a cent of drift here
      // (IKE Marek 27,684.94 + 239.45 reported as 27,924.38) because the route
      // rounded the raw sum instead of the rounded parts. The contract promises
      // these are equal, so the response has to make that literally true.
      expect(body.totalValue).toBe(body.instrumentsValue + body.cashValue)
      const sumRows = Math.round(body.portfolioBreakdown.reduce((s: number, p: any) => s + p.totalValue, 0) * 100) / 100
      expect(body.totalValue).toBe(sumRows)
      // every row carries its own split, and it is internally consistent
      for (const p of body.portfolioBreakdown) {
        expect(p.totalValue).toBe(Math.round((p.instrumentsValue + p.cashValue) * 100) / 100)
      }
    } finally { unmockInstrumentsFx() }
  })

  it("a cash-only portfolio reports instrumentsValue 0 and is not dropped from the total", async () => {
    // PROD shape: Crypto holds 887.74 PLN of cash and nothing else, and the old
    // weights floored it at 0 / -100% while its card read +1.65%.
    const h = await makeHarness()
    const a = app(h.db)
    mockInstrumentsFx({ table: { USD: 1.08, PLN: 4.3 } })
    try {
      const res = await a.request("/api/portfolios", {
        method: "POST", headers: h.headers,
        body: JSON.stringify({ name: "Crypto", currency: "USD", baseCurrency: "PLN" }),
      })
      const { id } = await res.json()
      await h.db.insert(portfolioCashTransactions).values({
        userId: h.user.id, portfolioId: id, type: "DEPOSIT", amount: "887.74", currency: "PLN",
      })
      const body = await (await a.request("/api/portfolios/total-metrics", { headers: h.headers })).json()
      const row = body.portfolioBreakdown[0]
      expect(row.instrumentsValue).toBe(0)
      expect(row.cashValue).toBe(887.74)
      expect(row.totalValue).toBe(887.74)
      // it must carry weight, not floor at zero
      expect(row.weight).toBeGreaterThan(0)
    } finally { unmockInstrumentsFx() }
  })

  it("NEGATIVE cash reduces the total and is not clamped (§68.3)", async () => {
    // XTB and IKE Beata are margin accounts: the cash ledger goes below zero.
    const h = await makeHarness()
    const a = app(h.db)
    mockInstrumentsFx({ table: { USD: 1.08, PLN: 4.3 } })
    try {
      const res = await a.request("/api/portfolios", {
        method: "POST", headers: h.headers,
        body: JSON.stringify({ name: "XTB", currency: "USD", baseCurrency: "PLN" }),
      })
      const { id } = await res.json()
      // the sign lives in `amount`, not in `type` — the replay sums amount as-is.
      // PROD shape: IBKR's negative balance is 5 WITHDRAWAL rows totalling -121130.
      await h.db.insert(portfolioCashTransactions).values({
        userId: h.user.id, portfolioId: id, type: "WITHDRAWAL", amount: "-1200", currency: "PLN",
      })
      const m = await (await a.request(`/api/portfolios/${id}/summary-metrics`, { headers: h.headers })).json()
      expect(m.cashValue).toBe(-1200)
      expect(m.instrumentsValue ?? m.positionValue).toBe(0)
      expect(m.totalValue).toBe(-1200) // negative, NOT clamped to 0
      const body = await (await a.request("/api/portfolios/total-metrics", { headers: h.headers })).json()
      expect(body.cashValue).toBe(-1200)
      expect(body.totalValue).toBe(-1200)
    } finally { unmockInstrumentsFx() }
  })

  it("multi-currency positions are each converted; a raw cross-currency sum is not (§68.3)", async () => {
    // positionsValue used to `reduce` marketValue with NO fx, while the same
    // response declared `currency: PLN`.
    const h = await makeHarness()
    const a = app(h.db)
    // EUR-quoted: USD=1.08, PLN=4.3  =>  USD->PLN = 1.08/4.3
    mockInstrumentsFx({ table: { USD: 1.08, PLN: 4.3 } })
    try {
      const res = await a.request("/api/portfolios", {
        method: "POST", headers: h.headers,
        body: JSON.stringify({ name: "Multi", currency: "USD", baseCurrency: "PLN" }),
      })
      const { id } = await res.json()
      for (const [symbol, qty, price, ccy] of [["AAPL", 10, 100, "USD"], ["SNT.WA", 10, 100, "PLN"]] as const) {
        await a.request(`/api/portfolios/${id}/positions`, {
          method: "POST", headers: h.headers,
          body: JSON.stringify({ symbol, quantity: qty, price, currency: ccy }),
        })
      }
      // §70 — market prices, distinct from the cost basis where it matters, so
      // the test proves CONVERSION rather than accidentally proving the fallback.
      await priceOpenPositions(h.db, id, 100)
      const m = await (await a.request(`/api/portfolios/${id}/summary-metrics`, { headers: h.headers })).json()
      const rate = crossRate("USD", "PLN", { EUR: 1, USD: 1.08, PLN: 4.3 })!
      const expected = 1000 * rate + 1000
      expect(m.positionValue).toBeCloseTo(expected, 1)
      // the naive raw sum would have been 2000 — i.e. wrong whenever the
      // portfolio holds positions in more than one currency
      expect(m.positionValue).not.toBeCloseTo(2000, 0)
    } finally { unmockInstrumentsFx() }
  })

  it("a missing FX rate THROWS rather than valuing 1:1 (§66.4 on the split path)", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    mockInstrumentsFx({ table: {} }) // only EUR known: every USD->PLN pair 404s
    try {
      const res = await a.request("/api/portfolios", {
        method: "POST", headers: h.headers,
        body: JSON.stringify({ name: "P", currency: "USD", baseCurrency: "PLN" }),
      })
      const { id } = await res.json()
      await a.request(`/api/portfolios/${id}/positions`, {
        method: "POST", headers: h.headers,
        body: JSON.stringify({ symbol: "AAPL", quantity: 1, price: 100, currency: "USD" }),
      })
      // must fail loudly — not report 100 "PLN"
      const res2 = await a.request(`/api/portfolios/${id}/summary-metrics`, { headers: h.headers })
      expect(res2.status).not.toBe(200)
    } finally { unmockInstrumentsFx() }
  })

  it("the reported baseCurrency is the one the numbers were converted into (§66.4 residual)", async () => {
    // This response used to report a hardcoded "USD" while converting into the
    // real aggregate base — invisible while the preference defaulted to USD, and
    // exactly what §67.1's write-through would have made visible.
    const h = await makeHarness()
    const a = app(h.db)
    mockInstrumentsFx({ table: { USD: 1.08, PLN: 4.3 } })
    try {
      const res = await a.request("/api/portfolios", {
        method: "POST", headers: h.headers,
        body: JSON.stringify({ name: "PLN P", currency: "USD", baseCurrency: "PLN" }),
      })
      const { id } = await res.json()
      await h.db.insert(portfolioCashTransactions).values({
        userId: h.user.id, portfolioId: id, type: "DEPOSIT", amount: "1000", currency: "PLN",
      })
      const body = await (await a.request("/api/portfolios/total-metrics", { headers: h.headers })).json()
      // every portfolio is PLN-based, so the honest aggregate base is PLN — and it
      // must not be reported as USD
      expect(body.baseCurrency).toBe("PLN")
    } finally { unmockInstrumentsFx() }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §63.2 — the headline must equal the chart's last point.
//
// The comparison a user actually makes is "add up the cards, compare with the
// last dot on the chart". Nothing asserted that end to end: `portfolio-
// transactions.test.ts` above pins the headline against Σ per-portfolio rows,
// and `backfill.test.ts:1102` pins the live path against the batch — but no
// test compared the ROUTE's number with the STORED snapshot row, which is the
// pair that drifted (§70 found 75/85 positions with `market_value` NULL, and
// the chart came from bars while the headline came from the column).
//
// Condition, stated rather than assumed: quotes fresh. The headline reads
// `positions.market_value` and the snapshot reads `price_bars.close`, so they
// agree only when the quote and the bar are the same moment. A test that
// asserted equality unconditionally would have to lie about one of the two.
//
describe("§63.2: the headline total equals the latest snapshot (quotes fresh)", () => {
  // NOTE on the arithmetic below: `POST /positions` opens a position by writing a
  // BUY, and a BUY is a cash OUTFLOW in `cashBalances` (cashLedger.ts:61,
  // `principalSign = tx.type === "BUY" ? -1 : 1`). So a deposit of 1500 plus a
  // 1000 purchase leaves 500 of cash, not 1500. Asserting the naive number here
  // would have "caught" a bug that does not exist.

  it("a per-portfolio totalValue equals its newest value_snapshots row to the cent", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    mockInstrumentsFx({ table: { USD: 1.08, PLN: 4.3 } })
    try {
      const res = await a.request("/api/portfolios", {
        method: "POST", headers: h.headers,
        body: JSON.stringify({ name: "P", currency: "USD", baseCurrency: "PLN" }),
      })
      const { id } = await res.json()
      await h.db.insert(portfolioCashTransactions).values({
        userId: h.user.id, portfolioId: id, type: "DEPOSIT", amount: "1500", currency: "PLN",
      })
      await a.request(`/api/portfolios/${id}/positions`, {
        method: "POST", headers: h.headers,
        body: JSON.stringify({ symbol: "SNT.WA", quantity: 10, price: 100, currency: "PLN" }),
      })
      await priceOpenPositions(h.db, id, 100)   // 10 × 100 = 1000 instruments
      // 1500 deposited − 1000 spent = 500 cash, + 1000 instruments.
      await h.db.insert(valueSnapshots).values({
        portfolioId: id, snapshotDate: "2026-09-29", value: "1500", invested: "1000", netFlow: "1500",
      })

      const body = await (await a.request("/api/portfolios/total-metrics", { headers: h.headers })).json()
      const row = body.portfolioBreakdown[0]
      expect(row.instrumentsValue).toBe(1000)
      expect(row.cashValue).toBe(500)
      expect(row.totalValue).toBe(1500)

      // The comparison §63.2 was opened for: the dashboard headline is the last
      // dot on the chart. Same portfolio, same day, same cent.
      const last = await h.db
        .select({ value: valueSnapshots.value })
        .from(valueSnapshots)
        .where(eq(valueSnapshots.portfolioId, id))
      expect(row.totalValue).toBe(Number(last[0].value))

      // …and the aggregate, which is the number the headline tile prints.
      expect(body.totalValue).toBe(1500)
    } finally { unmockInstrumentsFx() }
  })

  it("an UNPRICED position contributes nothing to instrumentsValue and is counted (§70)", async () => {
    // The case that actually discriminates. Cost basis 900/unit and a NULL
    // market_value: a route that fell back to cost would report 9000 of
    // instruments. §70 says an unpriced position is worth an unknown amount, so
    // it contributes 0 and is reported as unpriced.
    const h = await makeHarness()
    const a = app(h.db)
    mockInstrumentsFx({ table: { USD: 1.08, PLN: 4.3 } })
    try {
      const res = await a.request("/api/portfolios", {
        method: "POST", headers: h.headers,
        body: JSON.stringify({ name: "Unpriced", currency: "USD", baseCurrency: "PLN" }),
      })
      const { id } = await res.json()
      await a.request(`/api/portfolios/${id}/positions`, {
        method: "POST", headers: h.headers,
        body: JSON.stringify({ symbol: "GHOST", quantity: 10, price: 900, currency: "PLN" }),
      })
      // deliberately NOT priced: market_value stays NULL

      const body = await (await a.request("/api/portfolios/total-metrics", { headers: h.headers })).json()
      const row = body.portfolioBreakdown[0]
      expect(row.unpricedPositions).toBe(1)
      // the cost-basis answer this must never produce
      expect(row.instrumentsValue).toBe(0)
      expect(row.instrumentsValue).not.toBe(9000)
      // cash went out for the purchase and nothing came back in, so the total is
      // the −9000 outflow with no instrument to show for it. Stated explicitly
      // because "a portfolio worth −9000" reads like a bug until you know the
      // buy consumed the cash.
      expect(row.cashValue).toBe(-9000)
      expect(row.totalValue).toBe(-9000)
    } finally { unmockInstrumentsFx() }
  })

  it("a half-priced portfolio reports the priced half and flags the rest", async () => {
    // §70's contract decision: flagged, not hidden. Suppressing the portfolio
    // would make a broken pipeline look like an empty one; valuing the unpriced
    // lot at cost would make it look fine.
    const h = await makeHarness()
    const a = app(h.db)
    mockInstrumentsFx({ table: { USD: 1.08, PLN: 4.3 } })
    try {
      const res = await a.request("/api/portfolios", {
        method: "POST", headers: h.headers,
        body: JSON.stringify({ name: "Half", currency: "USD", baseCurrency: "PLN" }),
      })
      const { id } = await res.json()
      for (const symbol of ["PRICED", "GHOST"]) {
        await a.request(`/api/portfolios/${id}/positions`, {
          method: "POST", headers: h.headers,
          body: JSON.stringify({ symbol, quantity: 10, price: 900, currency: "PLN" }),
        })
      }
      await priceOpenPositions(h.db, id, 100)   // both quoted…
      // …then GHOST's quote is lost, which is the real shape: a symbol that
      // priced yesterday and has no quote today.
      await h.db
        .update(positions)
        .set({ marketValue: null })
        .where(and(positionInPortfolio(id), eq(positions.symbol, "GHOST")))

      const body = await (await a.request("/api/portfolios/total-metrics", { headers: h.headers })).json()
      const row = body.portfolioBreakdown[0]
      expect(row.unpricedPositions).toBe(1)
      expect(row.instrumentsValue).toBe(1000)              // 10 × 100, the priced lot
      // 10 000 would be the "no position went missing" reading, and 19 000 the
      // "value the unpriced lot at cost" one.
      expect(row.instrumentsValue).not.toBe(10000)
      expect(row.instrumentsValue).not.toBe(19000)
    } finally { unmockInstrumentsFx() }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// §76.1 — read purity. A GET must not write.
//
// These tests are built to have TEETH: instruments is mocked to return a price
// that differs from the seeded one, so if `refreshQuotes` were still reachable
// from a GET, market_value / price_as_of / value_snapshots would all move and
// the assertions below would fail. Asserting the response body alone would pass
// with the write still in place, which is the mistake D58 made.
// ─────────────────────────────────────────────────────────────────────────────
describe("§76.1 — GET read paths are pure (no writes)", () => {
  /** Quote the mocks will return: deliberately ≠ the seeded cost of 150. */
  const LIVE_PRICE = 999

  function mockInstrumentsQuote() {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const u = String(url)
        if (u.includes("/profile")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              ticker: "AAPL",
              name: "Apple Inc.",
              country: "US",
              finnhubIndustry: "Technology",
              currency: "USD",
              currencySource: "provider",
            }),
          })
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({
            symbol: "AAPL",
            currentPrice: LIVE_PRICE,
            change: 0,
            percentChange: 0,
            currency: "USD",
          }),
        })
      }),
    )
  }

  /** Everything a pricing read would touch, captured in one comparable object. */
  async function captureState(
    db: Awaited<ReturnType<typeof makeHarness>>["db"],
    portfolioId: string,
  ) {
    const snaps = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(valueSnapshots)
      .where(eq(valueSnapshots.portfolioId, portfolioId))
    const pf = await db
      .select({ currentValue: portfolios.currentValue })
      .from(portfolios)
      .where(eq(portfolios.id, portfolioId))
    const pos = await db
      .select({
        symbol: positions.symbol,
        marketValue: positions.marketValue,
        priceAsOf: positions.priceAsOf,
        priceSource: positions.priceSource,
      })
      .from(positions)
      .where(positionInPortfolio(portfolioId))
    return {
      snapshotCount: snaps[0]?.n ?? 0,
      currentValue: pf[0]?.currentValue ?? null,
      positions: pos.map((p) => ({
        symbol: p.symbol,
        marketValue: p.marketValue,
        priceAsOf: p.priceAsOf ? new Date(p.priceAsOf).toISOString() : null,
        priceSource: p.priceSource,
      })),
    }
  }

  /** A portfolio with one open AAPL position bought at 150, deliberately stale. */
  async function seedStalePortfolio(a: Hono, h: Awaited<ReturnType<typeof makeHarness>>) {
    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "Purity", currency: "USD" }),
    })
    const portfolio = await createRes.json()
    // Buy, then hand the position a stale price so a refresh would be visible.
    await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })
    await h.db
      .update(positions)
      .set({ marketValue: "1500", priceAsOf: null, priceSource: "manual" })
      .where(positionInPortfolio(portfolio.id))
    await h.db
      .update(portfolios)
      .set({ currentValue: "1500" })
      .where(eq(portfolios.id, portfolio.id))
    return portfolio.id as string
  }

  const READS = [
    { name: "GET /:id/positions", path: (id: string) => `/api/portfolios/${id}/positions` },
    { name: "GET /:id/allocation", path: (id: string) => `/api/portfolios/${id}/allocation` },
    {
      name: "GET /:id/positions/cfd-hints",
      path: (id: string) => `/api/portfolios/${id}/positions/cfd-hints`,
    },
  ] as const

  for (const read of READS) {
    it(`${read.name} writes nothing: snapshots, current_value and price_as_of unchanged`, async () => {
      process.env.INSTRUMENTS_URL = "http://instruments:3000"
      mockInstrumentsQuote()
      try {
        const h = await makeHarness()
        const a = app(h.db)
        const portfolioId = await seedStalePortfolio(a, h)

        const before = await captureState(h.db, portfolioId)

        const res = await a.request(read.path(portfolioId), { headers: h.headers })
        expect(res.status).toBe(200)

        const after = await captureState(h.db, portfolioId)
        expect(after).toEqual(before)
        // spelled out so a failure names the write, not just a blob diff
        expect(after.snapshotCount).toBe(before.snapshotCount)
        expect(after.currentValue).toBe(before.currentValue)
        expect(after.positions[0]?.priceAsOf).toBe(before.positions[0]?.priceAsOf)
        expect(after.positions[0]?.marketValue).toBe(before.positions[0]?.marketValue)
      } finally {
        vi.unstubAllGlobals()
        delete process.env.INSTRUMENTS_URL
      }
    })
  }

  it("GET /:id/positions still carries priceAsOf/priceSource per position (§61/§70)", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "Purity shape", currency: "USD" }),
    })
    const portfolio = await createRes.json()
    await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })
    // give it a real as-of so the field is non-null and actually travelling
    await h.db
      .update(positions)
      .set({ priceAsOf: new Date("2026-09-30T06:00:00Z"), priceSource: "quote" })
      .where(positionInPortfolio(portfolio.id))

    const body = await (
      await a.request(`/api/portfolios/${portfolio.id}/positions`, { headers: h.headers })
    ).json()

    expect(body).toHaveLength(1)
    const p = body[0]
    expect(p.symbol).toBe("AAPL")
    expect(Number(p.quantity)).toBe(10)
    expect(p.priceSource).toBe("quote")
    expect(p.priceAsOf).toBe("2026-09-30T06:00:00.000Z")
    // the wire fields §61/§70 depend on must still be present, not undefined
    expect(p).toHaveProperty("marketValue")
    expect(p).toHaveProperty("currentPrice")
  })
})

/**
 * §83.5 — `GET /api/portfolios/positions`: every open position across every
 * portfolio, labelled with the portfolio it came from.
 *
 * The scoping assertion is the load-bearing one. This route takes NO id, so
 * "another user's positions never appear" is the only thing standing between it
 * and a cross-tenant read.
 */
describe("GET /api/portfolios/positions (§83.5)", () => {
  async function makePf(h: Awaited<ReturnType<typeof makeHarness>>, name: string) {
    const res = await app(h.db).request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name, currency: "USD" }),
    })
    expect(res.status).toBe(201)
    return res.json()
  }

  async function buy(
    h: Awaited<ReturnType<typeof makeHarness>>,
    pfId: string,
    symbol: string,
    qty: number,
    price: number,
  ) {
    const res = await app(h.db).request(`/api/portfolios/${pfId}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ ...BUY_BODY, symbol, instrumentName: symbol, quantity: qty, price }),
    })
    expect(res.status).toBe(201)
  }

  it("spans portfolios, labels each row, and orders by P/L desc", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    const broker = await makePf(h, "Broker")
    const pension = await makePf(h, "Pension")
    await buy(h, broker.id, "AAPL", 10, 100)
    await buy(h, pension.id, "MSFT", 10, 300)
    await buy(h, pension.id, "KO", 1, 50)
    // Price them, and write the P/L column the pricing pass owns. The ORDER BY is
    // on `unrealized_gain_loss`, and a BUY never writes it — with every row NULL
    // the ordering assertion below would pass or fail by accident.
    const pnlBySymbol: Record<string, number> = { AAPL: 1000, MSFT: 1500, KO: 0 }
    for (const [symbol, pnl] of Object.entries(pnlBySymbol)) {
      await h.db
        .update(positions)
        .set({ unrealizedGainLoss: String(pnl) })
        .where(eq(positions.symbol, symbol))
    }

    const res = await a.request("/api/portfolios/positions", { headers: h.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.positions.length).toBe(3)
    // The per-portfolio label is the whole point: the same ticker can be held in
    // two portfolios with very different results.
    expect(body.positions.map((p: { portfolioName: string }) => p.portfolioName).sort()).toEqual([
      "Broker",
      "Pension",
      "Pension",
    ])
    // …and the money fields the performer cards render are present, so this is
    // the `Position` shape and not a summary of it.
    for (const p of body.positions) {
      expect(typeof p.symbol).toBe("string")
      expect(p.unrealizedGainLoss == null || typeof p.unrealizedGainLoss === "number").toBe(true)
      expect(typeof p.percentageChange === "number" || p.percentageChange === null).toBe(true)
      expect(typeof p.instrumentCurrency).toBe("string")
      expect(typeof p.isOpen).toBe("boolean")
      expect(p.portfolioId).toBeTruthy()
    }
    // Highest P/L first: the ordering the performer cards already rely on.
    const pnl = body.positions.map((p: { unrealizedGainLoss: number }) => p.unrealizedGainLoss)
    expect(pnl).toEqual([1500, 1000, 0])
    expect(body.positions[0].symbol).toBe("MSFT")
  })

  it("never returns another identity's positions", async () => {
    const mine = await makeHarness("user-mine")
    const minePf = await makePf(mine, "Mine")
    await buy(mine, minePf.id, "AAPL", 1, 100)

    const other = await makeHarness("user-other")
    const otherPf = await makePf(other, "Theirs")
    await buy(other, otherPf.id, "TSLA", 1, 900)

    const res = await app(mine.db).request("/api/portfolios/positions", { headers: mine.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.positions.map((p: { portfolioName: string }) => p.portfolioName)).toEqual(["Mine"])
  })

  it("is not captured by GET /:id", async () => {
    // "positions" must not be parsed as a portfolio id — the same reason /merged
    // is registered above /:id.
    const h = await makeHarness()
    const a = app(h.db)
    const res = await a.request("/api/portfolios/positions", { headers: h.headers })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ positions: [] })
  })
})

/**
 * §87.2 — a trade and the cash leg that funds it are created together and must
 * die together.
 *
 * Nothing linked them before: `linked_tx_id` is the cash↔cash transfer pair and
 * carries no FK, and the two delete paths were independent — deleting a trade left
 * its deposit behind, silently orphaning a money row. The fix is a real FK on the
 * CASH row pointing at the TRADE, so both directions need no application code:
 * `ON DELETE CASCADE` covers the direction that matters most, and deleting the
 * cash row takes the link with it (the link WAS the row).
 *
 * The whole section asserts the CASCADE, not application behaviour: if someone
 * later "helpfully" adds hand-written cleanup to the delete handler, these tests
 * still pass, which is the intent — the invariant is the database's job now.
 */
describe("§87.2: the trade ↔ cash-leg link", () => {
  async function pfWithBuy() {
    const h = await makeHarness()
    // the cash routes are a separate factory (src/index.ts mounts both under
    // /api/portfolios), so §87.2 needs its own app to exercise both deletes.
    const a = new Hono()
    a.route("/api/portfolios", createPortfolioCashRoutes(h.db))
    a.route("/api/portfolios", createPortfolioRoutes(h.db))
    const { id } = await (
      await a.request("/api/portfolios", {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify({ name: "XTB", currency: "PLN", baseCurrency: "PLN" }),
      })
    ).json()
    const { id: txId } = await (
      await a.request(`/api/portfolios/${id}/transactions`, {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify({ ...BUY_BODY, currency: "PLN" }),
      })
    ).json()
    return { h, a, pfId: id, txId }
  }

  async function leg(h: Awaited<ReturnType<typeof makeHarness>>, pfId: string, over: Record<string, unknown> = {}) {
    const [row] = await h.db
      .insert(portfolioCashTransactions)
      .values({
        userId: h.user.id,
        portfolioId: pfId,
        type: "DEPOSIT",
        amount: "1500",
        currency: "PLN",
        ...over,
      })
      .returning()
    return row
  }

  const cashBalance = async (h: Awaited<ReturnType<typeof makeHarness>>, pfId: string) => {
    const rows = await h.db
      .select({ amount: portfolioCashTransactions.amount })
      .from(portfolioCashTransactions)
      .where(eq(portfolioCashTransactions.portfolioId, pfId))
    return rows.reduce((s, r) => s + Number(r.amount), 0)
  }

  it("DELETING the trade takes its linked cash leg with it (cascade, no app code)", async () => {
    const { h, a, pfId, txId } = await pfWithBuy()
    await leg(h, pfId, { linkedTradeId: txId })
    expect(await cashBalance(h, pfId)).toBe(1500)

    const res = await a.request(`/api/portfolios/${pfId}/transactions/${txId}`, {
      method: "DELETE",
      headers: h.headers,
    })
    expect(res.status).toBe(204)

    // the money row is GONE — not merely unreferenced
    const left = await h.db
      .select({ id: portfolioCashTransactions.id })
      .from(portfolioCashTransactions)
      .where(eq(portfolioCashTransactions.portfolioId, pfId))
    expect(left).toHaveLength(0)
    // and the balance moved exactly once (the derived BUY is gone with it)
    expect(await cashBalance(h, pfId)).toBe(0)
  })

  it("DELETING the cash leg leaves the trade and its position alone", async () => {
    const { h, a, pfId, txId } = await pfWithBuy()
    const cash = await leg(h, pfId, { linkedTradeId: txId })

    const res = await a.request(`/api/portfolios/cash/transactions/${cash.id}`, {
      method: "DELETE",
      headers: h.headers,
    })
    expect(res.status).toBe(204)

    const [trade] = await h.db
      .select({ id: portfolioTransactions.id })
      .from(portfolioTransactions)
      .where(eq(portfolioTransactions.id, txId))
    expect(trade).toBeDefined()
    // the link died WITH the cash row, so nothing is left pointing anywhere
    expect(await cashBalance(h, pfId)).toBe(0)
    const detail = await (await a.request(`/api/portfolios/${pfId}`, { headers: h.headers })).json()
    const pos = detail.positions.find((p: { symbol: string }) => p.symbol === "AAPL")
    expect(Number(pos.quantity)).toBe(10)
  })

  it("deleting an UNLINKED cash row (a hand-written Wpłata) leaves everything else alone", async () => {
    const { h, a, pfId, txId } = await pfWithBuy()
    const deposit = await leg(h, pfId, { linkedTradeId: txId })
    const handWritten = await leg(h, pfId, {
      type: "DEPOSIT",
      amount: "250",
      description: "Wpłata: Gotówka XTB",
    })
    expect(handWritten.linkedTradeId).toBeNull()

    await a.request(`/api/portfolios/cash/transactions/${handWritten.id}`, {
      method: "DELETE",
      headers: h.headers,
    })

    const left = await h.db
      .select({ id: portfolioCashTransactions.id })
      .from(portfolioCashTransactions)
      .where(eq(portfolioCashTransactions.portfolioId, pfId))
    expect(left.map((r) => r.id)).toEqual([deposit.id])
    // the trade and its leg are untouched
    expect(await cashBalance(h, pfId)).toBe(1500)
    expect(
      await h.db
        .select({ id: portfolioTransactions.id })
        .from(portfolioTransactions)
        .where(eq(portfolioTransactions.id, txId)),
    ).toHaveLength(1)
  })

  it("an AU=0 trade has no cash row and nothing to point at (the column stays NULL)", async () => {
    // The link is nullable on purpose: it exists only when a related cash
    // transaction exists. No row, no key, no sentinel.
    const { h, pfId } = await pfWithBuy()
    const rows = await h.db
      .select({ id: portfolioCashTransactions.id })
      .from(portfolioCashTransactions)
      .where(eq(portfolioCashTransactions.portfolioId, pfId))
    expect(rows).toHaveLength(0)
  })

  it("the FK is real: a linked_trade_id pointing at no trade is rejected", async () => {
    const { h, pfId } = await pfWithBuy()
    await expect(leg(h, pfId, { linkedTradeId: "00000000-0000-0000-0000-000000000000" })).rejects.toThrow()
  })

  it("the migration's backfill derivation links a suffixed row to its trade", async () => {
    // Asserted on the rule the 0014 migration uses, on a hand-built pair, because
    // PGlite applies migrations before any test data exists and can therefore
    // never exercise a backfill on PROD's shape.
    const { h, pfId, txId } = await pfWithBuy()
    const cash = await leg(h, pfId, { externalSource: "google-sheets", externalId: "r120#d" })
    await h.db
      .update(portfolioTransactions)
      .set({ externalSource: "google-sheets", externalId: "r120" })
      .where(eq(portfolioTransactions.id, txId))

    // exactly the 0014 UPDATE … FROM (IS NOT DISTINCT FROM only so the assertion
    // can read the row back on a NULL-safe match; the migration's plain `=`
    // requires both to be set, which they are for every imported row)
    const before = await h.db
      .select({ linkedTradeId: portfolioCashTransactions.linkedTradeId })
      .from(portfolioCashTransactions)
      .where(eq(portfolioCashTransactions.id, cash.id))
    expect(before[0].linkedTradeId).toBeNull()

    await h.db.execute(sql`
      UPDATE portfolios.portfolio_cash_transactions c
         SET linked_trade_id = t.id
        FROM portfolios.transactions t
       WHERE c.linked_trade_id IS NULL
         AND (c.external_id LIKE '%#d' OR c.external_id LIKE '%#w' OR c.external_id LIKE '%#t')
         AND left(c.external_id, length(c.external_id) - 2) = t.external_id
         AND c.external_source IS NOT DISTINCT FROM t.external_source
    `)
    const [after] = await h.db
      .select({ linkedTradeId: portfolioCashTransactions.linkedTradeId })
      .from(portfolioCashTransactions)
      .where(eq(portfolioCashTransactions.id, cash.id))
    expect(after.linkedTradeId).toBe(txId)
  })
})

/**
 * §87.5 — the UI-only "also create a cash transaction" switch.
 *
 * Two independent mechanisms share a name and nothing else: the IMPORT path uses
 * the importer's own hardcoded kontо list (portfoliost-sheets-sync
 * `ALWAYS_CASH_LEG`), and this flag only decides what the form does by default.
 * The test that matters most is the last one — the import must not read this
 * column — because a UI toggle that leaked into the import path would silently
 * change what a spreadsheet produces.
 */
describe("§87.5: a UI-created cash leg", () => {
  async function pf(name: string, cashLegOnTrade?: boolean) {
    const h = await makeHarness()
    const a = app(h.db)
    const { id } = await (
      await a.request("/api/portfolios", {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify({ name, currency: "PLN", baseCurrency: "PLN", ...(cashLegOnTrade === undefined ? {} : { cashLegOnTrade }) }),
      })
    ).json()
    return { h, a, pfId: id }
  }

  const buy = (over: Record<string, unknown> = {}) => ({
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...BUY_BODY, currency: "PLN", ...over }),
  })

  async function legs(h: Awaited<ReturnType<typeof makeHarness>>, pfId: string) {
    return h.db.select().from(portfolioCashTransactions).where(eq(portfolioCashTransactions.portfolioId, pfId))
  }

  it("the portfolio flag defaults ON for the kontо the importer always funds, OFF otherwise", async () => {
    // Without this the UI would say "no cash transaction" for XTB while the
    // importer creates one on every one of its trades — the exact disagreement
    // the switch exists to prevent.
    const xtb = await pf("XTB")
    const ibkr = await pf("IBKR")
    const xtbRow = await (await xtb.a.request(`/api/portfolios/${xtb.pfId}`, { headers: xtb.h.headers })).json()
    const ibkrRow = await (await ibkr.a.request(`/api/portfolios/${ibkr.pfId}`, { headers: ibkr.h.headers })).json()
    expect(xtbRow.cashLegOnTrade).toBe(true)
    expect(ibkrRow.cashLegOnTrade).toBe(false)
  })

  it("an explicit value at creation wins over the kontо default", async () => {
    const h = await pf("XTB", false)
    const row = await (await h.a.request(`/api/portfolios/${h.pfId}`, { headers: h.h.headers })).json()
    expect(row.cashLegOnTrade).toBe(false)
  })

  it("PATCH toggles it and it round-trips", async () => {
    const h = await pf("IBKR")
    const res = await h.a.request(`/api/portfolios/${h.pfId}`, {
      method: "PATCH",
      headers: { ...h.h.headers, "content-type": "application/json" },
      body: JSON.stringify({ cashLegOnTrade: true }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).cashLegOnTrade).toBe(true)
    const row = await (await h.a.request(`/api/portfolios/${h.pfId}`, { headers: h.h.headers })).json()
    expect(row.cashLegOnTrade).toBe(true)
  })

  it("cashLeg:true on a BUY creates a DEPOSIT linked to the trade, and deleting the buy removes it", async () => {
    const { h, a, pfId } = await pf("XTB")
    const res = await a.request(`/api/portfolios/${pfId}/transactions`, {
      ...buy({ cashLeg: true }),
      headers: { ...h.headers, "content-type": "application/json" },
    })
    expect(res.status).toBe(201)
    const tx = await res.json()

    const [leg] = await legs(h, pfId)
    expect(leg.type).toBe("DEPOSIT")
    // 10 × 150 + 4.99 fees, in the row currency, positive
    expect(Number(leg.amount)).toBeCloseTo(1504.99, 2)
    expect(leg.currency).toBe("PLN")
    expect(leg.linkedTradeId).toBe(tx.id)
    // the round trip: the deposit offsets the derived BUY draw
    expect(Number(leg.amount)).toBeCloseTo(Number(tx.totalAmount) + 4.99, 2)

    await a.request(`/api/portfolios/${pfId}/transactions/${tx.id}`, { method: "DELETE", headers: h.headers })
    expect(await legs(h, pfId)).toHaveLength(0) // cascade, not application code
  })

  it("cashLeg:true on a SELL creates a WITHDRAWAL (the §87.1 direction, from the UI)", async () => {
    const { h, a, pfId } = await pf("XTB")
    await a.request(`/api/portfolios/${pfId}/transactions`, {
      ...buy({ cashLeg: true }),
      headers: { ...h.headers, "content-type": "application/json" },
    })
    const sellRes = await a.request(`/api/portfolios/${pfId}/transactions`, {
      method: "POST",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({ type: "SELL", symbol: "AAPL", quantity: 10, price: 170, currency: "PLN", fees: 2.5, cashLeg: true }),
    })
    expect(sellRes.status).toBe(201)
    const sell = await sellRes.json()
    const all = await legs(h, pfId)
    expect(all).toHaveLength(2)
    const withdrawal = all.find((l) => l.type === "WITHDRAWAL")!
    // 10 × 170 + 2.50, stored negative (the sign is the type's, not the caller's)
    expect(Number(withdrawal.amount)).toBeCloseTo(-1702.5, 2)
    expect(withdrawal.linkedTradeId).toBe(sell.id)
    // mirrors the importer's "Withdrawal: <aktywo>", falling back to the symbol
    expect(withdrawal.description).toBe("Withdrawal: AAPL")
  })

  it("no cashLeg field (an existing caller) creates NO cash row — the field is opt-in", async () => {
    const { h, a, pfId } = await pf("XTB")
    await a.request(`/api/portfolios/${pfId}/transactions`, {
      ...buy(),
      headers: { ...h.headers, "content-type": "application/json" },
    })
    expect(await legs(h, pfId)).toHaveLength(0)
  })

  it("cashLeg:false is honoured even when the portfolio's flag is ON (per-transaction untick)", async () => {
    const { h, a, pfId } = await pf("XTB") // flag defaults ON for XTB
    await a.request(`/api/portfolios/${pfId}/transactions`, {
      ...buy({ cashLeg: false }),
      headers: { ...h.headers, "content-type": "application/json" },
    })
    expect(await legs(h, pfId)).toHaveLength(0)
  })

  it("a DIVIDEND gets no cash leg (its credit is derived by replay)", async () => {
    const { h, a, pfId } = await pf("XTB")
    const res = await a.request(`/api/portfolios/${pfId}/transactions`, {
      method: "POST",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({ type: "DIVIDEND", symbol: "AAPL", quantity: 10, price: 1, currency: "PLN", cashLeg: true }),
    })
    expect(res.status).toBe(201)
    expect(await legs(h, pfId)).toHaveLength(0)
  })

  it("deleting the CASH leg leaves the UI-created trade alone", async () => {
    const { h, a, pfId } = await pf("XTB")
    const tx = await (
      await a.request(`/api/portfolios/${pfId}/transactions`, {
        ...buy({ cashLeg: true }),
        headers: { ...h.headers, "content-type": "application/json" },
      })
    ).json()
    const [leg] = await legs(h, pfId)
    await a.request(`/api/portfolios/cash/transactions/${leg.id}`, { method: "DELETE", headers: h.headers })
    expect(
      await h.db.select().from(portfolioTransactions).where(eq(portfolioTransactions.id, tx.id)),
    ).toHaveLength(1)
  })
})
