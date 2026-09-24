import { describe, expect, it } from "vitest"
import { Hono } from "hono"
import { and, eq, sql } from "drizzle-orm"
import { makeHarness, type Harness } from "./test-utils.js"
import { createImportRoutes } from "./import.js"
import { createPortfolioRoutes } from "./portfolios.js"
import {
  wallets,
  portfolios,
  walletTransactions,
  portfolioTransactions,
  positions,
  syncRuns,
  valueSnapshots,
  shares,
  portfolioBackfillMetadata,
  labels,
  positionLabels,
  transactionLabels,
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

describe("GET /api/import/sync-runs (§23.5)", () => {
  it("lists runs for the user, most recent first, with total", async () => {
    const h = await boot()
    const { portfolioId } = await seedWalletAndPortfolio(h)
    await postTransactions(h, [buyRow(portfolioId)])

    const res = await h.app.request("/api/import/sync-runs", { headers: h.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.total).toBe(1)
    expect(body.items).toHaveLength(1)
    expect(body.items[0]).toMatchObject({
      externalSource: "google-sheets:transakcje",
      spreadsheetId: "spr-1",
      status: "done",
    })
  })

  it("filters by externalSource and paginates with limit/offset", async () => {
    const h = await boot()
    const { portfolioId } = await seedWalletAndPortfolio(h)
    await postTransactions(h, [buyRow(portfolioId)])
    await h.db.insert(syncRuns).values({
      userId: "user-1",
      externalSource: "other:source",
      spreadsheetId: "spr-2",
      sheet: "s",
      status: "done",
    })

    const filtered = await (await h.app.request("/api/import/sync-runs?externalSource=other%3Asource", { headers: h.headers })).json()
    expect(filtered.total).toBe(1)
    expect(filtered.items[0].externalSource).toBe("other:source")

    const paged = await (await h.app.request("/api/import/sync-runs?limit=1&offset=1", { headers: h.headers })).json()
    expect(paged.total).toBe(2)
    expect(paged.items).toHaveLength(1)
  })
})

describe("DELETE /api/import/sync-runs/:id (§23.5)", () => {
  it("deletes the run and returns 204; keeps imported data", async () => {
    const h = await boot()
    const { portfolioId } = await seedWalletAndPortfolio(h)
    await postTransactions(h, [buyRow(portfolioId)])
    const [run] = await h.db.select().from(syncRuns)

    const res = await h.app.request(`/api/import/sync-runs/${run.id}`, { method: "DELETE", headers: h.headers })
    expect(res.status).toBe(204)
    expect(await h.db.select().from(syncRuns)).toHaveLength(0)
    expect(await h.db.select().from(walletTransactions)).toHaveLength(1)
  })

  it("returns 404 for a run owned by another user", async () => {
    const h = await boot()
    const [run] = await h.db
      .insert(syncRuns)
      .values({ userId: "user-2", externalSource: "s", spreadsheetId: "x", sheet: "y", status: "done" })
      .returning()

    const res = await h.app.request(`/api/import/sync-runs/${run.id}`, { method: "DELETE", headers: h.headers })
    expect(res.status).toBe(404)
  })
})

describe("DELETE /api/import/source/:externalSource (§23.5)", () => {
  it("wipes only rows tagged with the source; manual wallet/portfolio survive", async () => {
    const h = await boot()
    const { walletId, portfolioId } = await seedWalletAndPortfolio(h)
    await postTransactions(h, [buyRow(portfolioId)])

    const res = await h.app.request("/api/import/source/google-sheets%3Atransakcje", {
      method: "DELETE",
      headers: h.headers,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      deleted: {
        walletTransactions: 1,
        portfolios: 0,
        wallets: 0,
        syncRuns: 1,
        positions: 0,
        portfolioTransactions: 0,
        valueSnapshots: 0,
        shares: 0,
        portfolioBackfillMetadata: 0,
        nulledWalletRefs: 0,
      },
    })

    expect(await h.db.select().from(walletTransactions)).toHaveLength(0)
    expect(await h.db.select().from(syncRuns)).toHaveLength(0)
    const [wallet] = await h.db.select().from(wallets).where(eq(wallets.id, walletId))
    const [portfolio] = await h.db.select().from(portfolios).where(eq(portfolios.id, portfolioId))
    expect(wallet).toBeDefined()
    expect(portfolio).toBeDefined()
  })

  it("cascades positions with the tagged portfolio; other-source rows survive; empty source → zero counts", async () => {
    const h = await boot()
    const { walletId, portfolioId } = await seedWalletAndPortfolio(h)
    await h.db.update(portfolios).set({ externalSource: "imp:src" }).where(eq(portfolios.id, portfolioId))
    await postTransactions(h, [buyRow(portfolioId)])
    await h.db.insert(walletTransactions).values({
      userId: "user-1",
      walletId,
      externalSource: "imp:src",
      externalId: "w-imp-1",
      type: "DEPOSIT",
      amount: "50",
      currency: "USD",
      executedAt: new Date("2024-01-01T00:00:00.000Z"),
    })

    const res = await h.app.request("/api/import/source/imp%3Asrc", { method: "DELETE", headers: h.headers })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      deleted: {
        walletTransactions: 1,
        portfolios: 1,
        wallets: 0,
        syncRuns: 0,
        positions: 1,
        portfolioTransactions: 1,
        valueSnapshots: 0,
        shares: 0,
        portfolioBackfillMetadata: 0,
        nulledWalletRefs: 0,
      },
    })
    expect(await h.db.select().from(positions)).toHaveLength(0)
    expect(await h.db.select().from(portfolioTransactions)).toHaveLength(0)
    const wtxs = await h.db.select().from(walletTransactions)
    expect(wtxs).toHaveLength(1)
    expect(wtxs[0].externalSource).toBe("google-sheets:transakcje")
    expect(await h.db.select().from(syncRuns)).toHaveLength(1)

    const empty = await (await h.app.request("/api/import/source/nobody", { method: "DELETE", headers: h.headers })).json()
    expect(empty.deleted).toEqual({
      walletTransactions: 0,
      portfolios: 0,
      wallets: 0,
      syncRuns: 0,
      positions: 0,
      portfolioTransactions: 0,
      valueSnapshots: 0,
      shares: 0,
      portfolioBackfillMetadata: 0,
      nulledWalletRefs: 0,
    })
  })

  it("wipes derived data of the source portfolio and nulls non-source wallet refs", async () => {
    const h = await boot()
    const sourceWalletId = crypto.randomUUID()
    const sourcePortfolioId = crypto.randomUUID()
    await h.db.insert(wallets).values({
      userId: "user-1",
      id: sourceWalletId,
      name: "IBKR",
      currency: "USD",
      baseCurrency: "USD",
      balance: "0",
      availableBalance: "0",
      externalSource: "imp:src",
    })
    await h.db.insert(portfolios).values({
      userId: "user-1",
      id: sourcePortfolioId,
      name: "Transakcje",
      currency: "PLN",
      baseCurrency: "PLN",
      externalSource: "imp:src",
      walletId: sourceWalletId,
    })
    await h.db.insert(positions).values({
      userId: "user-1",
      portfolioId: sourcePortfolioId,
      symbol: "AAPL",
      walletId: sourceWalletId,
    })
    await h.db.insert(valueSnapshots).values({
      portfolioId: sourcePortfolioId,
      snapshotDate: "2024-01-15",
      value: "1000",
      invested: "1000",
    })
    await h.db.insert(shares).values({
      userId: "user-1",
      portfolioId: sourcePortfolioId,
      privacySettings: {},
    })
    await h.db.insert(portfolioBackfillMetadata).values({
      portfolioId: sourcePortfolioId,
      status: "complete",
    })

    // Non-source portfolio whose position uses the source wallet as cash leg.
    const otherPortfolioId = crypto.randomUUID()
    await h.db.insert(portfolios).values({
      userId: "user-1",
      id: otherPortfolioId,
      name: "Manual",
      currency: "USD",
      baseCurrency: "USD",
      walletId: sourceWalletId,
    })
    await h.db.insert(positions).values({
      userId: "user-1",
      portfolioId: otherPortfolioId,
      symbol: "MSFT",
      walletId: sourceWalletId,
    })

    const res = await h.app.request("/api/import/source/imp%3Asrc", { method: "DELETE", headers: h.headers })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      deleted: {
        walletTransactions: 0,
        portfolios: 1,
        wallets: 1,
        syncRuns: 0,
        positions: 1,
        portfolioTransactions: 0,
        valueSnapshots: 1,
        shares: 1,
        portfolioBackfillMetadata: 1,
        nulledWalletRefs: 2,
      },
    })

    expect(await h.db.select().from(valueSnapshots)).toHaveLength(0)
    expect(await h.db.select().from(shares)).toHaveLength(0)
    expect(await h.db.select().from(portfolioBackfillMetadata)).toHaveLength(0)
    expect(await h.db.select().from(wallets)).toHaveLength(0)
    expect(await h.db.select().from(portfolios)).toHaveLength(1)
    const [survivor] = await h.db.select().from(positions)
    expect(survivor.portfolioId).toBe(otherPortfolioId)
    expect(survivor.walletId).toBeNull()
    const [otherPortfolio] = await h.db.select().from(portfolios).where(eq(portfolios.id, otherPortfolioId))
    expect(otherPortfolio.walletId).toBeNull()
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

  it("persists catalog sector/industry/country and keeps stored values on later buys (plan §28.5)", async () => {
    const h = await boot()
    const { portfolioId } = await seedWalletAndPortfolio(h)

    const res = await postTransactions(h, [
      {
        externalId: "e-buy-snt",
        walletName: "IBKR",
        executedAt: "2024-01-15T10:00:00.000Z",
        walletTx: { type: "INVEST", amount: -1200, currency: "PLN" },
        portfolioTx: {
          portfolioId,
          type: "BUY",
          instrumentSymbol: "SNT.WA",
          quantity: 10,
          price: 120,
          currency: "PLN",
          sector: "Healthcare",
          industry: "Medical Devices",
          country: "PL",
        },
      },
    ])
    expect(res.status).toBe(200)
    let [pos] = await h.db.select().from(positions).where(eq(positions.portfolioId, portfolioId))
    expect(pos.sector).toBe("Healthcare")
    expect(pos.industry).toBe("Medical Devices")
    expect(pos.country).toBe("PL")

    // a later buy without catalog fields must not revert the curated values
    const res2 = await postTransactions(h, [
      {
        externalId: "e-buy-snt2",
        walletName: "IBKR",
        executedAt: "2024-02-15T10:00:00.000Z",
        walletTx: { type: "INVEST", amount: -1200, currency: "PLN" },
        portfolioTx: { portfolioId, type: "BUY", instrumentSymbol: "SNT.WA", quantity: 10, price: 120, currency: "PLN" },
      },
    ])
    expect(res2.status).toBe(200)
    ;[pos] = await h.db.select().from(positions).where(eq(positions.portfolioId, portfolioId))
    expect(pos.sector).toBe("Healthcare")
    expect(pos.country).toBe("PL")
  })

  it("keeps the 'Other' sentinel for assets the catalog does not cover (plan §28.5)", async () => {
    const h = await boot()
    const { portfolioId } = await seedWalletAndPortfolio(h)

    const res = await postTransactions(h, [
      {
        externalId: "e-buy-fund",
        walletName: "IBKR",
        executedAt: "2024-01-15T10:00:00.000Z",
        walletTx: { type: "INVEST", amount: -100, currency: "PLN" },
        portfolioTx: { portfolioId, type: "BUY", instrumentSymbol: "GSAK.TFI", quantity: 1, price: 100, currency: "PLN" },
      },
    ])
    expect(res.status).toBe(200)
    const [pos] = await h.db.select().from(positions).where(eq(positions.portfolioId, portfolioId))
    expect(pos.sector).toBe("Other")
    expect(pos.industry).toBe("Other")
    expect(pos.country).toBe("Other")
  })

  it("BUY with price=0 imports a zero-cost position (free allotment, plan §24.8)", async () => {
    const h = await boot()
    const { portfolioId } = await seedWalletAndPortfolio(h)

    const res = await postTransactions(h, [
      {
        externalId: "e-free-1",
        walletName: "IBKR",
        executedAt: "2024-01-15T10:00:00.000Z",
        walletTx: { type: "ADJUSTMENT", amount: 0, currency: "PLN" },
        portfolioTx: { portfolioId, type: "BUY", instrumentSymbol: "SYN2BIO", quantity: 21, price: 0, currency: "PLN" },
      },
    ])
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.inserted).toBe(1)
    expect(body.errors).toEqual([])

    const [pos] = await h.db.select().from(positions).where(eq(positions.portfolioId, portfolioId))
    expect(pos.isOpen).toBe(true)
    expect(Number(pos.quantity)).toBe(21)
    expect(Number(pos.averageCostBasis)).toBe(0)
  })

  it("clamps a full-position sell within display-precision drift (plan §24.8)", async () => {
    const h = await boot()
    const { portfolioId } = await seedWalletAndPortfolio(h)

    const res = await postTransactions(h, [
      {
        externalId: "e-drift-buy",
        walletName: "IBKR",
        executedAt: "2021-08-12T10:00:00.000Z",
        walletTx: { type: "INVEST", amount: -591.39, currency: "PLN" },
        portfolioTx: { portfolioId, type: "BUY", instrumentSymbol: "GSEM60", quantity: 995.290673, price: 0.594, currency: "PLN" },
      },
      {
        externalId: "e-drift-sell",
        walletName: "IBKR",
        executedAt: "2021-09-01T10:00:00.000Z",
        walletTx: { type: "SELL", amount: 13187.6, currency: "PLN" },
        portfolioTx: { portfolioId, type: "SELL", instrumentSymbol: "GSEM60", quantity: 995.290675, price: 13.25, currency: "PLN" },
      },
    ])
    const body = await res.json()
    expect(body.errors).toEqual([])
    expect(body.inserted).toBe(2)

    const [pos] = await h.db.select().from(positions).where(eq(positions.portfolioId, portfolioId))
    expect(pos.isOpen).toBe(false)
    expect(Number(pos.quantity)).toBeCloseTo(0, 9)
  })

  it("still rejects a sell exceeding the position beyond drift tolerance", async () => {
    const h = await boot()
    const { portfolioId } = await seedWalletAndPortfolio(h)

    const res = await postTransactions(h, [
      buyRow(portfolioId, { quantity: 1, price: 10 }),
      buyRow(portfolioId, { type: "SELL", quantity: 1.001, price: 12 }, { type: "SELL", amount: 12.01 }),
    ])
    const body = await res.json()
    expect(body.errors.map((e: { error: string }) => e.error)).toEqual(["insufficient_quantity"])
  })

  it("SELL + direction=SHORT opens a short option lot distinct from the same-symbol equity lot", async () => {
    const h = await boot()
    const { portfolioId } = await seedWalletAndPortfolio(h)

    const optRow = (id: string, price: number): Record<string, unknown> => ({
      externalId: id,
      walletName: "IBKR",
      executedAt: "2024-03-15T10:00:00.000Z",
      walletTx: { type: "SELL", amount: 50, currency: "USD" },
      portfolioTx: {
        portfolioId,
        type: "SELL",
        instrumentSymbol: "SAP",
        assetType: "OPTION",
        direction: "SHORT",
        optionType: "CALL",
        contractSize: 100,
        quantity: 100,
        price,
        currency: "USD",
      },
    })

    const res = await postTransactions(h, [buyRow(portfolioId, { instrumentSymbol: "SAP" }), optRow("e-opt-1", 0.5)])
    expect((await res.json()).errors).toEqual([])

    const lots = await h.db.select().from(positions).where(eq(positions.portfolioId, portfolioId))
    const equity = lots.find((p) => p.direction == null)
    const option = lots.find((p) => p.direction === "SHORT")
    expect(Number(equity?.quantity)).toBe(10) // equity lot untouched by the option sell
    expect(Number(option?.quantity)).toBe(100)
    expect(option?.optionType).toBe("CALL")
    expect(Number(option?.contractSize)).toBe(100)
    expect(Number(option?.averageCostBasis)).toBe(0.5)

    // second written call adds to the SHORT lot (weighted-avg premium)
    const res2 = await postTransactions(h, [optRow("e-opt-2", 0.7)])
    expect((await res2.json()).errors).toEqual([])
    const after = await h.db.select().from(positions).where(eq(positions.portfolioId, portfolioId))
    const short2 = after.find((p) => p.direction === "SHORT")
    expect(Number(short2?.quantity)).toBe(200)
    expect(Number(short2?.averageCostBasis)).toBe(0.6)
    expect(after.filter((p) => p.direction == null)).toHaveLength(1)

    // the option rows are stored as SELL with no realized P/L
    const optTx = await h.db
      .select()
      .from(portfolioTransactions)
      .where(and(eq(portfolioTransactions.type, "SELL"), eq(portfolioTransactions.portfolioId, portfolioId)))
    expect(optTx).toHaveLength(2)
    expect(optTx.every((t) => t.realizedGainLoss == null)).toBe(true)
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

describe("POST /api/import/labels/bootstrap (§55.1)", () => {
  const post = (h: Awaited<ReturnType<typeof boot>>, names: string[]) =>
    h.app.request("/api/import/labels/bootstrap", {
      method: "POST",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({ externalSource: "google-sheets:transakcje", labels: names }),
    })

  it("creates labels (palette-colored) and re-uses them idempotently", async () => {
    const h = await boot()
    const first = await (await post(h, ["OwnSAP", "Crypto"])).json()
    expect(first.labels).toHaveLength(2)
    for (const l of first.labels) {
      expect(l.created).toBe(true)
      expect(l.id).toBeTypeOf("string")
      expect(l.name).toMatch(/^(OwnSAP|Crypto)$/)
    }
    const [ownsap] = first.labels.filter((l: { name: string }) => l.name === "OwnSAP")

    const second = await (await post(h, ["OwnSAP", "Dividend"])).json()
    const reuse = second.labels.find((l: { name: string }) => l.name === "OwnSAP")
    expect(reuse.id).toBe(ownsap.id)
    expect(reuse.created).toBe(false)

    const rows = await h.db.select().from(labels)
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => /^#[0-9a-f]{6}$/.test(r.color))).toBe(true)
  })

  it("labels are per-user: another user's bootstrap gets fresh ids", async () => {
    const h = await boot()
    const first = await (await post(h, ["OwnSAP"])).json()
    const h2 = await makeHarness("user-2")
    const app2 = new Hono().route("/api/import", createImportRoutes(h2.db))
    const second = await (
      await app2.request("/api/import/labels/bootstrap", {
        method: "POST",
        headers: { ...h2.headers, "content-type": "application/json" },
        body: JSON.stringify({ externalSource: "x", labels: ["OwnSAP"] }),
      })
    ).json()
    expect(second.labels[0].id).not.toBe(first.labels[0].id)
  })

  it("rejects an empty label list with 422", async () => {
    const h = await boot()
    const res = await post(h, [])
    expect(res.status).toBe(422)
  })
})

describe("import labels + dividend tax convention (§55.2)", () => {
  async function bootstrapLabels(h: Harness, names: string[]) {
    await h.app.request("/api/import/labels/bootstrap", {
      method: "POST",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({ externalSource: "google-sheets:transakcje", labels: names }),
    })
  }

  function divRow(portfolioId: string, over: Record<string, unknown> = {}, wtxOver: Record<string, unknown> = {}) {
    return {
      externalId: `div-${Math.random().toString(36).slice(2, 8)}`,
      walletName: "IBKR",
      executedAt: "2024-06-15T10:00:00.000Z",
      walletTx: { type: "DIVIDEND", amount: 225.48, currency: "EUR", ...wtxOver },
      portfolioTx: {
        portfolioId,
        type: "DIVIDEND",
        instrumentSymbol: "SAP",
        quantity: 125,
        price: 1.81,
        currency: "EUR",
        ...over,
      },
    }
  }

  it("positionLabels + transactionLabels attach to the position and the ptx row", async () => {
    const h = await boot()
    const { portfolioId } = await seedWalletAndPortfolio(h)
    await bootstrapLabels(h, ["Narzucone", "Dividend", "OwnSAP"])

    const res = await postTransactions(h, [
      buyRow(portfolioId, {
        instrumentSymbol: "SAP",
        positionLabels: ["Narzucone", "Dividend"],
        transactionLabels: ["OwnSAP"],
      }),
    ])
    expect((await res.json()).errors).toEqual([])

    const [pos] = await h.db.select().from(positions).where(eq(positions.portfolioId, portfolioId))
    const posLabels = await h.db.select().from(positionLabels).where(eq(positionLabels.positionId, pos.id))
    expect(posLabels.map((r) => r.labelId).sort()).toEqual(
      (await h.db.select({ id: labels.id, name: labels.name }).from(labels).where(eq(labels.userId, "user-1")))
        .filter((l) => l.name === "Narzucone" || l.name === "Dividend")
        .map((l) => l.id)
        .sort(),
    )

    const [ptx] = await h.db
      .select()
      .from(portfolioTransactions)
      .where(and(eq(portfolioTransactions.portfolioId, portfolioId), eq(portfolioTransactions.type, "BUY")))
    const tLabels = await h.db.select().from(transactionLabels).where(eq(transactionLabels.transactionId, ptx.id))
    expect(tLabels).toHaveLength(1)
    const [ownsap] = await h.db.select().from(labels).where(eq(labels.name, "OwnSAP"))
    expect(tLabels[0].labelId).toBe(ownsap.id)
  })

  it("unknown label name fails only that row with label_not_found", async () => {
    const h = await boot()
    const { portfolioId } = await seedWalletAndPortfolio(h)
    await bootstrapLabels(h, ["Known"])

    const res = await postTransactions(h, [
      buyRow(portfolioId, { instrumentSymbol: "AAPL", transactionLabels: ["Known", "Ghost"] }),
      buyRow(portfolioId, { instrumentSymbol: "MSFT", transactionLabels: ["Known"] }),
    ])
    const body = await res.json()
    expect(body.inserted).toBe(1)
    expect(body.errors.map((e: { error: string }) => e.error)).toEqual(["label_not_found"])
    expect(body.errors[0].message).toContain("Ghost")

    const msftTx = await h.db
      .select()
      .from(portfolioTransactions)
      .where(eq(portfolioTransactions.instrumentSymbol, "MSFT"))
    const joined = await h.db.select().from(transactionLabels).where(eq(transactionLabels.transactionId, msftTx[0].id))
    expect(joined).toHaveLength(1)
  })

  it("DIVIDEND with taxes: ptx totalAmount = gross − taxes (net), wallet amount untouched", async () => {
    const h = await boot()
    const { portfolioId } = await seedWalletAndPortfolio(h)

    // SAP 2022-05-23 shape: gross 306.25 EUR, tax 80.77 EUR, net cash 225.48
    const res = await postTransactions(h, [
      divRow(portfolioId, {
        price: 306.25 / 125,
        taxes: 80.77,
        exchangeRate: 4.62,
        rateSource: "manual",
      }),
    ])
    const body = await res.json()
    expect(body.errors).toEqual([])
    expect(body.inserted).toBe(1)

    const [ptx] = await h.db.select().from(portfolioTransactions).where(eq(portfolioTransactions.portfolioId, portfolioId))
    expect(Number(ptx.taxes)).toBe(80.77)
    expect(Number(ptx.totalAmount)).toBeCloseTo(225.48, 2) // gross − tax
    expect(Number(ptx.convertedTotalAmount)).toBeCloseTo(225.48 * 4.62, 2)

    const [wtx] = await h.db.select().from(walletTransactions)
    expect(Number(wtx.amount)).toBe(225.48) // the sheet's net cash, as sent
  })

  it("DIVIDEND with taxes > gross fails the row with dividend_taxes_exceed_gross", async () => {
    const h = await boot()
    const { portfolioId } = await seedWalletAndPortfolio(h)

    const res = await postTransactions(h, [divRow(portfolioId, { taxes: 999 })])
    const body = await res.json()
    expect(body.errors.map((e: { error: string }) => e.error)).toEqual(["dividend_taxes_exceed_gross"])

    const ptxCount = await h.db.select().from(portfolioTransactions)
    expect(ptxCount).toHaveLength(0)
  })

  it("DIVIDEND without taxes keeps totalAmount = gross (unchanged behavior)", async () => {
    const h = await boot()
    const { portfolioId } = await seedWalletAndPortfolio(h)

    const res = await postTransactions(h, [divRow(portfolioId)])
    expect((await res.json()).errors).toEqual([])

    const [ptx] = await h.db.select().from(portfolioTransactions).where(eq(portfolioTransactions.portfolioId, portfolioId))
    expect(ptx.taxes).toBeNull()
    expect(Number(ptx.totalAmount)).toBeCloseTo(125 * 1.81, 2)
  })

  it("DIVIDEND with positionLabels attaches to the open lot without touching the ledger", async () => {
    const h = await boot()
    const { portfolioId } = await seedWalletAndPortfolio(h)
    await bootstrapLabels(h, ["Moje IKE"])

    // open lot first, then the dividend
    const r1 = await postTransactions(h, [buyRow(portfolioId, { instrumentSymbol: "MOBR" })])
    expect((await r1.json()).errors).toEqual([])

    const r2 = await postTransactions(h, [
      divRow(portfolioId, { instrumentSymbol: "MOBR", quantity: 10, price: 2, positionLabels: ["Moje IKE"] }, { amount: 20, currency: "PLN" }),
    ])
    expect((await r2.json()).errors).toEqual([])

    const [pos] = await h.db.select().from(positions).where(eq(positions.portfolioId, portfolioId))
    expect(Number(pos.quantity)).toBe(10) // untouched by the DIVIDEND row
    const joined = await h.db.select().from(positionLabels).where(eq(positionLabels.positionId, pos.id))
    expect(joined).toHaveLength(1)

    // a dividend on a CLOSED position: row still imports, position labels skipped
    const r3 = await postTransactions(h, [buyRow(portfolioId, { type: "SELL", instrumentSymbol: "MOBR", quantity: 10, price: 3 }, { type: "SELL", amount: 30 })])
    expect((await r3.json()).errors).toEqual([])
    const r4 = await postTransactions(h, [
      divRow(portfolioId, { instrumentSymbol: "MOBR", quantity: 10, price: 1, transactionLabels: ["Moje IKE"], positionLabels: ["Moje IKE"] }, { amount: 10, currency: "PLN" }),
    ])
    const b4 = await r4.json()
    expect(b4.errors).toEqual([])
    expect(b4.inserted).toBe(1)
  })
})