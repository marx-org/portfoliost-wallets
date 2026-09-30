import { describe, expect, it } from "vitest"
import { Hono } from "hono"
import { and, eq, sql } from "drizzle-orm"
import { makeHarness, type Harness } from "./test-utils.js"
import { createImportRoutes } from "./import.js"
import { createPortfolioRoutes } from "./portfolios.js"
import {
  portfolios,
  portfolioCashTransactions,
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

async function seedPortfolio(h: Harness) {
  const userId = "user-1"
  const portfolioId = crypto.randomUUID()
  await h.db.insert(portfolios).values({
    userId,
    id: portfolioId,
    name: "Transakcje",
    baseCurrency: "PLN",
  })
  return { userId, portfolioId }
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
): Record<string, unknown> {
  return {
    externalId: `buy-${Math.random().toString(36).slice(2, 8)}`,
    portfolioName: "Transakcje",
    executedAt: "2024-01-15T10:00:00.000Z",
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

describe("POST /api/import/portfolios/bootstrap (§23.3)", () => {
  // 30s: this is the first test in the file, so it pays for `boot()` — harness,
  // schema migration and a real Postgres — before it asserts anything. Under a
  // full-suite run that contends with the other 28 files for the database and it
  // intermittently blew vitest's 5s DEFAULT timeout, which reads as a logic
  // failure and is not one: standalone the file's 50 tests pass in 23s. Observed
  // twice, never reproduced once it was given room.
  it("creates a portfolio tagged with externalSource; second call is idempotent", { timeout: 30_000 }, async () => {
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
    const { portfolioId } = await seedPortfolio(h)
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
    const { portfolioId } = await seedPortfolio(h)
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
    const { portfolioId } = await seedPortfolio(h)
    await postTransactions(h, [buyRow(portfolioId)])
    const [run] = await h.db.select().from(syncRuns)

    const res = await h.app.request(`/api/import/sync-runs/${run.id}`, { method: "DELETE", headers: h.headers })
    expect(res.status).toBe(204)
    expect(await h.db.select().from(syncRuns)).toHaveLength(0)
    expect(await h.db.select().from(portfolioTransactions)).toHaveLength(1)
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

const ZERO_DELETED = {
  cashTransactions: 0,
  portfolios: 0,
  syncRuns: 0,
  positions: 0,
  portfolioTransactions: 0,
  valueSnapshots: 0,
  shares: 0,
  portfolioBackfillMetadata: 0,
}

describe("DELETE /api/import/source/:externalSource (§23.5)", () => {
  it("wipes only rows tagged with the source; the portfolio (not source-tagged) survives", async () => {
    const h = await boot()
    const { portfolioId } = await seedPortfolio(h)
    await postTransactions(h, [buyRow(portfolioId)])

    const res = await h.app.request("/api/import/source/google-sheets%3Atransakcje", {
      method: "DELETE",
      headers: h.headers,
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      deleted: {
        ...ZERO_DELETED,
        syncRuns: 1,
      },
    })

    expect(await h.db.select().from(syncRuns)).toHaveLength(0)
    const [portfolio] = await h.db.select().from(portfolios).where(eq(portfolios.id, portfolioId))
    expect(portfolio).toBeDefined()
  })

  it("cascades positions with the source-tagged portfolio; a non-tagged portfolio's cash tx survive; empty source → zero counts", async () => {
    const h = await boot()
    const { portfolioId } = await seedPortfolio(h)
    await h.db.update(portfolios).set({ externalSource: "imp:src" }).where(eq(portfolios.id, portfolioId))
    await postTransactions(h, [buyRow(portfolioId)])
    // a SECOND, non-source-tagged portfolio holds a cash row that must survive
    const keepPortfolioId = crypto.randomUUID()
    await h.db.insert(portfolios).values({ userId: "user-1", id: keepPortfolioId, name: "Manual", baseCurrency: "USD" })
    await h.db.insert(portfolioCashTransactions).values({
      userId: "user-1",
      portfolioId: keepPortfolioId,
      externalSource: "other:src",
      externalId: "keep-1",
      type: "DEPOSIT",
      amount: "50",
      currency: "USD",
      status: "completed",
      transactionDate: "2024-01-01",
    })

    const res = await h.app.request("/api/import/source/imp%3Asrc", { method: "DELETE", headers: h.headers })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      deleted: { ...ZERO_DELETED, portfolios: 1, positions: 1, portfolioTransactions: 1 },
    })
    expect(await h.db.select().from(positions)).toHaveLength(0)
    expect(await h.db.select().from(portfolioTransactions)).toHaveLength(0)
    const remainingPortfolios = await h.db.select({ id: portfolios.id }).from(portfolios)
    expect(remainingPortfolios).toHaveLength(1)
    expect(remainingPortfolios[0].id).toBe(keepPortfolioId)
    const survivors = await h.db.select().from(portfolioCashTransactions)
    expect(survivors).toHaveLength(1)
    expect(survivors[0].externalSource).toBe("other:src")
    expect(await h.db.select().from(syncRuns)).toHaveLength(1)

    const empty = await (await h.app.request("/api/import/source/nobody", { method: "DELETE", headers: h.headers })).json()
    expect(empty.deleted).toEqual(ZERO_DELETED)
  })

  it("wipes derived data of a source-tagged portfolio (snapshots/shares/backfill cascade)", async () => {
    const h = await boot()
    const sourcePortfolioId = crypto.randomUUID()
    await h.db.insert(portfolios).values({
      userId: "user-1",
      id: sourcePortfolioId,
      name: "Transakcje",
      baseCurrency: "PLN",
      externalSource: "imp:src",
    })
    await h.db.insert(positions).values({ userId: "user-1", portfolioId: sourcePortfolioId, symbol: "AAPL" })
    await h.db.insert(valueSnapshots).values({
      portfolioId: sourcePortfolioId,
      snapshotDate: "2024-01-15",
      value: "1000",
      invested: "1000",
    })
    await h.db.insert(shares).values({ userId: "user-1", portfolioId: sourcePortfolioId, privacySettings: {} })
    await h.db.insert(portfolioBackfillMetadata).values({ portfolioId: sourcePortfolioId, status: "complete" })

    const res = await h.app.request("/api/import/source/imp%3Asrc", { method: "DELETE", headers: h.headers })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      deleted: { ...ZERO_DELETED, portfolios: 1, positions: 1, valueSnapshots: 1, shares: 1, portfolioBackfillMetadata: 1 },
    })
    expect(await h.db.select().from(valueSnapshots)).toHaveLength(0)
    expect(await h.db.select().from(shares)).toHaveLength(0)
    expect(await h.db.select().from(portfolioBackfillMetadata)).toHaveLength(0)
    expect(await h.db.select().from(portfolios)).toHaveLength(0)
  })
})

describe("POST /api/import/transactions (§23.4)", () => {
  it("BUY then SELL restates the position (avg cost, qty, realizedGainLoss)", async () => {
    const h = await boot()
    const { portfolioId } = await seedPortfolio(h)

    const res = await postTransactions(h, [
      {
        externalId: "e-deposit-1",
        portfolioName: "Transakcje",
        executedAt: "2024-01-10T10:00:00.000Z",
        cashTx: { type: "DEPOSIT", amount: 1000, currency: "USD" },
      },
      {
        externalId: "e-buy-1",
        portfolioName: "Transakcje",
        executedAt: "2024-01-15T10:00:00.000Z",
        portfolioTx: { portfolioId, type: "BUY", instrumentSymbol: "AAPL", quantity: 10, price: 100, currency: "USD" },
      },
      {
        externalId: "e-sell-1",
        portfolioName: "Transakcje",
        executedAt: "2024-02-15T10:00:00.000Z",
        portfolioTx: { portfolioId, type: "SELL", instrumentSymbol: "AAPL", quantity: 4, price: 120, currency: "USD" },
      },
    ])
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.inserted).toBe(3) // 1 DEPOSIT + BUY + SELL
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
    expect(Number(portfolio.totalInvested)).toBe(1000) // = the 1000 deposit (net external flow)
  })

  it("persists catalog sector/industry/country and keeps stored values on later buys (plan §28.5)", async () => {
    const h = await boot()
    const { portfolioId } = await seedPortfolio(h)

    const res = await postTransactions(h, [
      {
        externalId: "e-buy-snt",
        portfolioName: "Transakcje",
        executedAt: "2024-01-15T10:00:00.000Z",
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
        portfolioName: "Transakcje",
        executedAt: "2024-02-15T10:00:00.000Z",
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
    const { portfolioId } = await seedPortfolio(h)

    const res = await postTransactions(h, [
      {
        externalId: "e-buy-fund",
        portfolioName: "Transakcje",
        executedAt: "2024-01-15T10:00:00.000Z",
        portfolioTx: { portfolioId, type: "BUY", instrumentSymbol: "GSAK.TFI", quantity: 1, price: 100, currency: "PLN" },
      },
    ])
    expect(res.status).toBe(200)
    const [pos] = await h.db.select().from(positions).where(eq(positions.portfolioId, portfolioId))
    expect(pos.sector).toBe("Other")
    expect(pos.industry).toBe("Other")
    // §61 — null, not "Other". A country CODE cannot be the display sentinel;
    // that is what made the badge render `(OTHER) Bond`.
    expect(pos.country).toBeNull()
  })

  it("BUY with price=0 imports a zero-cost position (free allotment, plan §24.8)", async () => {
    const h = await boot()
    const { portfolioId } = await seedPortfolio(h)

    const res = await postTransactions(h, [
      {
        externalId: "e-free-1",
        portfolioName: "Transakcje",
        executedAt: "2024-01-15T10:00:00.000Z",
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
    const { portfolioId } = await seedPortfolio(h)

    const res = await postTransactions(h, [
      {
        externalId: "e-drift-buy",
        portfolioName: "Transakcje",
        executedAt: "2021-08-12T10:00:00.000Z",
        portfolioTx: { portfolioId, type: "BUY", instrumentSymbol: "GSEM60", quantity: 995.290673, price: 0.594, currency: "PLN" },
      },
      {
        externalId: "e-drift-sell",
        portfolioName: "Transakcje",
        executedAt: "2021-09-01T10:00:00.000Z",
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
    const { portfolioId } = await seedPortfolio(h)

    const res = await postTransactions(h, [
      buyRow(portfolioId, { quantity: 1, price: 10 }),
      buyRow(portfolioId, { type: "SELL", quantity: 1.001, price: 12 }),
    ])
    const body = await res.json()
    expect(body.errors.map((e: { error: string }) => e.error)).toEqual(["insufficient_quantity"])
  })

  it("SELL + direction=SHORT opens a short option lot distinct from the same-symbol equity lot", async () => {
    const h = await boot()
    const { portfolioId } = await seedPortfolio(h)

    const optRow = (id: string, price: number): Record<string, unknown> => ({
      externalId: id,
      portfolioName: "Transakcje",
      executedAt: "2024-03-15T10:00:00.000Z",
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

  it("EXPIRATION closes the short option lot at zero value (zero cash effect)", async () => {
    const h = await boot()
    const { portfolioId } = await seedPortfolio(h)

    const leg = (type: string, externalId: string): Record<string, unknown> => ({
      externalId,
      portfolioName: "Transakcje",
      executedAt: "2024-03-15T10:00:00.000Z",
      portfolioTx: {
        portfolioId,
        type,
        instrumentSymbol: "SAP",
        assetType: "OPTION",
        direction: "SHORT",
        optionType: "CALL",
        contractSize: 100,
        quantity: 100,
        price: type === "EXPIRATION" ? 0 : 0.5,
        currency: "USD",
      },
    })

    // open the short lot (a written call), then expire it
    const res = await postTransactions(h, [leg("SELL", "e-exp-open"), leg("EXPIRATION", "e-exp-open#e")])
    expect((await res.json()).errors).toEqual([])

    const lots = await h.db.select().from(positions).where(eq(positions.portfolioId, portfolioId))
    const option = lots.find((p) => p.direction === "SHORT")
    expect(option?.isOpen).toBe(false)
    expect(Number(option?.quantity)).toBe(0)

    const expTx = await h.db
      .select()
      .from(portfolioTransactions)
      .where(and(eq(portfolioTransactions.type, "EXPIRATION"), eq(portfolioTransactions.portfolioId, portfolioId)))
    expect(expTx).toHaveLength(1)
    expect(Number(expTx[0].totalAmount)).toBe(0)
    // the expiry realizes −premium × qty (the short lot's P/L)
    expect(Number(expTx[0].realizedGainLoss)).toBe(-50)

    // no cash leg was created by the expiry (the premium cash came from the SELL)
    const cashTxs = await h.db
      .select()
      .from(portfolioCashTransactions)
      .where(eq(portfolioCashTransactions.portfolioId, portfolioId))
    expect(cashTxs).toHaveLength(0)
  })

  it("EXPIRATION with a non-zero price or fees → row error", async () => {
    const h = await boot()
    const { portfolioId } = await seedPortfolio(h)
    const bad = {
      externalId: "e-exp-bad",
      portfolioName: "Transakcje",
      executedAt: "2024-03-15T10:00:00.000Z",
      portfolioTx: {
        portfolioId,
        type: "EXPIRATION",
        instrumentSymbol: "SAP",
        assetType: "OPTION",
        direction: "SHORT",
        quantity: 100,
        price: 0.5,
        currency: "USD",
      },
    }
    const res = await postTransactions(h, [bad])
    const body = await res.json()
    expect(body.errors.map((e: { error: string }) => e.error)).toEqual(["expiration_must_be_zero_value"])
  })

  it("EXPIRATION without an open short lot → row error", async () => {
    const h = await boot()
    const { portfolioId } = await seedPortfolio(h)
    const bad = {
      externalId: "e-exp-nolot",
      portfolioName: "Transakcje",
      executedAt: "2024-03-15T10:00:00.000Z",
      portfolioTx: {
        portfolioId,
        type: "EXPIRATION",
        instrumentSymbol: "SAP",
        assetType: "OPTION",
        direction: "SHORT",
        quantity: 100,
        price: 0,
        currency: "USD",
      },
    }
    const res = await postTransactions(h, [bad])
    const body = await res.json()
    expect(body.errors.map((e: { error: string }) => e.error)).toEqual(["no_open_position"])
  })

  it("stores pre-restatement originalQuantity/originalPrice independently from restated values", async () => {
    const h = await boot()
    const { portfolioId } = await seedPortfolio(h)

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
    const { portfolioId } = await seedPortfolio(h)
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
    const { portfolioId } = await seedPortfolio(h)
    const payload = [buyRow(portfolioId), { ...buyRow(portfolioId, { instrumentSymbol: "MSFT" }), externalId: "dup-2" }]

    const first = await (await postTransactions(h, payload)).json()
    expect(first.inserted).toBe(2)
    expect(first.skipped).toBe(0)

    const second = await (await postTransactions(h, payload)).json()
    expect(second.inserted).toBe(0)
    expect(second.skipped).toBe(2)
    expect(second.errors).toEqual([])
  })

  it("unknown portfolioName on a cash row collects an error while the rest of the batch succeeds", async () => {
    const h = await boot()
    const { portfolioId } = await seedPortfolio(h)

    const res = await postTransactions(h, [
      {
        externalId: "e-bad",
        portfolioName: "NOPE",
        executedAt: "2024-01-15T10:00:00.000Z",
        cashTx: { type: "DEPOSIT", amount: 100, currency: "USD" },
      },
      buyRow(portfolioId),
    ])
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.inserted).toBe(1)
    expect(body.errors).toEqual([
      { externalId: "e-bad", error: "portfolio_not_found", message: expect.stringContaining("NOPE") },
    ])
    expect(body.syncRun.status).toBe("done")

    const cashTxs = await h.db.select().from(portfolioCashTransactions)
    expect(cashTxs).toHaveLength(0) // the cash row was not inserted
    expect((await h.db.select().from(portfolioTransactions))).toHaveLength(1)
  })

  it("all rows failing marks the sync_run as failed", async () => {
    const h = await boot()
    const res = await postTransactions(h, [
      {
        externalId: "e-fail",
        portfolioName: "NOPE",
        executedAt: "2024-01-15T10:00:00.000Z",
        cashTx: { type: "DEPOSIT", amount: 100, currency: "USD" },
      },
    ])
    const body = await res.json()
    expect(body.inserted).toBe(0)
    expect(body.errors[0].error).toBe("portfolio_not_found")
    expect(body.syncRun.status).toBe("failed")
    expect(body.syncRun.error).toBeTruthy()
  })

  it("a cash-only row (no portfolioTx) creates an external cash tx only", async () => {
    const h = await boot()
    const { portfolioId } = await seedPortfolio(h)

    const res = await postTransactions(h, [
      {
        externalId: "e-dep",
        portfolioName: "Transakcje",
        executedAt: "2024-01-15T10:00:00.000Z",
        cashTx: { type: "DEPOSIT", amount: 500, currency: "USD", description: "disbursement" },
      },
    ])
    expect(res.status).toBe(200)
    expect((await res.json()).inserted).toBe(1)

    const [c] = await h.db.select().from(portfolioCashTransactions)
    expect(c.type).toBe("DEPOSIT")
    expect(c.portfolioId).toBe(portfolioId)
    expect(Number(c.amount)).toBe(500)

    expect(await h.db.select().from(portfolioTransactions)).toHaveLength(0)
    expect(await h.db.select().from(positions)).toHaveLength(0)
  })

  it("external cash balance is the sum of external rows (derived, never stored)", async () => {
    const h = await boot()
    const { portfolioId } = await seedPortfolio(h)

    const res = await postTransactions(h, [
      { externalId: "b1", portfolioName: "Transakcje", executedAt: "2024-01-01T00:00:00.000Z", cashTx: { type: "DEPOSIT", amount: 500, currency: "USD" } },
      { externalId: "b2", portfolioName: "Transakcje", executedAt: "2024-01-02T00:00:00.000Z", cashTx: { type: "DEPOSIT", amount: 300, currency: "USD" } },
      { externalId: "b3", portfolioName: "Transakcje", executedAt: "2024-01-03T00:00:00.000Z", cashTx: { type: "WITHDRAWAL", amount: -100, currency: "USD" } },
    ])
    expect(res.status).toBe(200)
    expect((await res.json()).inserted).toBe(3)

    const [agg] = await h.db.select({ sum: sql<string>`coalesce(sum(${portfolioCashTransactions.amount}), 0)` })
      .from(portfolioCashTransactions)
      .where(eq(portfolioCashTransactions.portfolioId, portfolioId))
    expect(Number(agg.sum)).toBe(700)
  })

  it("upserts a sync_runs row with correct counters and reuses it across batches", async () => {
    const h = await boot()
    const { portfolioId } = await seedPortfolio(h)
    const payload = [
      {
        externalId: "e-buy-1",
        portfolioName: "Transakcje",
        executedAt: "2024-01-15T10:00:00.000Z",
        portfolioTx: { portfolioId, type: "BUY", instrumentSymbol: "AAPL", quantity: 10, price: 100, currency: "USD" },
      },
      {
        externalId: "e-dep",
        portfolioName: "Transakcje",
        executedAt: "2024-01-16T10:00:00.000Z",
        cashTx: { type: "DEPOSIT", amount: 500, currency: "USD" }
      },
    ]

    const first = await (await postTransactions(h, payload)).json()
    expect(first.syncRun).toMatchObject({
      externalSource: "google-sheets:transakcje",
      spreadsheetId: "spr-1",
      sheet: "tx",
      status: "done",
      insertedCashTx: 1,
      insertedPtx: 1,
      skipped: 0,
    })

    const second = await (await postTransactions(h, payload)).json()
    expect(second.syncRun).toMatchObject({ insertedCashTx: 0, insertedPtx: 0, skipped: 2, status: "done" })

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

  function divRow(portfolioId: string, over: Record<string, unknown> = {}) {
    return {
      externalId: `div-${Math.random().toString(36).slice(2, 8)}`,
      portfolioName: "Transakcje",
      executedAt: "2024-06-15T10:00:00.000Z",
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
    const { portfolioId } = await seedPortfolio(h)
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
    const { portfolioId } = await seedPortfolio(h)
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

  it("DIVIDEND with taxes: ptx totalAmount = gross − taxes (net)", async () => {
    const h = await boot()
    const { portfolioId } = await seedPortfolio(h)

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

    // the net dividend cash is derived by replay (no stored cash row)
    const { cashBalances } = await import("../services/cashLedger.js")
    const balances = await cashBalances(h.db, null, portfolioId)
    expect(balances.get("EUR")).toBeCloseTo(225.48, 2)
  })

  it("DIVIDEND with taxes > gross fails the row with dividend_taxes_exceed_gross", async () => {
    const h = await boot()
    const { portfolioId } = await seedPortfolio(h)

    const res = await postTransactions(h, [divRow(portfolioId, { taxes: 999 })])
    const body = await res.json()
    expect(body.errors.map((e: { error: string }) => e.error)).toEqual(["dividend_taxes_exceed_gross"])

    const ptxCount = await h.db.select().from(portfolioTransactions)
    expect(ptxCount).toHaveLength(0)
  })

  it("DIVIDEND without taxes keeps totalAmount = gross (unchanged behavior)", async () => {
    const h = await boot()
    const { portfolioId } = await seedPortfolio(h)

    const res = await postTransactions(h, [divRow(portfolioId)])
    expect((await res.json()).errors).toEqual([])

    const [ptx] = await h.db.select().from(portfolioTransactions).where(eq(portfolioTransactions.portfolioId, portfolioId))
    expect(ptx.taxes).toBeNull()
    expect(Number(ptx.totalAmount)).toBeCloseTo(125 * 1.81, 2)
  })

  it("DIVIDEND with positionLabels attaches to the open lot without touching the ledger", async () => {
    const h = await boot()
    const { portfolioId } = await seedPortfolio(h)
    await bootstrapLabels(h, ["Moje IKE"])

    // open lot first, then the dividend
    const r1 = await postTransactions(h, [buyRow(portfolioId, { instrumentSymbol: "MOBR" })])
    expect((await r1.json()).errors).toEqual([])

    const r2 = await postTransactions(h, [
      divRow(portfolioId, { instrumentSymbol: "MOBR", quantity: 10, price: 2, positionLabels: ["Moje IKE"] }),
    ])
    expect((await r2.json()).errors).toEqual([])

    const [pos] = await h.db.select().from(positions).where(eq(positions.portfolioId, portfolioId))
    expect(Number(pos.quantity)).toBe(10) // untouched by the DIVIDEND row
    const joined = await h.db.select().from(positionLabels).where(eq(positionLabels.positionId, pos.id))
    expect(joined).toHaveLength(1)

    // a dividend on a CLOSED position: row still imports, position labels skipped
    const r3 = await postTransactions(h, [buyRow(portfolioId, { type: "SELL", instrumentSymbol: "MOBR", quantity: 10, price: 3 })])
    expect((await r3.json()).errors).toEqual([])
    const r4 = await postTransactions(h, [
      divRow(portfolioId, { instrumentSymbol: "MOBR", quantity: 10, price: 1, transactionLabels: ["Moje IKE"], positionLabels: ["Moje IKE"] }),
    ])
    const b4 = await r4.json()
    expect(b4.errors).toEqual([])
    expect(b4.inserted).toBe(1)
  })
})

describe("§62.5 — import on the new cash schema", () => {
  it("DEPOSIT/WITHDRAWAL land with clamped signs + labels", async () => {
    const h = await boot()
    await seedPortfolio(h)
    // bootstrap the label the row will reference (§55.1)
    await h.app.request("/api/import/labels/bootstrap", {
      method: "POST",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({ externalSource: "google-sheets:transakcje", labels: ["Crypto"] }),
    })

    const res = await postTransactions(h, [
      { externalId: "d1", portfolioName: "Transakcje", executedAt: "2024-01-01T00:00:00.000Z",
        cashTx: { type: "DEPOSIT", amount: -500, currency: "USD", labels: ["Crypto"] } },
      { externalId: "w1", portfolioName: "Transakcje", executedAt: "2024-01-02T00:00:00.000Z",
        cashTx: { type: "WITHDRAWAL", amount: 100, currency: "USD" } },
    ])
    expect(res.status).toBe(200)
    expect((await res.json()).errors).toEqual([])

    const rows = await h.db.select().from(portfolioCashTransactions).orderBy(portfolioCashTransactions.createdAt)
    const dep = rows.find((r) => r.type === "DEPOSIT")!
    const wdr = rows.find((r) => r.type === "WITHDRAWAL")!
    expect(Number(dep.amount)).toBe(500) // clamped positive
    expect(Number(wdr.amount)).toBe(-100) // clamped negative

    const { portfolioCashTransactionLabels } = await import("../db/schema.js")
    const { labels } = await import("../db/schema.js")
    const [lbl] = await h.db.select().from(labels).where(eq(labels.name, "Crypto"))
    const joins = await h.db.select().from(portfolioCashTransactionLabels).where(eq(portfolioCashTransactionLabels.cashTransactionId, dep.id))
    expect(joins).toHaveLength(1)
    expect(joins[0].labelId).toBe(lbl.id)
  })

  it("cross-ccy TRANSFER pair: amounts, linkedTxId, both portfolios' balances move", async () => {
    const h = await boot()
    const { portfolioId } = await seedPortfolio(h) // Transakcje
    const otherId = crypto.randomUUID()
    await h.db.insert(portfolios).values({ userId: "user-1", id: otherId, name: "IKE", baseCurrency: "USD" })

    const res = await postTransactions(h, [
      { externalId: "tr-1", portfolioName: "Transakcje", executedAt: "2024-01-01T00:00:00.000Z",
        cashTx: { type: "TRANSFER", amount: -200, currency: "USD", toPortfolioName: "IKE", exchangeRate: 1, description: "Sell: X (→ IKE)" } },
    ])
    expect(res.status).toBe(200)
    expect((await res.json()).errors).toEqual([])

    const legs = await h.db.select().from(portfolioCashTransactions).where(eq(portfolioCashTransactions.type, "TRANSFER"))
    expect(legs).toHaveLength(2)
    const debit = legs.find((l) => l.portfolioId === portfolioId)!
    const credit = legs.find((l) => l.portfolioId === otherId)!
    expect(Number(debit.amount)).toBe(-200)
    expect(Number(credit.amount)).toBe(200)
    expect(debit.linkedTxId).toBe(credit.id)
    expect(credit.linkedTxId).toBe(debit.id)
    expect(credit.externalId).toBe("tr-1#t")
    // the server-created credit leg states where the money came from
    expect(debit.description).toBe("Sell: X (→ IKE)")
    expect(credit.description).toBe("Sell: X (→ IKE) (from Transakcje)")

    const { cashBalances } = await import("../services/cashLedger.js")
    expect((await cashBalances(h.db, null, portfolioId)).get("USD")).toBe(-200)
    expect((await cashBalances(h.db, null, otherId)).get("USD")).toBe(200)
  })

  it("unknown portfolio name on a cash row → row error", async () => {
    const h = await boot()
    await seedPortfolio(h)
    const res = await postTransactions(h, [
      { externalId: "bad", portfolioName: "NOPE", executedAt: "2024-01-01T00:00:00.000Z",
        cashTx: { type: "DEPOSIT", amount: 10, currency: "USD" } },
    ])
    const body = await res.json()
    expect(body.errors[0].error).toBe("portfolio_not_found")
  })

  it("TRANSFER re-import: the #t credit leg dedupes (idempotent)", async () => {
    const h = await boot()
    const { portfolioId } = await seedPortfolio(h)
    const otherId = crypto.randomUUID()
    await h.db.insert(portfolios).values({ userId: "user-1", id: otherId, name: "IKE", baseCurrency: "USD" })
    const payload = [
      { externalId: "tr-x", portfolioName: "Transakcje", executedAt: "2024-01-01T00:00:00.000Z",
        cashTx: { type: "TRANSFER", amount: -50, currency: "USD", toPortfolioName: "IKE" } },
    ]
    const first = await (await postTransactions(h, payload)).json()
    expect(first.inserted).toBe(1)
    const second = await (await postTransactions(h, payload)).json()
    expect(second.inserted).toBe(0)
    expect(second.skipped).toBe(1)
    expect(await h.db.select().from(portfolioCashTransactions).where(eq(portfolioCashTransactions.type, "TRANSFER"))).toHaveLength(2)
  })

  it("wipe removes both transfer legs; re-import recreates idempotently", async () => {
    const h = await boot()
    const { portfolioId } = await seedPortfolio(h)
    const otherId = crypto.randomUUID()
    await h.db.insert(portfolios).values({ userId: "user-1", id: otherId, name: "IKE", baseCurrency: "USD" })
    const payload = [
      { externalId: "tr-w", portfolioName: "Transakcje", executedAt: "2024-01-01T00:00:00.000Z",
        cashTx: { type: "TRANSFER", amount: -30, currency: "USD", toPortfolioName: "IKE" } },
    ]
    await (await postTransactions(h, payload)).json()
    expect(await h.db.select().from(portfolioCashTransactions)).toHaveLength(2)

    // wipe the source (both legs are tagged google-sheets:transakcje)
    const wipe = await h.app.request("/api/import/source/google-sheets%3Atransakcje", { method: "DELETE", headers: h.headers })
    expect(wipe.status).toBe(200)
    expect(await h.db.select().from(portfolioCashTransactions)).toHaveLength(0)

    // re-import recreates exactly the pair
    const re = await (await postTransactions(h, payload)).json()
    expect(re.inserted).toBe(1)
    expect(await h.db.select().from(portfolioCashTransactions)).toHaveLength(2)
  })
})

/**
 * §69.3 — a bulk import must re-backfill what it touched.
 *
 * Every single-transaction route in portfolio-transactions.ts calls
 * notifyTransactionsChanged; this bulk route did not, and it is the route
 * sheets-sync uses. So a wipe & re-import rebuilt nothing: the only automatic
 * revaluation was the twice-daily snapshotsync, which re-values the LAST TWO
 * DAYS. A backdated row's whole cumulative effect therefore landed on whichever
 * snapshot was written next — PROD showed a 15,777 PLN deposit missing since
 * 2021 appearing in one step, in two portfolios on the same day.
 */
describe("§69.3: the bulk import queues a re-backfill for what it touched", () => {
  it("a row touching a portfolio marks that portfolio for rebuild", async () => {
    const h = await boot()
    const { portfolioId } = await seedPortfolio(h)
    const res = await postTransactions(h, [
      {
        externalId: "e69-1",
        portfolioName: "Transakcje",
        executedAt: "2024-01-10T10:00:00.000Z",
        cashTx: { type: "DEPOSIT", amount: 1000, currency: "USD" },
      },
      {
        externalId: "e69-2",
        portfolioName: "Transakcje",
        executedAt: "2024-01-15T10:00:00.000Z",
        portfolioTx: { portfolioId, type: "BUY", instrumentSymbol: "AAPL", quantity: 10, price: 100, currency: "USD" },
      },
    ])
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.inserted).toBe(2)
    // the rebuild is queued fire-and-forget; the row is present and the request
    // did not fail or hang on it
    const [row] = await h.db
      .select({ portfolioId: portfolioTransactions.portfolioId })
      .from(portfolioTransactions)
      .where(eq(portfolioTransactions.externalId, "e69-2"))
    expect(row.portfolioId).toBe(portfolioId)
  })

  it("a fully-skipped (already imported) batch still imports cleanly", async () => {
    // idempotent re-submission: the notify must not turn a no-op into a failure
    const h = await boot()
    const { portfolioId } = await seedPortfolio(h)
    const rows = [
      {
        externalId: "e69-3",
        portfolioName: "Transakcje",
        executedAt: "2024-01-10T10:00:00.000Z",
        cashTx: { type: "DEPOSIT", amount: 1000, currency: "USD" },
      },
      {
        externalId: "e69-4",
        portfolioName: "Transakcje",
        executedAt: "2024-01-15T10:00:00.000Z",
        portfolioTx: { portfolioId, type: "BUY", instrumentSymbol: "AAPL", quantity: 10, price: 100, currency: "USD" },
      },
    ]
    expect((await postTransactions(h, rows)).status).toBe(200)
    const again = await postTransactions(h, rows)
    expect(again.status).toBe(200)
    expect((await again.json()).skipped).toBe(2)
  })
})


describe("§72.13 — position dates come from the trade, not the import", () => {
  // Every one of the 269 positions in PROD opened on 2026-09-28, the import
  // date, while their first trades go back to 2019. The rebuild tests whether a
  // position was open yet to decide what it was worth on each day, so a lot that
  // "opened" in 2026 contributed nothing to every earlier snapshot: the whole
  // series was cash-only and only the final day included the position. That is
  // the Equate+ spike, and it is on every portfolio.
  it("stamps openedAt with the BUY's date, years before the import", async () => {
    const h = await boot()
    const { portfolioId } = await seedPortfolio(h)

    const res = await postTransactions(h, [buyRow(portfolioId)])
    expect(res.status).toBe(200)

    const [pos] = await h.db.select().from(positions).where(eq(positions.portfolioId, portfolioId))
    expect(pos.openedAt.toISOString()).toBe("2024-01-15T10:00:00.000Z")
  })

  it("keeps the EARLIEST date when a later BUY lands on the same lot", async () => {
    const h = await boot()
    const { portfolioId } = await seedPortfolio(h)

    // Out of order on purpose: rows can arrive shuffled, and the opening date is
    // what the historical rebuild anchors to.
    await postTransactions(h, [
      buyRow(portfolioId, { executedAt: "2024-06-01T10:00:00.000Z", quantity: 5 }),
      buyRow(portfolioId, { executedAt: "2024-01-15T10:00:00.000Z", quantity: 10 }),
    ])

    const rows = await h.db.select().from(positions).where(eq(positions.portfolioId, portfolioId))
    expect(rows).toHaveLength(1)
    expect(rows[0].openedAt.toISOString()).toBe("2024-01-15T10:00:00.000Z")
  })

  it("stamps closedAt with the SELL's date, not the import's", async () => {
    const h = await boot()
    const { portfolioId } = await seedPortfolio(h)

    await postTransactions(h, [buyRow(portfolioId, { executedAt: "2022-05-26T10:00:00.000Z" })])
    const sell = {
      externalId: `sell-${Math.random().toString(36).slice(2, 8)}`,
      portfolioName: "Transakcje",
      executedAt: "2022-09-26T10:00:00.000Z",
      portfolioTx: {
        portfolioId,
        type: "SELL",
        instrumentSymbol: "AAPL",
        assetType: "STOCK",
        quantity: 10,
        price: 120,
        currency: "USD",
      },
    }
    const res = await postTransactions(h, [sell])
    expect(res.status).toBe(200)

    const [pos] = await h.db.select().from(positions).where(eq(positions.portfolioId, portfolioId))
    expect(pos.isOpen).toBe(false)
    expect(pos.closedAt?.toISOString()).toBe("2022-09-26T10:00:00.000Z")
  })
})

describe("§72.8 — a resolved listing currency beats the payment currency", () => {
  // Crypto bought 0.004 BTC-USD for 690.64 PLN, and the import stored
  // instrument_currency=PLN — the currency it was PAID in. The history grid then
  // asked instruments for no conversion and multiplied a USD close into a PLN
  // total: 168.79 where it is 675.16 (§72.15). The two currencies legitimately
  // differ; only the listing one says what a price for the instrument means.
  it("stores the listing currency, not the payment currency", async () => {
    const h = await boot()
    const { portfolioId } = await seedPortfolio(h)

    const res = await postTransactions(h, [
      buyRow(portfolioId, { currency: "PLN", listingCurrency: "USD" }),
    ])
    expect(res.status).toBe(200)

    const [pos] = await h.db.select().from(positions).where(eq(positions.portfolioId, portfolioId))
    expect(pos.instrumentCurrency).toBe("USD")
  })

  it("falls back to the payment currency when the importer does not know", async () => {
    const h = await boot()
    const { portfolioId } = await seedPortfolio(h)

    await postTransactions(h, [buyRow(portfolioId, { currency: "PLN" })])
    const [pos] = await h.db.select().from(positions).where(eq(positions.portfolioId, portfolioId))
    expect(pos.instrumentCurrency).toBe("PLN")
  })

  it("rejects a listingCurrency that is not an ISO code rather than storing it", async () => {
    const h = await boot()
    const { portfolioId } = await seedPortfolio(h)

    const res = await postTransactions(h, [
      buyRow(portfolioId, { currency: "PLN", listingCurrency: "zloty" }),
    ])
    expect(res.status).toBe(422)
  })

  it("a GBP listing paid in PLN keeps both", async () => {
    // The CSN.L shape: a real broker trade in a GBP-listed stock settled in PLN.
    const h = await boot()
    const { portfolioId } = await seedPortfolio(h)

    await postTransactions(h, [
      buyRow(portfolioId, { currency: "PLN", listingCurrency: "GBP" }),
    ])
    const [tx] = await h.db
      .select()
      .from(portfolioTransactions)
      .where(eq(portfolioTransactions.portfolioId, portfolioId))
    const [pos] = await h.db.select().from(positions).where(eq(positions.portfolioId, portfolioId))
    expect(tx.currency).toBe("PLN")          // paid in PLN
    expect(tx.instrumentCurrency).toBe("GBP") // trades in GBP
    expect(pos.instrumentCurrency).toBe("GBP")
  })
})
