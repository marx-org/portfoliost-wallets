import { describe, expect, it } from "vitest"
import { Hono } from "hono"
import { eq } from "drizzle-orm"
import { createInternalRoutes } from "./internal.js"
import { createImportRoutes } from "./import.js"
import { makeHarness, type Harness } from "./test-utils.js"
import { wallets, portfolios, positions, portfolioTransactions } from "../db/schema.js"

async function boot() {
  const h = await makeHarness()
  const app = new Hono()
  app.route("/api/import", createImportRoutes(h.db))
  app.route("/internal", createInternalRoutes(h.db))
  return { ...h, app }
}

async function seedWalletAndPortfolio(h: Harness) {
  const userId = "user-1"
  const walletId = crypto.randomUUID()
  const portfolioId = crypto.randomUUID()
  await h.db.insert(wallets).values({
    userId,
    id: walletId,
    name: "IBKR",
    currency: "USD",
    baseCurrency: "USD",
    balance: "0",
    availableBalance: "0",
  })
  await h.db.insert(portfolios).values({
    userId,
    id: portfolioId,
    name: "Transakcje",
    currency: "PLN",
    baseCurrency: "PLN",
  })
  return { userId, walletId, portfolioId }
}

async function importBuy(
  h: Harness,
  portfolioId: string,
  over: { rowExecutedAt?: string; ptx?: Record<string, unknown> } = {},
) {
  const res = await h.app.request("/api/import/transactions", {
    method: "POST",
    headers: { ...h.headers, "content-type": "application/json" },
    body: JSON.stringify({
      source: { externalSource: "google-sheets:transakcje", spreadsheetId: "spr-1", sheet: "tx" },
      transactions: [
        {
          externalId: `buy-${Math.random().toString(36).slice(2, 8)}`,
          walletName: "IBKR",
          executedAt: over.rowExecutedAt ?? "2024-01-15T10:00:00.000Z",
          walletTx: { type: "INVEST", amount: -1000, currency: "USD" },
          portfolioTx: {
            portfolioId,
            type: "BUY",
            instrumentSymbol: "AAPL",
            assetType: "STOCK",
            quantity: 10,
            price: 100,
            currency: "USD",
            ...over.ptx,
          },
        },
      ],
    }),
  })
  expect(res.status).toBe(200)
}

function applySplit(h: Harness, body: Record<string, unknown>) {
  return h.app.request("/internal/apply-split", {
    method: "POST",
    headers: { ...h.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

async function ptxOf(h: Harness, portfolioId: string) {
  const rows = await h.db.select().from(portfolioTransactions).where(eq(portfolioTransactions.portfolioId, portfolioId))
  return rows
}

async function posOf(h: Harness, portfolioId: string) {
  const rows = await h.db.select().from(positions).where(eq(positions.portfolioId, portfolioId))
  return rows
}

describe("POST /internal/apply-split (§23.6)", () => {
  it("restates pre-split rows from frozen originals: 2x then 3x => 6x (Amazon-style cumulative)", async () => {
    const h = await boot()
    const { portfolioId } = await seedWalletAndPortfolio(h)
    await importBuy(h, portfolioId)

    const first = await (await applySplit(h, { symbol: "AAPL", factor: 2, effectiveDate: "2024-02-01" })).json()
    expect(first).toEqual({ updatedTransactions: 1, affectedPortfolios: 1 })

    const rows1 = await ptxOf(h, portfolioId)
    expect(Number(rows1[0].quantity)).toBe(20)
    expect(Number(rows1[0].price)).toBe(50)
    expect(Number(rows1[0].originalQuantity)).toBe(10)
    expect(Number(rows1[0].originalPrice)).toBe(100)

    const pos1 = await posOf(h, portfolioId)
    expect(Number(pos1[0].quantity)).toBe(20)
    expect(Number(pos1[0].averageCostBasis)).toBe(50)

    const second = await (await applySplit(h, { symbol: "AAPL", factor: 3, effectiveDate: "2024-03-01" })).json()
    expect(second).toEqual({ updatedTransactions: 1, affectedPortfolios: 1 })

    const rows2 = await ptxOf(h, portfolioId)
    expect(Number(rows2[0].quantity)).toBe(60)
    expect(Number(rows2[0].price)).toBeCloseTo(16.66666667, 8)
    expect(Number(rows2[0].originalQuantity)).toBe(10)
    expect(Number(rows2[0].originalPrice)).toBe(100)

    const pos2 = await posOf(h, portfolioId)
    expect(Number(pos2[0].quantity)).toBe(60)
    expect(Number(pos2[0].averageCostBasis)).toBeCloseTo(16.66666667, 8)
  })

  it("re-applying the same (symbol, effectiveDate) is a no-op (idempotent from frozen originals)", async () => {
    const h = await boot()
    const { portfolioId } = await seedWalletAndPortfolio(h)
    await importBuy(h, portfolioId)

    await applySplit(h, { symbol: "AAPL", factor: 2, effectiveDate: "2024-02-01" })
    const afterFirst = await ptxOf(h, portfolioId)
    expect(Number(afterFirst[0].quantity)).toBe(20)

    const retry = await (await applySplit(h, { symbol: "AAPL", factor: 2, effectiveDate: "2024-02-01" })).json()
    expect(retry).toEqual({ updatedTransactions: 0, affectedPortfolios: 0 })

    const afterRetry = await ptxOf(h, portfolioId)
    expect(Number(afterRetry[0].quantity)).toBe(20)
    expect(Number(afterRetry[0].price)).toBe(50)

    await applySplit(h, { symbol: "AAPL", factor: 3, effectiveDate: "2024-03-01" })
    const olderRetry = await (await applySplit(h, { symbol: "AAPL", factor: 2, effectiveDate: "2024-02-01" })).json()
    expect(olderRetry).toEqual({ updatedTransactions: 0, affectedPortfolios: 0 })
    const rows = await ptxOf(h, portfolioId)
    expect(Number(rows[0].quantity)).toBe(60)
  })

  it("a conflicting factor for the same (symbol, effectiveDate) does not overwrite the first write", async () => {
    const h = await boot()
    const { portfolioId } = await seedWalletAndPortfolio(h)
    await importBuy(h, portfolioId)

    await applySplit(h, { symbol: "AAPL", factor: 2, effectiveDate: "2024-02-01" })
    await applySplit(h, { symbol: "AAPL", factor: 5, effectiveDate: "2024-02-01" })

    const rows = await ptxOf(h, portfolioId)
    expect(Number(rows[0].quantity)).toBe(20)
  })

  it("rows executed between splits are restated only by later splits", async () => {
    const h = await boot()
    const { portfolioId } = await seedWalletAndPortfolio(h)
    await importBuy(h, portfolioId)
    await applySplit(h, { symbol: "AAPL", factor: 2, effectiveDate: "2024-02-01" })

    const sellRes = await h.app.request("/api/import/transactions", {
      method: "POST",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({
        source: { externalSource: "google-sheets:transakcje", spreadsheetId: "spr-1", sheet: "tx" },
        transactions: [
          {
            externalId: "sell-1",
            walletName: "IBKR",
            executedAt: "2024-02-15T10:00:00.000Z",
            walletTx: { type: "SELL", amount: 275, currency: "USD" },
            portfolioTx: {
              portfolioId,
              type: "SELL",
              instrumentSymbol: "AAPL",
              assetType: "STOCK",
              quantity: 5,
              price: 55,
              currency: "USD",
            },
          },
        ],
      }),
    })
    expect(sellRes.status).toBe(200)

    await applySplit(h, { symbol: "AAPL", factor: 3, effectiveDate: "2024-03-01" })

    const rows = (await ptxOf(h, portfolioId)).sort((a, b) => (a.executedAt < b.executedAt ? -1 : 1))
    expect(Number(rows[0].quantity)).toBe(60)
    expect(Number(rows[0].price)).toBeCloseTo(16.66666667, 8)
    expect(Number(rows[1].quantity)).toBe(15)
    expect(Number(rows[1].price)).toBeCloseTo(18.33333333, 8)
    expect(Number(rows[1].originalQuantity)).toBe(5)

    const pos = await posOf(h, portfolioId)
    expect(Number(pos[0].quantity)).toBe(45)
    expect(Number(pos[0].averageCostBasis)).toBeCloseTo(16.66666667, 8)
  })

  it("rows executed on or after the effective date are untouched", async () => {
    const h = await boot()
    const { portfolioId } = await seedWalletAndPortfolio(h)
    await importBuy(h, portfolioId, { rowExecutedAt: "2024-02-01T10:00:00.000Z" })

    const res = await (await applySplit(h, { symbol: "AAPL", factor: 2, effectiveDate: "2024-02-01" })).json()
    expect(res).toEqual({ updatedTransactions: 0, affectedPortfolios: 0 })

    const rows = await ptxOf(h, portfolioId)
    expect(Number(rows[0].quantity)).toBe(10)
  })

  it("restates every user's rows for the symbol; other symbols and users' other positions survive", async () => {
    const h = await boot()
    const { portfolioId } = await seedWalletAndPortfolio(h)
    await importBuy(h, portfolioId)

    const user2Wallet = crypto.randomUUID()
    const user2Portfolio = crypto.randomUUID()
    const user2Pos = crypto.randomUUID()
    const user2MsftPos = crypto.randomUUID()
    await h.db.insert(wallets).values({
      userId: "user-2",
      id: user2Wallet,
      name: "IBKR",
      currency: "USD",
      baseCurrency: "USD",
      balance: "0",
      availableBalance: "0",
    })
    await h.db.insert(portfolios).values({
      userId: "user-2",
      id: user2Portfolio,
      name: "P2",
      currency: "USD",
      baseCurrency: "USD",
    })
    for (const posId of [user2Pos, user2MsftPos]) {
      await h.db.insert(positions).values({
        userId: "user-2",
        portfolioId: user2Portfolio,
        id: posId,
        symbol: posId === user2Pos ? "AAPL" : "MSFT",
        quantity: "1",
        averageCostBasis: "1",
        instrumentCurrency: "USD",
        assetType: "STOCK",
      })
    }
    const ptxValues = [
      {
        userId: "user-2",
        portfolioId: user2Portfolio,
        positionId: user2Pos,
        type: "BUY",
        instrumentSymbol: "AAPL",
        quantity: "5",
        price: "100",
        originalQuantity: "5",
        originalPrice: "100",
        currency: "USD",
        totalAmount: "500",
        executedAt: new Date("2024-01-01T00:00:00.000Z"),
      },
      {
        userId: "user-2",
        portfolioId: user2Portfolio,
        positionId: user2MsftPos,
        type: "BUY",
        instrumentSymbol: "MSFT",
        quantity: "3",
        price: "30",
        originalQuantity: "3",
        originalPrice: "30",
        currency: "USD",
        totalAmount: "90",
        executedAt: new Date("2024-01-01T00:00:00.000Z"),
      },
    ]
    await h.db.insert(portfolioTransactions).values(ptxValues)
    await h.db
      .update(positions)
      .set({ quantity: "5", averageCostBasis: "100" })
      .where(eq(positions.id, user2Pos))

    const res = await (await applySplit(h, { symbol: "AAPL", factor: 2, effectiveDate: "2024-02-01" })).json()
    expect(res).toEqual({ updatedTransactions: 2, affectedPortfolios: 2 })

    const all = await h.db.select().from(portfolioTransactions)
    for (const r of all) {
      if (r.instrumentSymbol === "AAPL") {
        expect(Number(r.quantity)).toBe(Number(r.originalQuantity) * 2)
        expect(Number(r.price)).toBe(Number(r.originalPrice) / 2)
      } else {
        expect(Number(r.quantity)).toBe(3)
        expect(Number(r.price)).toBe(30)
      }
    }
  })

  it("restates position current price and market value with the cumulative factor", async () => {
    const h = await boot()
    const { portfolioId } = await seedWalletAndPortfolio(h)
    await importBuy(h, portfolioId)
    const [pos] = await h.db
      .update(positions)
      .set({ currentPrice: "150", marketValue: "1500", unrealizedGainLoss: "500", dayChange: "1", dayChangePercent: "2" })
      .where(eq(positions.portfolioId, portfolioId))
      .returning()
    expect(Number(pos.currentPrice)).toBe(150)

    await applySplit(h, { symbol: "AAPL", factor: 2, effectiveDate: "2024-02-01" })

    const [after] = await h.db.select().from(positions).where(eq(positions.portfolioId, portfolioId))
    expect(Number(after.quantity)).toBe(20)
    expect(Number(after.averageCostBasis)).toBe(50)
    expect(Number(after.currentPrice)).toBe(75)
    expect(Number(after.marketValue)).toBe(1500)
    expect(Number(after.unrealizedGainLoss)).toBe(500)
    expect(Number(after.dayChange)).toBe(0.5)
    expect(Number(after.dayChangePercent)).toBe(2)
  })

  it("rejects invalid payloads with 422", async () => {
    const h = await boot()
    for (const body of [
      { symbol: "AAPL", factor: 0, effectiveDate: "2024-02-01" },
      { symbol: "AAPL", factor: -2, effectiveDate: "2024-02-01" },
      { symbol: "AAPL", factor: "abc", effectiveDate: "2024-02-01" },
      { symbol: "", factor: 2, effectiveDate: "2024-02-01" },
      { symbol: "AAPL", factor: 2, effectiveDate: "2024-02-30" },
      { factor: 2, effectiveDate: "2024-02-01" },
      { symbol: "AAPL", factor: 2 },
    ]) {
      const res = await applySplit(h, body)
      expect(res.status).toBe(422)
    }
  })

  it("requires no JWT (internal network only)", async () => {
    const h = await boot()
    const { portfolioId } = await seedWalletAndPortfolio(h)
    await importBuy(h, portfolioId)

    const res = await h.app.request("/internal/apply-split", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ symbol: "AAPL", factor: 2, effectiveDate: "2024-02-01" }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).updatedTransactions).toBe(1)
  })
})
