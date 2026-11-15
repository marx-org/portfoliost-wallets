import { describe, expect, it, beforeEach } from "vitest"
import { Hono } from "hono"
import { makeHarness, insertPosition } from "./test-utils.js"
import { createChartingRoutes } from "./charting.js"
import { buildChartFacts } from "../services/charting/projection.js"
import { portfolioCashTransactions, portfolioTransactions, portfolios } from "../db/schema.js"
import type { PriceBarSeries } from "../services/backfill.js"
import type { Harness } from "./test-utils.js"

function fakeFetcher(series: Record<string, { dates: string[]; closes: number[] }>) {
  return async (symbol: string): Promise<PriceBarSeries | null> => {
    const s = series[symbol]
    return s ? { symbol, dates: s.dates, closes: s.closes, stale: false } : null
  }
}

async function seed(h: Harness) {
  const [pf] = await h.db.insert(portfolios).values({ userId: h.user.id, name: "A", baseCurrency: "USD" }).returning({ id: portfolios.id })
  const pos = await insertPosition(h.db, { userId: h.user.id, symbol: "AAPL", portfolioId: pf.id })
  await h.db.insert(portfolioTransactions).values({ userId: h.user.id, portfolioId: pf.id, positionId: pos.id, type: "BUY", instrumentSymbol: "AAPL", assetType: "STOCK", quantity: "10", price: "100", currency: "USD", exchangeRate: "1", executedAt: new Date("2026-01-01T00:00:00Z") })
  await h.db.insert(portfolioTransactions).values({ userId: h.user.id, portfolioId: pf.id, positionId: pos.id, type: "DIVIDEND", instrumentSymbol: "AAPL", assetType: "STOCK", quantity: "10", price: "0.5", currency: "USD", exchangeRate: "1", executedAt: new Date("2026-01-02T00:00:00Z") })
  await h.db.insert(portfolioCashTransactions).values({ userId: h.user.id, portfolioId: pf.id, type: "DEPOSIT", amount: "1000", currency: "USD", exchangeRate: "1", transactionDate: "2026-01-01" })
  await buildChartFacts(h.db, pf.id, "token", { generation: 1, from: "2026-01-01", to: "2026-01-02", fetcher: fakeFetcher({ AAPL: { dates: ["2026-01-01", "2026-01-02"], closes: [100, 110] } }) })
  return pf.id
}

async function boot(h: Harness) {
  const app = new Hono()
  app.route("/api/portfolios/charting", createChartingRoutes(h.db))
  return app
}

beforeEach(async () => {})

describe("charting routes", () => {
  it("serves the income dataset for the resolved scope", async () => {
    const h = await makeHarness("user-1")
    await seed(h)
    const app = await boot(h)
    const res = await app.request("/api/portfolios/charting/income", { headers: h.headers })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { currency: string; coverage: { status: string; generation: number }; annual: unknown[] }
    expect(body.currency).toBe("USD")
    expect(body.coverage.generation).toBe(1)
    expect(body.coverage.status).toBe("complete")
    expect(body.annual.length).toBeGreaterThan(0)
  })

  it("serves the performance series", async () => {
    const h = await makeHarness("user-1")
    await seed(h)
    const app = await boot(h)
    const res = await app.request("/api/portfolios/charting/performance", { headers: h.headers })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { series: { date: string; value: number }[] }
    expect(body.series.length).toBe(2)
    expect(body.series[1].value).toBe(1100)
  })

  it("rejects a malformed account id with 422", async () => {
    const h = await makeHarness("user-1")
    await seed(h)
    const app = await boot(h)
    const res = await app.request("/api/portfolios/charting/income?accounts=not-a-uuid", { headers: h.headers })
    expect(res.status).toBe(422)
  })

  it("reports an empty scope rather than inventing data", async () => {
    const h = await makeHarness("user-1")
    const app = await boot(h)
    const res = await app.request("/api/portfolios/charting/income", { headers: h.headers })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { coverage: { status: string }; annual: unknown[] }
    expect(body.coverage.status === "empty" || body.coverage.status === "partial" || body.coverage.status === "complete").toBe(true)
    expect(body.annual).toEqual([])
  })
})
describe("stock category routes", () => {
  const jsonHeaders = (h: Harness) => ({ ...h.headers, "Content-Type": "application/json" })

  async function seedStock(h: Harness): Promise<string> {
    const [pf] = await h.db
      .insert(portfolios)
      .values({ userId: h.user.id, name: "A", baseCurrency: "USD" })
      .returning({ id: portfolios.id })
    await insertPosition(h.db, { userId: h.user.id, symbol: "AAPL", assetType: "STOCK", instrumentCurrency: "USD", portfolioId: pf.id })
    return pf.id
  }

  async function put(app: Hono, h: Harness, body: unknown) {
    return app.request("/api/portfolios/charting/stock-categories", {
      method: "PUT",
      headers: jsonHeaders(h),
      body: JSON.stringify(body),
    })
  }

  async function list(app: Hono, h: Harness, query = "") {
    const res = await app.request(`/api/portfolios/charting/stock-categories${query}`, { headers: h.headers })
    return { res, rows: (await res.json()) as Array<{ symbol: string; instrumentCurrency: string; category: string }> }
  }

  it("creates, lists and retains an assignment across reloads", async () => {
    const h = await makeHarness("user-1")
    await seedStock(h)
    const app = await boot(h)
    const created = await put(app, h, { symbol: "aapl", instrumentCurrency: "usd", category: "high_growth" })
    expect(created.status).toBe(200)
    expect(((await created.json()) as { symbol: string; category: string })).toMatchObject({ symbol: "AAPL", category: "high_growth" })

    const { res, rows } = await list(app, h)
    expect(res.status).toBe(200)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ symbol: "AAPL", instrumentCurrency: "USD", category: "high_growth" })
  })

  it("rejects an unknown category and leaves the previous value intact", async () => {
    const h = await makeHarness("user-1")
    await seedStock(h)
    const app = await boot(h)
    expect((await put(app, h, { symbol: "AAPL", instrumentCurrency: "USD", category: "balanced" })).status).toBe(200)

    const bad = await put(app, h, { symbol: "AAPL", instrumentCurrency: "USD", category: "growth" })
    expect(bad.status).toBe(422)

    const { rows } = await list(app, h)
    expect(rows).toHaveLength(1)
    expect(rows[0].category).toBe("balanced")
  })

  it("rejects a malformed identity", async () => {
    const h = await makeHarness("user-1")
    await seedStock(h)
    const app = await boot(h)
    expect((await put(app, h, { symbol: "AAPL", instrumentCurrency: "DOLLAR", category: "balanced" })).status).toBe(422)
    expect((await put(app, h, { symbol: "", instrumentCurrency: "USD", category: "balanced" })).status).toBe(422)
  })

  it("isolates assignments between users", async () => {
    const h1 = await makeHarness("user-1")
    await seedStock(h1)
    const app1 = await boot(h1)
    expect((await put(app1, h1, { symbol: "AAPL", instrumentCurrency: "USD", category: "high_yield" })).status).toBe(200)

    const h2 = await makeHarness("user-2")
    const app2 = await boot(h2)
    const { rows } = await list(app2, h2)
    expect(rows).toEqual([])
  })

  it("narrows the assignment list to the scoped account", async () => {
    const h = await makeHarness("user-1")
    const other = await h.db
      .insert(portfolios)
      .values({ userId: h.user.id, name: "B", baseCurrency: "USD" })
      .returning({ id: portfolios.id })
    const a = await seedStock(h)
    const app = await boot(h)
    await put(app, h, { symbol: "AAPL", instrumentCurrency: "USD", category: "balanced" })
    // A label/account that holds nothing narrows the list to empty, not All.
    const { rows } = await list(app, h, `?accounts=${other[0].id}`)
    expect(rows).toEqual([])
    const all = await list(app, h)
    expect(all.rows).toHaveLength(1)
    expect(a).toBeTruthy()
  })
})

describe("cumulative income route", () => {
  it("serves a cumulative dividends+interest series with an opening balance", async () => {
    const h = await makeHarness("user-1")
    await seed(h)
    const app = await boot(h)
    const res = await app.request("/api/portfolios/charting/income", { headers: h.headers })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      cumulative: Array<{ date: string; total: number; openingBalance: number }>
    }
    expect(body.cumulative.length).toBeGreaterThan(0)
    expect(body.cumulative[0].openingBalance).toBe(0)
    expect(typeof body.cumulative[body.cumulative.length - 1].total).toBe("number")
  })
})

describe("annual income route", () => {
  it("serves annual totals with a nullable year-over-year change", async () => {
    const h = await makeHarness("user-1")
    await seed(h)
    const app = await boot(h)
    const res = await app.request("/api/portfolios/charting/income", { headers: h.headers })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      annual: Array<{ year: number; total: number; yoyChangePercent: number | null }>
    }
    expect(body.annual.length).toBeGreaterThan(0)
    for (const row of body.annual) {
      expect(row.yoyChangePercent === null || typeof row.yoyChangePercent === "number").toBe(true)
    }
  })
})

describe("annual income equivalent route", () => {
  it("serves daily and monthly equivalents with 365/12 divisors", async () => {
    const h = await makeHarness("user-1")
    await seed(h)
    const app = await boot(h)
    const res = await app.request("/api/portfolios/charting/income", { headers: h.headers })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      dailyAverageByYear: Array<{ divisor: number; basis: string; amount: number; partial: boolean }>
      monthlyAverageByYear: Array<{ divisor: number; basis: string; amount: number }>
    }
    expect(body.dailyAverageByYear.length).toBeGreaterThan(0)
    expect(body.dailyAverageByYear[0]).toMatchObject({ divisor: 365, basis: "days" })
    expect(body.monthlyAverageByYear[0]).toMatchObject({ divisor: 12, basis: "months" })
  })
})
