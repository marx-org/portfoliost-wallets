import { describe, expect, it, beforeEach } from "vitest"
import { Hono } from "hono"
import { eq } from "drizzle-orm"
import { makeHarness, insertPosition } from "./test-utils.js"
import { createChartingRoutes } from "./charting.js"
import { buildChartFacts } from "../services/charting/projection.js"
import { chartProjectionState, labels, portfolioCashTransactions, portfolioTransactions, portfolios, positionLabels } from "../db/schema.js"
import type { PriceBarSeries } from "../services/backfill.js"
import type { Harness } from "./test-utils.js"

function fakeFetcher(series: Record<string, { dates: string[]; closes: number[] }>) {
  return async (symbol: string): Promise<PriceBarSeries | null> => {
    const s = series[symbol]
    return s ? { symbol, dates: s.dates, closes: s.closes, stale: false } : null
  }
}

async function seed(h: Harness, name = "A", generation = 1, symbol = "AAPL", closes: number[] = [100, 110]) {
  const [pf] = await h.db.insert(portfolios).values({ userId: h.user.id, name, baseCurrency: "USD" }).returning({ id: portfolios.id })
  const pos = await insertPosition(h.db, { userId: h.user.id, symbol, portfolioId: pf.id })
  await h.db.insert(portfolioTransactions).values({ userId: h.user.id, portfolioId: pf.id, positionId: pos.id, type: "BUY", instrumentSymbol: symbol, assetType: "STOCK", quantity: "10", price: "100", currency: "USD", exchangeRate: "1", executedAt: new Date("2026-01-01T00:00:00Z") })
  await h.db.insert(portfolioTransactions).values({ userId: h.user.id, portfolioId: pf.id, positionId: pos.id, type: "DIVIDEND", instrumentSymbol: symbol, assetType: "STOCK", quantity: "10", price: "0.5", currency: "USD", exchangeRate: "1", executedAt: new Date("2026-01-02T00:00:00Z") })
  await h.db.insert(portfolioCashTransactions).values({ userId: h.user.id, portfolioId: pf.id, type: "DEPOSIT", amount: "1000", currency: "USD", exchangeRate: "1", transactionDate: "2026-01-01" })
  await buildChartFacts(h.db, pf.id, "token", { generation, from: "2026-01-01", to: "2026-01-02", fetcher: fakeFetcher({ [symbol]: { dates: ["2026-01-01", "2026-01-02"], closes } }) })
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

  it("serves cost basis vs market value per label", async () => {
    const h = await makeHarness("user-1")
    const [pf] = await h.db.insert(portfolios).values({ userId: h.user.id, name: "A", baseCurrency: "USD" }).returning({ id: portfolios.id })
    const pos = await insertPosition(h.db, { userId: h.user.id, symbol: "AAPL", portfolioId: pf.id })
    await h.db.insert(portfolioTransactions).values({ userId: h.user.id, portfolioId: pf.id, positionId: pos.id, type: "BUY", instrumentSymbol: "AAPL", assetType: "STOCK", quantity: "10", price: "100", currency: "USD", exchangeRate: "1", executedAt: new Date("2026-01-01T00:00:00Z") })
    await buildChartFacts(h.db, pf.id, "token", { generation: 1, from: "2026-01-01", to: "2026-01-01", fetcher: fakeFetcher({ AAPL: { dates: ["2026-01-01"], closes: [110] } }) })
    const [label] = await h.db.insert(labels).values({ userId: h.user.id, name: "Core", color: "#112233" }).returning({ id: labels.id })
    await h.db.insert(positionLabels).values({ positionId: pos.id, labelId: label.id })

    const app = await boot(h)
    const res = await app.request("/api/portfolios/charting/allocation", { headers: h.headers })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      byCostBasis: Array<{ key: string; label: string; costBasis: number; value: number }>
    }
    expect(body.byCostBasis).toEqual([{ key: label.id, label: "Core", costBasis: 1000, value: 1100, percentCost: null, percentValue: null, unknown: false }])

    // Selecting the label keeps the group; selecting an unowned label empties it.
    const kept = (await (await app.request(`/api/portfolios/charting/allocation?labels=${label.id}`, { headers: h.headers })).json()) as {
      byCostBasis: unknown[]
    }
    expect(kept.byCostBasis).toHaveLength(1)
    const other = await h.db.insert(labels).values({ userId: h.user.id, name: "Other", color: "#445566" }).returning({ id: labels.id })
    const filtered = (await (await app.request(`/api/portfolios/charting/allocation?labels=${other[0].id}`, { headers: h.headers })).json()) as {
      byCostBasis: unknown[]
    }
    expect(filtered.byCostBasis).toEqual([])
  })

  it("serves monthly payer coverage for current holdings", async () => {
    const h = await makeHarness("user-1")
    await seed(h)
    const app = await boot(h)
    const res = await app.request("/api/portfolios/charting/income", { headers: h.headers })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      payerCoverage: Array<{ year: number; month: number; count: number; partial: boolean }>
    }
    const jan = body.payerCoverage.find((m) => m.year === 2026 && m.month === 1)
    expect(jan?.count).toBe(1)
    // The current month and later are partial, never a full-year forecast.
    const now = new Date()
    const current = body.payerCoverage.find((m) => m.year === now.getUTCFullYear() && m.month === now.getUTCMonth() + 1)
    if (current) expect(current.partial).toBe(true)
  })

  it("serves the holdings composition with positions and a cash slice", async () => {
    const h = await makeHarness("user-1")
    await seed(h)
    const app = await boot(h)
    const res = await app.request("/api/portfolios/charting/allocation", { headers: h.headers })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      positions: Array<{ key: string; label: string; value: number; unknown: boolean }>
    }
    const stock = body.positions.find((p) => p.key.startsWith("STOCK|"))
    expect(stock?.value).toBe(1100)
    // The seed's ledger yields a cash balance; the composition exposes it as a
    // signed CASH slice rather than silently dropping cash.
    const cash = body.positions.find((p) => p.key === "CASH")
    expect(cash, JSON.stringify(body.positions)).toBeTruthy()
    expect(typeof cash!.value).toBe("number")
  })

  it("echoes requested benchmarks and returns a (possibly empty) benchmark list", async () => {
    const h = await makeHarness("user-1")
    await seed(h)
    const app = await boot(h)
    const res = await app.request("/api/portfolios/charting/performance?benchmarks=SPY,QQQ", { headers: h.headers })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      scope: { benchmarks?: string[] }
      benchmarks: Array<{ symbol: string; absoluteTimeSeries: Array<{ date: string; value: number }> }>
    }
    expect(body.scope.benchmarks).toEqual(["SPY", "QQQ"])
    expect(Array.isArray(body.benchmarks)).toBe(true)
  })

  it("serves the profit/value scatter with profit decomposition", async () => {
    const h = await makeHarness("user-1")
    await seed(h)
    const app = await boot(h)
    const res = await app.request("/api/portfolios/charting/performance", { headers: h.headers })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      scatter: Array<{
        symbol: string
        assetType: string | null
        accounts: string[]
        marketValue: number
        totalProfit: number
        realized: number | null
        unrealized: number | null
        dividends: number | null
      }>
    }
    const point = body.scatter.find((p) => p.symbol.startsWith("STOCK|AAPL|"))
    expect(point, JSON.stringify(body.scatter)).toBeTruthy()
    expect(point!.marketValue).toBe(1100)
    expect(point!.accounts.length).toBeGreaterThan(0)
    // profit = realized + unrealized + dividends
    expect(point!.totalProfit).toBeCloseTo(
      (point!.realized ?? 0) + (point!.unrealized ?? 0) + (point!.dividends ?? 0),
      4,
    )
  })

  it("serves per-account cash balance series plus a combined total", async () => {
    const h = await makeHarness("user-1")
    const pf = await seed(h)
    const app = await boot(h)
    const res = await app.request(`/api/portfolios/charting/cash?accounts=${pf}`, { headers: h.headers })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      balanceHistory: Array<{ date: string; balance: number }>
      series: Array<{ key: string; label: string; points: Array<{ date: string; balance: number }> }>
    }
    expect(body.series.length).toBeGreaterThanOrEqual(2)
    expect(body.series.at(-1)?.label).toBe("Total")
    expect(body.balanceHistory).toEqual(body.series.at(-1)?.points)
    expect(body.balanceHistory.length).toBeGreaterThan(0)
  })

  it("rejects a malformed account id with 422", async () => {
    const h = await makeHarness("user-1")
    await seed(h)
    const app = await boot(h)
    const res = await app.request("/api/portfolios/charting/income?accounts=not-a-uuid", { headers: h.headers })
    expect(res.status).toBe(422)
  })

  it("keeps the projected account's data when another scoped account has no projection", async () => {
    const h = await makeHarness("user-1")
    const projected = await seed(h, "Top10", 1)
    await h.db.insert(portfolios).values({ userId: h.user.id, name: "Fresh", baseCurrency: "USD" })
    const app = await boot(h)

    const allRes = await app.request("/api/portfolios/charting/income", { headers: h.headers })
    const all = (await allRes.json()) as {
      coverage: { status: string; generation: number; stale: boolean; missing: Array<{ reason: string; detail?: string }> }
      annual: unknown[]
      monthly: unknown[]
      dailyAverageByYear: unknown[]
    }
    expect(all.coverage.status).toBe("partial")
    expect(all.coverage.generation).toBe(1)
    expect(all.coverage.missing).toEqual([{ reason: "not_projected", detail: "Fresh" }])
    // The unprojected account must not empty the scope: the All-scope dataset is
    // exactly the dataset the projected account alone returns (#95).
    const onlyRes = await app.request(`/api/portfolios/charting/income?accounts=${projected}`, { headers: h.headers })
    const only = (await onlyRes.json()) as { annual: unknown[]; monthly: unknown[]; dailyAverageByYear: unknown[] }
    expect(all.annual).toEqual(only.annual)
    expect(all.monthly).toEqual(only.monthly)
    expect(all.dailyAverageByYear).toEqual(only.dailyAverageByYear)

    const perf = (await (await app.request("/api/portfolios/charting/performance", { headers: h.headers })).json()) as {
      series: { date: string; value: number }[]
      coverage: { status: string }
    }
    expect(perf.series).toHaveLength(2)
    expect(perf.series[1].value).toBe(1100)
    expect(perf.coverage.status).toBe("partial")

    const alloc = (await (await app.request("/api/portfolios/charting/allocation", { headers: h.headers })).json()) as {
      byAssetType: Array<{ key: string; value: number }>
    }
    expect(alloc.byAssetType).toHaveLength(1)
    expect(alloc.byAssetType[0].value).toBe(1100)

    const cash = (await (await app.request("/api/portfolios/charting/cash", { headers: h.headers })).json()) as {
      annualContributions: Array<{ year: number; contributions: number }>
    }
    expect(cash.annualContributions).toEqual([{ year: 2026, contributions: 1000, withdrawals: 0, net: 1000, partial: false }])
  })

  it("sums accounts published at different generations", async () => {
    const h = await makeHarness("user-1")
    await seed(h, "A", 1)
    await seed(h, "B", 2, "MSFT", [50, 60])
    const app = await boot(h)

    const body = (await (await app.request("/api/portfolios/charting/income", { headers: h.headers })).json()) as {
      coverage: { status: string; generation: number; missing: unknown[] }
      annual: Array<{ total: number }>
    }
    expect(body.coverage.status).toBe("complete")
    expect(body.coverage.generation).toBe(2)
    expect(body.coverage.missing).toEqual([])
    // 5 + 5 received income across the two accounts, not the 5 the min() scope saw.
    expect(body.annual).toHaveLength(1)
    expect(body.annual[0].total).toBe(10)

    const perf = (await (await app.request("/api/portfolios/charting/performance", { headers: h.headers })).json()) as {
      series: { date: string; value: number }[]
    }
    expect(perf.series[1].value).toBe(1700)
  })

  it("marks a scope stale when the published facts are flagged dirty", async () => {
    const h = await makeHarness("user-1")
    const pf = await seed(h, "A", 1)
    await h.db.update(chartProjectionState).set({ status: "stale" }).where(eq(chartProjectionState.portfolioId, pf))
    const app = await boot(h)
    const res = await app.request("/api/portfolios/charting/income", { headers: h.headers })
    const body = (await res.json()) as { coverage: { status: string; stale: boolean; generation: number }; annual: unknown[] }
    expect(body.coverage.status).toBe("stale")
    expect(body.coverage.stale).toBe(true)
    expect(body.coverage.generation).toBe(1)
    // The last published generation is still served, just flagged as stale.
    expect(body.annual.length).toBeGreaterThan(0)
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
