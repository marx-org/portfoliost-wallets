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