import { describe, expect, it } from "vitest"
import { Hono } from "hono"
import { and, eq, sql } from "drizzle-orm"
import { createImportRoutes } from "./import.js"
import { createPortfolioRoutes } from "./portfolios.js"
import { makeHarness, type Harness } from "./test-utils.js"
import {
  wallets,
  portfolios,
  walletTransactions,
  portfolioTransactions,
  positions,
  syncRuns,
} from "../db/schema.js"

async function boot() {
  const h = await makeHarness()
  const app = new Hono().route("/api/import", createImportRoutes(h.db))
  return { ...h, app }
}

async function seedWalletAndPortfolio(
  h: Harness,
  opts: { walletName?: string; walletBalance?: number } = {},
) {
  const userId = "user-1"
  const walletId = crypto.randomUUID()
  const portfolioId = crypto.randomUUID()
  await h.db.insert(wallets).values({
    userId,
    id: walletId,
    name: opts.walletName ?? "IBKR",
    currency: "USD",
    baseCurrency: "USD",
    balance: String(opts.walletBalance ?? 0),
    availableBalance: String(opts.walletBalance ?? 0),
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

function postTransactions(h: Harness, transactions: Record<string, unknown>[]) {
  return h.app.request("/api/import/transactions", {
    method: "POST",
    headers: { ...h.headers, "content-type": "application/json" },
    body: JSON.stringify({
      source: { externalSource: "google-sheets:transakcje", spreadsheetId: "spr-1", sheet: "tx" },
      transactions,
    }),
  })
}

function buyRow(
  portfolioId: string,
  over: Record<string, unknown> = {},
  wtxOver: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    externalId: `buy-${Math.random().toString(36).slice(2, 8)}`,
    walletName: "IBKR",
    executedAt: "2024-01-15T10:00:00.000Z",
    walletTx: { type: "INVEST", amount: -1000, currency: "USD", ...wtxOver },
    portfolioTx: {
      portfolioId,
      type: "BUY",
      instrumentSymbol: "AAPL",
      assetType: "STOCK",
      quantity: 10,
      price: 100,
      currency: "USD",
      ...over,
    },
  }
}

describe("POST /api/import/wallets/bootstrap (§23.3)", () => {
  it("creates wallets tagged with externalSource on first call (created=true)", async () => {
    const h = await boot()
    const res = await h.app.request("/api/import/wallets/bootstrap", {
      method: "POST",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({
        externalSource: "google-sheets:transakcje",
        wallets: [
          { name: "IBKR", currency: "usd", baseCurrency: "pln" },
          { name: "IKE Marek", currency: "PLN" },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.wallets).toEqual([
      { id: expect.any(String), name: "IBKR", currency: "USD", baseCurrency: "PLN", created: true },
      { id: expect.any(String), name: "IKE Marek", currency: "PLN", baseCurrency: "USD", created: true },
    ])

    const rows = await h.db
      .select({ externalSource: wallets.externalSource, name: wallets.name })
      .from(wallets)
    expect(rows).toEqual([
      { externalSource: "google-sheets:transakcje", name: "IBKR" },
      { externalSource: "google-sheets:transakcje", name: "IKE Marek" },
    ])
  })

  it("second call returns same ids, created=false, and does not re-tag", async () => {
    const h = await boot()
    const call = () =>
      h.app.request("/api/import/wallets/bootstrap", {
        method: "POST",
        headers: { ...h.headers, "content-type": "application/json" },
        body: JSON.stringify({
          externalSource: "google-sheets:transakcje",
          wallets: [{ name: "IBKR", currency: "USD" }],
        }),
      })

    const first = await (await call()).json()
    expect(first.wallets[0].created).toBe(true)

    const second = await (await call()).json()
    expect(second.wallets[0]).toMatchObject({ id: first.wallets[0].id, created: false })
    expect(first.wallets[0].id).toBe(second.wallets[0].id)
  })

  it("never re-tags a pre-existing manual wallet with the same name", async () => {
    const h = await boot()
    await h.db.insert(wallets).values({ userId: "user-1", name: "IBKR", currency: "USD" })

    const res = await h.app.request("/api/import/wallets/bootstrap", {
      method: "POST",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({
        externalSource: "google-sheets:transakcje",
        wallets: [{ name: "IBKR", currency: "USD" }],
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.wallets[0].created).toBe(false)

    const [tagged] = await h.db
      .select({ externalSource: wallets.externalSource })
      .from(wallets)
      .where(eq(wallets.name, "IBKR"))
    expect(tagged.externalSource).toBeNull()
  })

  it("unknown fields → 422", async () => {
    const h = await boot()
    const res = await h.app.request("/api/import/wallets/bootstrap", {
      method: "POST",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({
        externalSource: "google-sheets:transakcje",
        wallets: [{ name: "IBKR", currency: "USD", surprise: true }],
      }),
    })
    expect(res.status).toBe(422)
    expect((await res.json()).error).toBe("ValidationError")
  })
})

describe("POST /api/import/portfolios/bootstrap (§23.3)", () => {
  it("creates a portfolio tagged with externalSource; second call is idempotent", async () => {
    const h = await boot()
    const call = () =>
      h.app.request("/api/import/portfolios/bootstrap", {
        method: "POST",
        headers: { ...h.headers, "content-type": "application/json" },
        body: JSON.stringify({
          externalSource: "google-sheets:transakcje",
          name: "Transakcje",
          currency: "PLN",
          baseCurrency: "PLN",
        }),
      })

    const first = await (await call()).json()
    expect(first).toMatchObject({ name: "Transakcje", currency: "PLN", baseCurrency: "PLN", created: true })

    const second = await (await call()).json()
    expect(second).toMatchObject({ id: first.id, name: "Transakcje", created: false })

    const [row] = await h.db
      .select({ externalSource: portfolios.externalSource })
      .from(portfolios)
      .where(eq(portfolios.id, first.id))
    expect(row.externalSource).toBe("google-sheets:transakcje")
  })

  it("unknown fields → 422", async () => {
    const h = await boot()
    const res = await h.app.request("/api/import/portfolios/bootstrap", {
      method: "POST",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({
        externalSource: "s",
        name: "P",
        currency: "PLN",
        bogus: 1,
      }),
    })
    expect(res.status).toBe(422)
  })
})

describe("POST /api/import/transactions (§23.4)", () => {
  it("BUY then SELL restates the position (avg cost, qty, realizedGainLoss)", async () => {
    const h = await boot()
    const { portfolioId } = await seedWalletAndPortfolio(h)

    const res = await postTransactions(h, [
      {
        externalId: "e-buy-1",
        walletName: "IBKR",
        executedAt: "2024-01-15T10:00:00.000Z",
        walletTx: { type: "INVEST", amount: -1000, currency: "USD" },
        portfolioTx: { portfolioId, type: "BUY", instrumentSymbol: "AAPL", quantity: 10, price: 100, currency: "USD" },
      },
      {
        externalId: "e-sell-1",
        walletName: "IBKR",
        executedAt: "2024-02-15T10:00:00.000Z",
        walletTx: { type: "SELL", amount: 480, currency: "USD" },
        portfolioTx: { portfolioId, type: "SELL", instrumentSymbol: "AAPL", quantity: 4, price: 120, currency: "USD" },
      },
    ])
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.inserted).toBe(2)
    expect(body.skipped).toBe(0)
    expect(body.errors).toEqual([])

    const [pos] = await h.db.select().from(positions).where(eq(positions.portfolioId, portfolioId))
    expect(pos.isOpen).toBe(true)
    expect(Number(pos.quantity)).toBe(6)
    expect(Number(pos.averageCostBasis)).toBe(100)

    const [sellTx] = await h.db
      .select()
      .from(portfolioTransactions)
      .where(and(eq(portfolioTransactions.type, "SELL"), eq(portfolioTransactions.portfolioId, portfolioId)))
    expect(Number(sellTx.realizedGainLoss)).toBe(80)

    const [portfolio] = await h.db.select().from(portfolios).where(eq(portfolios.id, portfolioId))
    expect(Number(portfolio.totalInvested)).toBe(1000)
  })

  it("stores pre-restatement originalQuantity/originalPrice independently from restated values", async () => {
    const h = await boot()
    const { portfolioId } = await seedWalletAndPortfolio(h)

    const res = await postTransactions(h, [
      buyRow(portfolioId, { quantity: 10, price: 100, originalQuantity: 20, originalPrice: 50 }),
    ])
    expect(res.status).toBe(200)
    expect((await res.json()).inserted).toBe(1)

    const [ptxRow] = await h.db
      .select()
      .from(portfolioTransactions)
      .where(eq(portfolioTransactions.portfolioId, portfolioId))
    expect(Number(ptxRow.quantity)).toBe(10)
    expect(Number(ptxRow.price)).toBe(100)
    expect(Number(ptxRow.originalQuantity)).toBe(20)
    expect(Number(ptxRow.originalPrice)).toBe(50)

    const [pos] = await h.db.select().from(positions).where(eq(positions.portfolioId, portfolioId))
    expect(Number(pos.quantity)).toBe(10)
    expect(Number(pos.averageCostBasis)).toBe(100)
  })

  it("manual BUY via the interactive route auto-sets original_quantity/original_price", async () => {
    const h = await boot()
    const { portfolioId } = await seedWalletAndPortfolio(h)
    const app = new Hono().route("/api/portfolios", createPortfolioRoutes(h.db))

    const res = await app.request(`/api/portfolios/${portfolioId}/transactions`, {
      method: "POST",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({ type: "BUY", symbol: "AAPL", quantity: 10, price: 100, currency: "USD" }),
    })
    expect(res.status).toBe(201)

    const [ptxRow] = await h.db
      .select()
      .from(portfolioTransactions)
      .where(eq(portfolioTransactions.portfolioId, portfolioId))
    expect(Number(ptxRow.originalQuantity)).toBe(10)
    expect(Number(ptxRow.originalPrice)).toBe(100)
  })

  it("re-submitting the same externalId array is a no-op (inserted=0, skipped=N)", async () => {
    const h = await boot()
    const { portfolioId } = await seedWalletAndPortfolio(h)
    const payload = [buyRow(portfolioId), { ...buyRow(portfolioId, { instrumentSymbol: "MSFT" }), externalId: "dup-2" }]

    const first = await (await postTransactions(h, payload)).json()
    expect(first.inserted).toBe(2)
    expect(first.skipped).toBe(0)

    const second = await (await postTransactions(h, payload)).json()
    expect(second.inserted).toBe(0)
    expect(second.skipped).toBe(2)
    expect(second.errors).toEqual([])
  })

  it("unknown walletName collects an error while the rest of the batch succeeds", async () => {
    const h = await boot()
    const { portfolioId } = await seedWalletAndPortfolio(h)

    const res = await postTransactions(h, [
      {
        externalId: "e-bad",
        walletName: "NOPE",
        executedAt: "2024-01-15T10:00:00.000Z",
        walletTx: { type: "DEPOSIT", amount: 100, currency: "USD" },
      },
      buyRow(portfolioId),
    ])
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.inserted).toBe(1)
    expect(body.errors).toEqual([
      { externalId: "e-bad", error: "wallet_not_found", message: expect.stringContaining("NOPE") },
    ])
    expect(body.syncRun.status).toBe("done")

    const wtxs = await h.db.select().from(walletTransactions)
    expect(wtxs).toHaveLength(1)
    expect(wtxs[0].externalId).not.toBe("e-bad")
  })

  it("all rows failing marks the sync_run as failed", async () => {
    const h = await boot()
    const res = await postTransactions(h, [
      {
        externalId: "e-fail",
        walletName: "NOPE",
        executedAt: "2024-01-15T10:00:00.000Z",
        walletTx: { type: "DEPOSIT", amount: 100, currency: "USD" },
      },
    ])
    const body = await res.json()
    expect(body.inserted).toBe(0)
    expect(body.errors[0].error).toBe("wallet_not_found")
    expect(body.syncRun.status).toBe("failed")
    expect(body.syncRun.error).toBeTruthy()
  })

  it("DEPOSIT without portfolioTx creates a wallet row only", async () => {
    const h = await boot()
    await seedWalletAndPortfolio(h)

    const res = await postTransactions(h, [
      {
        externalId: "e-dep",
        walletName: "IBKR",
        executedAt: "2024-01-15T10:00:00.000Z",
        walletTx: { type: "DEPOSIT", amount: 500, currency: "USD", description: "disbursement" },
      },
    ])
    expect(res.status).toBe(200)
    expect((await res.json()).inserted).toBe(1)

    const [wtx] = await h.db.select().from(walletTransactions)
    expect(wtx.type).toBe("DEPOSIT")
    expect(wtx.portfolioId).toBeNull()

    const ptxCount = await h.db.select().from(portfolioTransactions)
    const posCount = await h.db.select().from(positions)
    expect(ptxCount).toHaveLength(0)
    expect(posCount).toHaveLength(0)
  })

  it("recalculates wallet balance as SUM(amount) across the whole batch", async () => {
    const h = await boot()
    const { walletId } = await seedWalletAndPortfolio(h)

    const res = await postTransactions(h, [
      { externalId: "b1", walletName: "IBKR", executedAt: "2024-01-01T00:00:00.000Z", walletTx: { type: "DEPOSIT", amount: 500, currency: "USD" } },
      { externalId: "b2", walletName: "IBKR", executedAt: "2024-01-02T00:00:00.000Z", walletTx: { type: "DEPOSIT", amount: 300, currency: "USD" } },
      { externalId: "b3", walletName: "IBKR", executedAt: "2024-01-03T00:00:00.000Z", walletTx: { type: "WITHDRAWAL", amount: -100, currency: "USD" } },
    ])
    expect(res.status).toBe(200)
    expect((await res.json()).inserted).toBe(3)

    const [wallet] = await h.db.select().from(wallets).where(eq(wallets.id, walletId))
    expect(Number(wallet.balance)).toBe(700)
    expect(Number(wallet.availableBalance)).toBe(700)

    const [agg] = await h.db.select({ sum: sql<string>`coalesce(sum(${walletTransactions.amount}), 0)` })
      .from(walletTransactions)
      .where(eq(walletTransactions.walletId, walletId))
    expect(Number(agg.sum)).toBe(700)
  })

  it("upserts a sync_runs row with correct counters and reuses it across batches", async () => {
    const h = await boot()
    const { portfolioId } = await seedWalletAndPortfolio(h)
    const payload = [
      {
        externalId: "e-buy-1",
        walletName: "IBKR",
        executedAt: "2024-01-15T10:00:00.000Z",
        walletTx: { type: "INVEST", amount: -1000, currency: "USD" },
        portfolioTx: { portfolioId, type: "BUY", instrumentSymbol: "AAPL", quantity: 10, price: 100, currency: "USD" },
      },
      {
        externalId: "e-dep",
        walletName: "IBKR",
        executedAt: "2024-01-16T10:00:00.000Z",
        walletTx: { type: "DEPOSIT", amount: 500, currency: "USD" },
      },
    ]

    const first = await (await postTransactions(h, payload)).json()
    expect(first.syncRun).toMatchObject({
      externalSource: "google-sheets:transakcje",
      spreadsheetId: "spr-1",
      sheet: "tx",
      status: "done",
      insertedWtx: 2,
      insertedPtx: 1,
      skipped: 0,
    })

    const second = await (await postTransactions(h, payload)).json()
    expect(second.syncRun).toMatchObject({ insertedWtx: 0, insertedPtx: 0, skipped: 2, status: "done" })

    const runs = await h.db.select().from(syncRuns)
    expect(runs).toHaveLength(1)
    expect(runs[0].insertedWtx).toBe(0)
    expect(runs[0].skipped).toBe(2)
  })
})