import { afterEach, describe, expect, it, vi } from "vitest"
import { Hono } from "hono"
import { createPortfolioRoutes } from "./portfolios.js"
import { makeHarness } from "./test-utils.js"
import {
  portfolios,
  positions,
  portfolioTransactions,
  valueSnapshots,
} from "../db/schema.js"
import { sql } from "drizzle-orm"
import { __resetBackfillRunnerForTests } from "../services/backfill-runner.js"
import { mockInstrumentsFx, unmockInstrumentsFx } from "../test-fx-mock.js"
import { crossRate } from "@marx2/contracts/fx"

function app(db: Parameters<typeof makeHarness>[0] extends string ? never : Parameters<typeof createPortfolioRoutes>[0]) {
  const a = new Hono()
  a.route("/api/portfolios", createPortfolioRoutes(db))
  return a
}

describe("Portfolio CRUD (§15 Phase B)", () => {
  it("POST /api/portfolios — creates with baseCurrency", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    const res = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "Growth", baseCurrency: "USD" }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.name).toBe("Growth")
    expect(body.baseCurrency).toBe("USD")
    expect(body.strategy).toBe("GROWTH")
    expect(body.totalInvested).toBe(0)
    expect(body.id).toBeDefined()
  })

  it("POST /api/portfolios — invalid baseCurrency → 422", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    const res = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "No CCY", baseCurrency: "NOTACCY" }),
    })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBe("ValidationError")
  })

  it("POST /api/portfolios — removed wallet field (walletId) is ignored", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    const res = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({
        name: "P",
        currency: "USD",
        walletId: "00000000-0000-0000-0000-000000000000",
      }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.walletId).toBeUndefined()
  })

  it("GET /api/portfolios — lists only caller's portfolios", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    // Create two portfolios
    await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "A", currency: "USD" }),
    })
    await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "B", currency: "EUR" }),
    })

    const res = await a.request("/api/portfolios", { headers: h.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Array.isArray(body)).toBe(true)
    expect(body.length).toBe(2)
    // Check metrics shape
    expect(body[0].metrics).toBeDefined()
    expect(body[0].metrics.positionCount).toBe(0)
    expect(body[0].performance).toBeDefined()
  })

  it("GET /api/portfolios/light — returns lightweight list", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "Light", baseCurrency: "PLN" }),
    })

    const res = await a.request("/api/portfolios/light", { headers: h.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.length).toBe(1)
    expect(body[0].name).toBe("Light")
    expect(body[0].baseCurrency).toBe("PLN")
    expect(body[0].positionCount).toBe(0)
    expect(body[0].metrics).toBeUndefined() // light has no metrics
  })

  it("GET /api/portfolios/:id — detail with position summaries", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "Detail", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    // Insert a position + transaction
    await h.db.insert(positions).values({
      userId: h.user.id,
      portfolioId: portfolio.id,
      symbol: "AAPL",
      companyName: "Apple Inc",
      quantity: "10",
      averageCostBasis: "150",
      instrumentCurrency: "USD",
      sector: "Technology",
      country: "US",
    })
    await h.db.insert(portfolioTransactions).values({
      userId: h.user.id,
      portfolioId: portfolio.id,
      type: "BUY",
      instrumentSymbol: "AAPL",
      quantity: "10",
      price: "150",
      currency: "USD",
      totalAmount: "1500",
    })

    const res = await a.request(`/api/portfolios/${portfolio.id}`, {
      headers: h.headers,
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.name).toBe("Detail")
    expect(body.positions.length).toBe(1)
    expect(body.positions[0].symbol).toBe("AAPL")
    expect(body.positionCount).toBe(1)
    expect(body.metrics.positionCount).toBe(1)
    expect(body.metrics.openPositions).toBe(1)
  })

  it("GET /api/portfolios/:id — the read path does NOT call instruments (§72.6)", async () => {
    // Opening a portfolio used to await refreshQuotes, costing two instruments
    // calls per open position inside the request. Freshness now belongs to the
    // writers (the 13:00/17:20 syncs and every rebuild), and the route reports
    // what they last stored. A test that fails if the fetch comes back, because
    // "it is only one extra call" is how a read path grows a network dependency.
    const h = await makeHarness()
    const a = app(h.db)
    const created = await (
      await a.request("/api/portfolios", {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify({ name: "NoFetch", currency: "USD" }),
      })
    ).json()
    await h.db.insert(positions).values({
      userId: h.user.id,
      portfolioId: created.id,
      symbol: "AAPL",
      companyName: "Apple Inc",
      quantity: "10",
      averageCostBasis: "150",
      instrumentCurrency: "USD",
      // a stored price from an earlier writer, deliberately older than STALE_MS
      currentPrice: "181.20",
      marketValue: "1812.00",
      priceSource: "quote",
      priceAsOf: new Date("2026-09-20T09:00:00Z"),
    })

    const fetchSpy = vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })))
    vi.stubGlobal("fetch", fetchSpy)

    const res = await a.request(`/api/portfolios/${created.id}`, { headers: h.headers })
    expect(res.status).toBe(200)
    expect(fetchSpy, "portfolio open must not reach instruments").not.toHaveBeenCalled()

    // …and it still serves the last stored price, with its provenance, rather
    // than nulling the position because nothing was fetched.
    const [pos] = (await res.json()).positions
    expect(pos.marketValue).toBe(1812)
    expect(pos.currentPrice).toBe(181.2)
    vi.unstubAllGlobals()
  })

  it("GET /api/portfolios/:id — foreign portfolio → 404", async () => {
    const h = await makeHarness()
    const h2 = await makeHarness("user-2")
    const a = app(h.db)
    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "Secret", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    const a2 = app(h2.db)
    const res = await a2.request(`/api/portfolios/${portfolio.id}`, {
      headers: h2.headers,
    })
    expect(res.status).toBe(404)
  })

  it("PATCH /api/portfolios/:id — rename", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "Old", baseCurrency: "USD" }),
    })
    const portfolio = await createRes.json()

    const patchRes = await a.request(`/api/portfolios/${portfolio.id}`, {
      method: "PATCH",
      headers: h.headers,
      body: JSON.stringify({ name: "New" }),
    })
    expect(patchRes.status).toBe(200)
    const body = await patchRes.json()
    expect(body.name).toBe("New")
    expect(body.baseCurrency).toBe("USD") // unchanged
  })

  it("DELETE /api/portfolios/:id — empty portfolio → 204", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "Doomed", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    const delRes = await a.request(`/api/portfolios/${portfolio.id}`, {
      method: "DELETE",
      headers: h.headers,
    })
    expect(delRes.status).toBe(204)

    // Confirm gone
    const getRes = await a.request(`/api/portfolios/${portfolio.id}`, {
      headers: h.headers,
    })
    expect(getRes.status).toBe(404)
  })

  it("DELETE /api/portfolios/:id — with transactions → 409", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "HasTx", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    await h.db.insert(portfolioTransactions).values({
      userId: h.user.id,
      portfolioId: portfolio.id,
      type: "BUY",
      instrumentSymbol: "AAPL",
      quantity: "1",
      price: "100",
      currency: "USD",
      totalAmount: "100",
    })

    const delRes = await a.request(`/api/portfolios/${portfolio.id}`, {
      method: "DELETE",
      headers: h.headers,
    })
    expect(delRes.status).toBe(409)
    const body = await delRes.json()
    expect(body.message).toContain("transactions")
  })

  it("DELETE /api/portfolios/:id — with open positions → 409", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    const createRes = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "HasPos", currency: "USD" }),
    })
    const portfolio = await createRes.json()

    await h.db.insert(positions).values({
      userId: h.user.id,
      portfolioId: portfolio.id,
      symbol: "AAPL",
      quantity: "10",
      averageCostBasis: "150",
      instrumentCurrency: "USD",
    })

    const delRes = await a.request(`/api/portfolios/${portfolio.id}`, {
      method: "DELETE",
      headers: h.headers,
    })
    expect(delRes.status).toBe(409)
    const body = await delRes.json()
    expect(body.message).toContain("open positions")
  })

  it("multi-user isolation — user-b cannot see user-a's portfolios", async () => {
    const h = await makeHarness("user-a")
    const h2 = await makeHarness("user-b")
    const a = app(h.db)
    const a2 = app(h2.db)

    await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "A's", currency: "USD" }),
    })

    const res = await a2.request("/api/portfolios", { headers: h2.headers })
    const body = await res.json()
    expect(body.length).toBe(0)
  })
})

describe("GET /api/portfolios/:id/news (N6)", () => {
  it("returns the fan-out NewsArticleList shape with empty holdings", async () => {
    const hh = await makeHarness()
    const a = app(hh.db)
    const create = await a.request("/api/portfolios", {
      method: "POST",
      headers: hh.headers,
      body: JSON.stringify({ name: "Growth", currency: "USD" }),
    })
    const portfolio = await create.json()

    const res = await a.request(`/api/portfolios/${portfolio.id}/news`, { headers: hh.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      data: [],
      pagination: {
        count: 0,
        total_count: 0,
        has_next_page: false,
        has_previous_page: false,
        next_cursor: null,
        previous_cursor: null,
      },
    })
  })
})

describe("GET /api/portfolios/merged (§46, §41 follow-up 1)", () => {
  afterEach(() => unmockInstrumentsFx())

  async function seedPfWithSnapshots(
    h: Awaited<ReturnType<typeof makeHarness>>,
    name: string,
    baseCurrency: string,
    snapshots: Array<{ snapshotDate: string; value: string; invested: string }>,
  ) {
    const [pf] = await h.db
      .insert(portfolios)
      .values({ userId: h.user.id, name, baseCurrency })
      .returning()
    for (const s of snapshots) {
      await h.db.insert(valueSnapshots).values({
        portfolioId: pf.id,
        snapshotDate: s.snapshotDate,
        value: s.value,
        invested: s.invested,
        netFlow: "0",
      })
    }
    return pf
  }

  /**
   * §68.4 — the merged series must be denominated in the SAME aggregate base that
   * /total-metrics reports. It used to hardcode "USD" in two places, which was
   * only ever consistent because /total-metrics hardcoded "USD" too; §68.3 made
   * /total-metrics report the real base, so a hardcoded target here would have
   * left the chart converting from a currency its numbers were not in.
   *
   * The base is made deterministically PLN (two PLN portfolios to one USD) and the
   * expected values are computed with the SAME `crossRate` helper the FX mock
   * uses, so this test cannot encode a wrong rate convention of its own.
   */
  it("sums mixed-currency portfolios into the dashboard's aggregate base, not a hardcoded USD", async () => {
    const h = await makeHarness("merged-base")
    const a = app(h.db)
    // EUR-quoted table: USD = 1.08 EUR, PLN = 4.3 EUR
    mockInstrumentsFx({ table: { USD: 1.08, PLN: 4.3 }, asOf: "2026-09-18" })
    try {
      await seedPfWithSnapshots(h, "USD pf", "USD", [
        { snapshotDate: "2026-09-01", value: "1000", invested: "800" },
        { snapshotDate: "2026-09-02", value: "1100", invested: "800" },
      ])
      await seedPfWithSnapshots(h, "PLN pf A", "PLN", [
        { snapshotDate: "2026-09-01", value: "4300", invested: "4000" },
        { snapshotDate: "2026-09-02", value: "4400", invested: "4000" },
      ])
      await seedPfWithSnapshots(h, "PLN pf B", "PLN", [
        { snapshotDate: "2026-09-01", value: "2150", invested: "2000" },
        { snapshotDate: "2026-09-02", value: "2200", invested: "2000" },
      ])

      const metrics = await (await a.request("/api/portfolios/total-metrics", { headers: h.headers })).json()
      // two PLN portfolios beat one USD, so the honest aggregate base is PLN
      expect(metrics.baseCurrency).toBe("PLN")

      const res = await a.request("/api/portfolios/merged?timeframe=ALL", { headers: h.headers })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.backfillStatus).toBe("complete")
      expect(body.performance.timeSeries).toHaveLength(2)

      const usdToPln = crossRate("USD", "PLN", { EUR: 1, USD: 1.08, PLN: 4.3 })
      if (usdToPln == null) throw new Error("test table cannot resolve USD>PLN")
      // last point, converted INTO the reported base:
      //  1100 USD x usdToPln  +  4400 PLN  +  2200 PLN
      const expected = 1100 * usdToPln + 4400 + 2200
      const last = body.performance.timeSeries[1]
      expect(last.value).toBeCloseTo(expected, 6)
      expect(body.performance.totalValue).toBeCloseTo(expected, 6)
      expect(body.performance.totalInvested).toBeCloseTo(800 * usdToPln + 4000 + 2000, 6)

      // and explicitly NOT the answer a hardcoded "USD" target would have produced
      const intoUsd = 1100 + 4400 * crossRate("PLN", "USD", { EUR: 1, USD: 1.08, PLN: 4.3 })! + 2200 * crossRate("PLN", "USD", { EUR: 1, USD: 1.08, PLN: 4.3 })!
      expect(last.value).not.toBeCloseTo(intoUsd, 2)
      expect(body.performance.monthlyReturns).toEqual([])
      expect(body.benchmarks).toEqual([])
    } finally {
      unmockInstrumentsFx()
    }
  })

  it("is served by the static route — not captured by GET /:id", async () => {
    const h = await makeHarness("merged-not-id")
    const a = app(h.db)
    await seedPfWithSnapshots(h, "Only pf", "USD", [
      { snapshotDate: "2026-09-01", value: "500", invested: "400" },
      { snapshotDate: "2026-09-02", value: "600", invested: "400" },
    ])

    const res = await a.request("/api/portfolios/merged", { headers: h.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    // Analytics-shaped body, NOT a single-portfolio detail (404 for id "merged").
    expect(body.performance).toBeDefined()
    expect(body.performance.timeSeries).toHaveLength(2)
    expect(body.backfillStatus).toBe("complete")
    expect(body.benchmarks).toEqual([])
  })

  it("returns pending + fires backfill when any portfolio has < 2 snapshots and backfillable history", async () => {
    const h = await makeHarness("merged-pending")
    const a = app(h.db)
    // Two snapshots — has series.
    await seedPfWithSnapshots(h, "Ready pf", "USD", [
      { snapshotDate: "2026-09-01", value: "500", invested: "400" },
      { snapshotDate: "2026-09-02", value: "600", invested: "400" },
    ])
    // No snapshots + a BUY from before yesterday — backfillable, must keep
    // the merged series pending.
    const empty = await seedPfWithSnapshots(h, "Empty pf", "USD", [])
    await h.db.insert(portfolioTransactions).values({
      userId: h.user.id,
      portfolioId: empty.id,
      type: "BUY",
      instrumentSymbol: "AAPL",
      quantity: "1",
      price: "150",
      currency: "USD",
      totalAmount: "150",
      executedAt: new Date("2026-09-01T12:00:00Z"),
    })

    const res = await a.request("/api/portfolios/merged", { headers: h.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.backfillStatus).toBe("pending")
    expect(body.performance.timeSeries).toEqual([])
    expect(body.benchmarks).toEqual([])

    // Clean up: the fire-and-forget enqueue must not leak into other tests.
    __resetBackfillRunnerForTests()
  })

  it("does not go pending for a portfolio whose only trades are from today (§48.4)", async () => {
    const h = await makeHarness("merged-sameday")
    const a = app(h.db)
    await seedPfWithSnapshots(h, "Ready pf", "USD", [
      { snapshotDate: "2026-09-01", value: "500", invested: "400" },
      { snapshotDate: "2026-09-02", value: "600", invested: "400" },
    ])
    // No snapshots, but the only trade executed today — the backfill window
    // [firstTxDate, yesterday] is empty, so this portfolio is complete (empty
    // history), not pending: it must not poison the merged series.
    const sameDay = await seedPfWithSnapshots(h, "Same-day pf", "USD", [])
    await h.db.insert(portfolioTransactions).values({
      userId: h.user.id,
      portfolioId: sameDay.id,
      type: "BUY",
      instrumentSymbol: "AAPL",
      quantity: "1",
      price: "150",
      currency: "USD",
      totalAmount: "150",
      executedAt: new Date(),
    })

    const res = await a.request("/api/portfolios/merged", { headers: h.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.backfillStatus).toBe("complete")
    expect(body.performance.timeSeries).toHaveLength(2)

    // The same-day portfolio's own analytics is complete-with-empty, not pending.
    const own = await a.request(`/api/portfolios/${sameDay.id}/analytics?timeframe=1Y`, { headers: h.headers })
    expect(own.status).toBe(200)
    const ownBody = await own.json()
    expect(ownBody.backfillStatus).toBe("complete")
    expect(ownBody.performance.timeSeries).toEqual([])

    __resetBackfillRunnerForTests()
  })
})
