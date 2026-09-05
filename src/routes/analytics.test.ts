/** analytics.test.ts (D48/D50) — benchmark overlay on GET /:id/analytics */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Hono } from "hono"
import { createPortfolioRoutes } from "./portfolios.js"
import { makeHarness } from "./test-utils.js"
import { portfolios, portfolioTransactions, valueSnapshots } from "../db/schema.js"
import { calendarDays } from "../services/backfill.js"

function app(db: Parameters<typeof createPortfolioRoutes>[0]) {
  const a = new Hono()
  a.route("/api/portfolios", createPortfolioRoutes(db))
  return a
}

async function seedPortfolio(db: Awaited<ReturnType<typeof makeHarness>>["db"], userId: string) {
  const [pf] = await db
    .insert(portfolios)
    .values({ userId, name: "Analytics PF", currency: "USD", baseCurrency: "USD" })
    .returning()
  return pf
}

async function seedSnapshots(
  db: Awaited<ReturnType<typeof makeHarness>>["db"],
  portfolioId: string,
  dates: string[],
) {
  for (const d of dates) {
    await db.insert(valueSnapshots).values({
      portfolioId,
      snapshotDate: d,
      value: "1000",
      invested: "900",
      netFlow: "0",
    })
  }
}

async function seedBuy(
  db: Awaited<ReturnType<typeof makeHarness>>["db"],
  userId: string,
  portfolioId: string,
  qty: number,
  price: number,
  date: string,
  totalAmount?: number,
) {
  await db.insert(portfolioTransactions).values({
    userId,
    portfolioId,
    type: "BUY",
    instrumentSymbol: "SPY",
    quantity: String(qty),
    price: String(price),
    currency: "USD",
    instrumentCurrency: "USD",
    totalAmount: String(totalAmount ?? qty * price),
    executedAt: new Date(`${date}T12:00:00Z`),
  })
}

function mockPriceBars(series: Record<string, { dates: string[]; closes: number[] }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string, init?: { headers?: Record<string, string> }) => {
      const sym = decodeURIComponent(String(url).match(/\/instruments\/([^/]+)\/price-bars/)?.[1] ?? "")
      void init
      const data = series[sym]
      if (!data) return Promise.resolve({ ok: false, json: async () => ({}) })
      return Promise.resolve({
        ok: true,
        json: async () => ({ symbol: sym, dates: data.dates, closes: data.closes, stale: false }),
      })
    }),
  )
}

describe("GET /:id/analytics — benchmarks (D46/D48)", () => {
  beforeEach(() => { process.env.INSTRUMENTS_URL = "http://instruments:3000" })
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.INSTRUMENTS_URL })

  it("returns benchmarks: [] when no benchmarks param", async () => {
    const { db, user, headers } = await makeHarness("abe-no-param")
    const a = app(db)
    const pf = await seedPortfolio(db, user.id)
    await seedSnapshots(db, pf.id, calendarDays("2026-07-01", "2026-07-03"))

    const res = await a.request(`/api/portfolios/${pf.id}/analytics?timeframe=1Y`, { headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.benchmarks).toEqual([])
  })

  it("normalizes a requested benchmark to an indexed line starting at 100", async () => {
    const { db, user, headers } = await makeHarness("abe-spy")
    const a = app(db)
    const pf = await seedPortfolio(db, user.id)
    const days = calendarDays("2026-07-01", "2026-07-05")
    await seedSnapshots(db, pf.id, days)
    mockPriceBars({ SPY: { dates: days, closes: days.map((_, i) => 100 + i * 10) } }) // 100..140

    const res = await a.request(`/api/portfolios/${pf.id}/analytics?timeframe=1Y&benchmarks=SPY`, { headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.benchmarks).toHaveLength(1)
    const b = body.benchmarks[0]
    expect(b.symbol).toBe("SPY")
    expect(b.timeSeries[0].value).toBe(100)               // normalized start
    expect(b.timeSeries[b.timeSeries.length - 1].value).toBe(140) // 140/100×100
    expect(b.returnPercent).toBe(40)                       // (140/100−1)×100
    expect(b.timeSeries).toHaveLength(5)
  })

  it("drops unknown tickers and still returns portfolio series", async () => {
    const { db, user, headers } = await makeHarness("abe-unknown")
    const a = app(db)
    const pf = await seedPortfolio(db, user.id)
    const days = calendarDays("2026-07-01", "2026-07-02")
    await seedSnapshots(db, pf.id, days)
    mockPriceBars({}) // no ticker resolvable

    const res = await a.request(`/api/portfolios/${pf.id}/analytics?benchmarks=NOPE`, { headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.benchmarks).toEqual([])
    expect(body.performance.timeSeries.length).toBe(2)
  })

  it("accepts benchmarkCalcType param without error", async () => {
    const { db, user, headers } = await makeHarness("abe-calc")
    const a = app(db)
    const pf = await seedPortfolio(db, user.id)
    const days = calendarDays("2026-07-01", "2026-07-03")
    await seedSnapshots(db, pf.id, days)
    mockPriceBars({ QQQ: { dates: days, closes: days.map((_, i) => 200 - i * 10) } })

    const res = await a.request(
      `/api/portfolios/${pf.id}/analytics?benchmarks=QQQ&benchmarkCalcType=moneyWeighted`,
      { headers },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.benchmarks).toHaveLength(1)
    expect(body.benchmarks[0].symbol).toBe("QQQ")
  })

  it("mirrors a mid-window BUY into the benchmark (D50)", async () => {
    const { db, user, headers } = await makeHarness("abe-mirror")
    const a = app(db)
    const pf = await seedPortfolio(db, user.id)
    const days = calendarDays("2026-07-01", "2026-07-05")
    await seedSnapshots(db, pf.id, days)
    // A $1500 BUY on 2026-07-04 (SPY close 130) — seeded with invested=900.
    await seedBuy(db, user.id, pf.id, 10, 150, "2026-07-04", 1500)
    mockPriceBars({ SPY: { dates: days, closes: days.map((_, i) => 100 + i * 10) } }) // 100..140

    const res = await a.request(`/api/portfolios/${pf.id}/analytics?timeframe=1Y&benchmarks=SPY`, { headers })
    expect(res.status).toBe(200)
    const body = await res.json()

    // Pure price index would be 140; mirroring the $1500 BUY dilutes the
    // indexed TWR line because capital was deployed at 130, not at 100.
    const b = body.benchmarks[0]
    expect(b.timeSeries[0].value).toBe(100)
    expect(b.timeSeries[b.timeSeries.length - 1].value).toBeCloseTo(133.74, 1)
    expect(b.returnPercent).toBeCloseTo(33.74, 1)
  })

  it("returns portfolio series unaffected by benchmark mirroring", async () => {
    const { db, user, headers } = await makeHarness("abe-mirror2")
    const a = app(db)
    const pf = await seedPortfolio(db, user.id)
    const days = calendarDays("2026-07-01", "2026-07-04")
    await seedSnapshots(db, pf.id, days)
    await seedBuy(db, user.id, pf.id, 5, 100, "2026-07-02", 500)
    mockPriceBars({ GOOGL: { dates: days, closes: days.map((_, i) => 100 + i * 5) } })

    const res = await a.request(`/api/portfolios/${pf.id}/analytics?timeframe=1Y&benchmarks=GOOGL&benchmarkCalcType=simple`, { headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.performance.timeSeries).toHaveLength(4)
    expect(body.benchmarks).toHaveLength(1)
  })

  it("computes monthly returns as flow-adjusted TWR month-over-month (D50)", async () => {
    const { db, user, headers } = await makeHarness("abe-monthly-twrs")
    const a = app(db)
    const pf = await seedPortfolio(db, user.id)
    // July: 100 -> 102 (+2%). August starts flat (twr 102) while a $50k
    // deposit balloons the raw value to 52000; the twr stays flat (102) and
    // only the final move (+2%) shows in August.
    const rows = [
      { d: "2026-07-01", value: 1000, twr: "100" },
      { d: "2026-07-31", value: 1020, twr: "102" },
      { d: "2026-08-15", value: 52000, twr: "102" },
      { d: "2026-08-31", value: 53040, twr: "104.04" },
    ]
    for (const r of rows) {
      await db.insert(valueSnapshots).values({
        portfolioId: pf.id,
        snapshotDate: r.d,
        value: r.value,
        invested: "1000",
        netFlow: "0",
        cumulativeTwr: r.twr,
      })
    }
    await seedBuy(db, user.id, pf.id, 1, 50000, "2026-08-02", 50000)

    const res = await a.request(`/api/portfolios/${pf.id}/analytics?timeframe=1Y`, { headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.performance.monthlyReturns).toEqual([
      { month: "2026-07", returnPercent: 2 },
      { month: "2026-08", returnPercent: 2 },
    ])
  })
})
