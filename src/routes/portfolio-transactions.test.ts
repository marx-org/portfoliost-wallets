import { describe, expect, it } from "vitest"
import { Hono } from "hono"
import { createPortfolioRoutes } from "./portfolios.js"
import { createCrossPortfolioTransactionsRoute } from "./portfolio-transactions.js"
import { makeHarness } from "./test-utils.js"
import {
  portfolios,
  positions,
  portfolioTransactions,
  walletTransactions,
  wallets,
} from "../db/schema.js"
import { sql } from "drizzle-orm"

function app(db: Parameters<typeof makeHarness>[0] extends string ? never : Parameters<typeof createPortfolioRoutes>[0]) {
  const a = new Hono()
  // Cross-portfolio feed must be mounted BEFORE portfolio routes to avoid /:id collision
  a.route("/api/portfolios/transactions", createCrossPortfolioTransactionsRoute(db))
  a.route("/api/portfolios", createPortfolioRoutes(db))
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
    expect(body.positions[0].avgCostBasis).toBeCloseTo(153.33, 1)
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

  it("DELETE /:id/positions/:positionId — soft-close empty position", async () => {
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

    // Position has transactions → 409
    const delRes = await a.request(`/api/portfolios/${portfolio.id}/positions/${posId}`, {
      method: "DELETE",
      headers: h.headers,
    })
    expect(delRes.status).toBe(409)
  })

  it("POST /:id/transactions — wallet linked BUY debits wallet", async () => {
    const h = await makeHarness()
    const a = app(h.db)

    // Create wallet directly in DB
    const [wallet] = await h.db.insert(wallets).values({
      userId: h.user.id,
      name: "Cash",
      currency: "USD",
      balance: "5000.00000000",
      availableBalance: "5000.00000000",
    }).returning()

    // Create portfolio
    const portfolioRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "P", currency: "USD" }),
    })
    const portfolio = await portfolioRes.json()

    // Buy with wallet link
    const buyRes = await a.request(`/api/portfolios/${portfolio.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ ...BUY_BODY, walletId: wallet.id }),
    })
    expect(buyRes.status).toBe(201)

    // Wallet should be debited
    const [updatedWallet] = await h.db
      .select()
      .from(wallets)
      .where(sql`${wallets.id} = ${wallet.id}`)
    // 5000 - (10*150 + 4.99) = 5000 - 1504.99 = 3495.01
    expect(Number(updatedWallet.balance)).toBeCloseTo(3495.01, 1)
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

    // BUY
    await a.request(`/api/portfolios/${pid}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })

    const res = await a.request("/api/portfolios/total-metrics", { headers: h.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalValue).toBeGreaterThan(0)
    expect(body.totalInvested).toBeGreaterThan(0)
    expect(body.portfolioBreakdown.length).toBe(1)
    expect(body.portfolioBreakdown[0].portfolioName).toBe("P1")
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

    const res = await a.request(`/api/portfolios/${portfolio.id}/summary-metrics`, { headers: h.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.totalValue).toBe(1500)
    expect(body.totalCostBasis).toBe(1500)
    expect(body.positionCount).toBe(1)
    expect(body.realizedPnl).toBe(0)
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
    // realizedPnl should be > 0 (sell proceeds minus cost basis minus fees)
    expect(body.realizedPnl).toBeGreaterThan(0)
  })
})
