import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Hono } from "hono"
import { createPortfolioRoutes } from "./portfolios.js"
import { makeHarness, insertPosition } from "./test-utils.js"
import {
  portfolios,
  positions,
  portfolioCashTransactions,
  portfolioTransactions,
  valueSnapshots,
  labels,
  positionLabels,
} from "../db/schema.js"
import { sql } from "drizzle-orm"
import { __resetBackfillRunnerForTests, __backfillRunnerEnqueuedForTests } from "../services/backfill-runner.js"
import { mockInstrumentsFx, unmockInstrumentsFx } from "../test-fx-mock.js"
import { crossRate } from "@marx-org/contracts/fx"

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
    expect(body.capitalBasis).toBe(0)
    expect(body.id).toBeDefined()
  })

  it("POST /api/portfolios — virtual portfolios require and persist an owned label", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    const labelId = "11111111-1111-4111-8111-111111111111"
    await h.db.insert(labels).values({ id: labelId, userId: "user-1", name: "Growth", color: "#000000" })

    const missing = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "Missing label", isVirtual: true, baseCurrency: "USD" }),
    })
    expect(missing.status).toBe(422)

    const res = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "Virtual Growth", isVirtual: true, labelId, cashLegOnTrade: true, baseCurrency: "USD" }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.isVirtual).toBe(true)
    expect(body.labelId).toBe(labelId)
    expect(body.cashLegOnTrade).toBe(false)
  })

  it("POST /api/portfolios — rejects a virtual portfolio carrying another user's label", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    const foreignLabel = "88888888-8888-4888-8888-888888888888"
    // Owned by user-2, but the request is authenticated as user-1.
    await h.db.insert(labels).values({ id: foreignLabel, userId: "user-2", name: "Foreign", color: "#000000" })

    const res = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "Virtual foreign", isVirtual: true, labelId: foreignLabel, baseCurrency: "USD" }),
    })
    expect(res.status).toBe(422)

    // The rejected create inserted nothing.
    const list = await (await a.request("/api/portfolios", { headers: h.headers })).json()
    expect(list).toEqual([])
  })

  it("virtual portfolios select labelled positions and existing transactions read-only", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    const labelId = "22222222-2222-4222-8222-222222222222"
    await h.db.insert(labels).values({ id: labelId, userId: "user-1", name: "Virtual", color: "#000000" })
    const sourceResponse = await a.request("/api/portfolios", {
      method: "POST", headers: h.headers, body: JSON.stringify({ name: "Source", baseCurrency: "USD" }),
    })
    const source = await sourceResponse.json()
    const virtualResponse = await a.request("/api/portfolios", {
      method: "POST", headers: h.headers, body: JSON.stringify({ name: "Virtual", isVirtual: true, labelId, baseCurrency: "USD" }),
    })
    const virtual = await virtualResponse.json()
    const position = await insertPosition(h.db, {
      userId: h.user.id, portfolioId: source.id, symbol: "AAPL", quantity: "2", averageCostBasis: "100", instrumentCurrency: "USD",
    })
    await h.db.insert(positionLabels).values({ positionId: position.id, labelId })
    await h.db.insert(portfolioTransactions).values({
      userId: h.user.id, portfolioId: source.id, positionId: position.id, type: "BUY", instrumentSymbol: "AAPL",
      quantity: "2", price: "100", currency: "USD", totalAmount: "200",
    })

    const positionsRes = await a.request(`/api/portfolios/${virtual.id}/positions`, { headers: h.headers })
    expect(positionsRes.status).toBe(200)
    expect((await positionsRes.json()).map((row: { symbol: string }) => row.symbol)).toEqual(["AAPL"])
    const transactionsRes = await a.request(`/api/portfolios/${virtual.id}/transactions`, { headers: h.headers })
    expect(transactionsRes.status).toBe(200)
    expect((await transactionsRes.json()).total).toBe(1)
    const write = await a.request(`/api/portfolios/${virtual.id}/transactions`, { method: "POST", headers: h.headers, body: "{}" })
    expect(write.status).toBe(409)
  })

  it("PATCH /api/portfolios/:id — virtual portfolio cannot enable the cash leg", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    const labelId = "33333333-3333-4333-8333-333333333333"
    await h.db.insert(labels).values({ id: labelId, userId: "user-1", name: "Virtual", color: "#000000" })
    const virtual = await (
      await a.request("/api/portfolios", {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify({ name: "Virtual", isVirtual: true, labelId, baseCurrency: "USD" }),
      })
    ).json()

    const on = await a.request(`/api/portfolios/${virtual.id}`, {
      method: "PATCH",
      headers: h.headers,
      body: JSON.stringify({ cashLegOnTrade: true }),
    })
    expect(on.status).toBe(422)

    const off = await a.request(`/api/portfolios/${virtual.id}`, {
      method: "PATCH",
      headers: h.headers,
      body: JSON.stringify({ cashLegOnTrade: false }),
    })
    expect(off.status).toBe(200)
    expect((await off.json()).cashLegOnTrade).toBe(false)
  })

  it("PATCH /api/portfolios/:id — a label is only valid on a virtual portfolio that owns it", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    const ownLabel = "44444444-4444-4444-8444-444444444444"
    const foreignLabel = "55555555-5555-4555-8555-555555555555"
    await h.db.insert(labels).values([
      { id: ownLabel, userId: "user-1", name: "Own", color: "#000000" },
      { id: foreignLabel, userId: "user-2", name: "Foreign", color: "#000000" },
    ])

    const casual = await (
      await a.request("/api/portfolios", {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify({ name: "Casual", baseCurrency: "USD" }),
      })
    ).json()
    const casualLabel = await a.request(`/api/portfolios/${casual.id}`, {
      method: "PATCH",
      headers: h.headers,
      body: JSON.stringify({ labelId: ownLabel }),
    })
    expect(casualLabel.status).toBe(422)

    const virtual = await (
      await a.request("/api/portfolios", {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify({ name: "Virtual", isVirtual: true, labelId: ownLabel, baseCurrency: "USD" }),
      })
    ).json()

    // Clearing a virtual portfolio's label would leave it virtual without one.
    const cleared = await a.request(`/api/portfolios/${virtual.id}`, {
      method: "PATCH",
      headers: h.headers,
      body: JSON.stringify({ labelId: null }),
    })
    expect(cleared.status).toBe(422)

    const foreign = await a.request(`/api/portfolios/${virtual.id}`, {
      method: "PATCH",
      headers: h.headers,
      body: JSON.stringify({ labelId: foreignLabel }),
    })
    expect(foreign.status).toBe(422)
  })

  it("PATCH /api/portfolios/:id — virtual portfolio relabels to another owned label", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    const first = "66666666-6666-4666-8666-666666666666"
    const second = "77777777-7777-4777-8777-777777777777"
    await h.db.insert(labels).values([
      { id: first, userId: "user-1", name: "First", color: "#000000" },
      { id: second, userId: "user-1", name: "Second", color: "#000000" },
    ])
    const virtual = await (
      await a.request("/api/portfolios", {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify({ name: "Virtual", isVirtual: true, labelId: first, baseCurrency: "USD" }),
      })
    ).json()

    const relabel = await a.request(`/api/portfolios/${virtual.id}`, {
      method: "PATCH",
      headers: h.headers,
      body: JSON.stringify({ labelId: second }),
    })
    expect(relabel.status).toBe(200)
    const body = await relabel.json()
    expect(body.labelId).toBe(second)
    expect(body.isVirtual).toBe(true)
  })

  it("virtual portfolios keep multiple labels and an empty label independent", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    const labelA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    const labelB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
    const labelEmpty = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    await h.db.insert(labels).values([
      { id: labelA, userId: "user-1", name: "A", color: "#000000" },
      { id: labelB, userId: "user-1", name: "B", color: "#000000" },
      { id: labelEmpty, userId: "user-1", name: "Empty", color: "#000000" },
    ])

    const source = await (
      await a.request("/api/portfolios", {
        method: "POST", headers: h.headers, body: JSON.stringify({ name: "Source", baseCurrency: "USD" }),
      })
    ).json()
    const virtual = async (name: string, labelId: string) =>
      (
        await a.request("/api/portfolios", {
          method: "POST", headers: h.headers, body: JSON.stringify({ name, isVirtual: true, labelId, baseCurrency: "USD" }),
        })
      ).json()
    const vA = await virtual("Virtual A", labelA)
    const vB = await virtual("Virtual B", labelB)
    const vEmpty = await virtual("Virtual Empty", labelEmpty)

    const posA = await insertPosition(h.db, {
      userId: h.user.id, portfolioId: source.id, symbol: "AAPL", quantity: "2", averageCostBasis: "100", instrumentCurrency: "USD",
    })
    const posB = await insertPosition(h.db, {
      userId: h.user.id, portfolioId: source.id, symbol: "MSFT", quantity: "3", averageCostBasis: "50", instrumentCurrency: "USD",
    })
    await h.db.insert(positionLabels).values([
      { positionId: posA.id, labelId: labelA },
      { positionId: posB.id, labelId: labelB },
    ])

    const symbols = async (id: string) =>
      (await (await a.request(`/api/portfolios/${id}/positions`, { headers: h.headers })).json())
        .map((row: { symbol: string }) => row.symbol)
    // Each virtual portfolio sees only its own label — no cross-contamination.
    expect(await symbols(vA.id)).toEqual(["AAPL"])
    expect(await symbols(vB.id)).toEqual(["MSFT"])
    // A label with no instruments is a valid, empty virtual portfolio.
    expect(await symbols(vEmpty.id)).toEqual([])

    const list = await (await a.request("/api/portfolios", { headers: h.headers })).json()
    const empty = list.find((p: { id: string }) => p.id === vEmpty.id)
    expect(empty.isVirtual).toBe(true)
    expect(empty.positionCount).toBe(0)
    expect(empty.currentValue).toBe(0)

    // The fields travel through the contract on every read shape: detail and
    // the lightweight selector as well as the list.
    const detail = await (await a.request(`/api/portfolios/${vA.id}`, { headers: h.headers })).json()
    expect(detail.isVirtual).toBe(true)
    expect(detail.labelId).toBe(labelA)
    const light = await (await a.request("/api/portfolios/light", { headers: h.headers })).json()
    const lightA = light.find((p: { id: string }) => p.id === vA.id)
    expect(lightA.isVirtual).toBe(true)
    expect(lightA.labelId).toBe(labelA)
  })

  it("POST /api/portfolios — casual creation is unchanged by the virtual rules", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    const res = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "Casual", baseCurrency: "USD", cashLegOnTrade: true }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.isVirtual).toBe(false)
    expect(body.labelId).toBeNull()
    // The cash-leg preference is still honoured for a casual portfolio.
    expect(body.cashLegOnTrade).toBe(true)
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
    await insertPosition(h.db, {
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
    await insertPosition(h.db, {
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

    await insertPosition(h.db, {
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
      expect(body.performance.capitalBasis).toBeCloseTo(800 * usdToPln + 4000 + 2000, 6)
      expect(body.performance).not.toHaveProperty("totalInvested")

      // and explicitly NOT the answer a hardcoded "USD" target would have produced
      const intoUsd = 1100 + 4400 * crossRate("PLN", "USD", { EUR: 1, USD: 1.08, PLN: 4.3 })! + 2200 * crossRate("PLN", "USD", { EUR: 1, USD: 1.08, PLN: 4.3 })!
      expect(last.value).not.toBeCloseTo(intoUsd, 2)
      // §83.2 — the Returns Chart's month series exists on the aggregate now,
      // derived from the same buildMonthlyReturns `/:id/analytics` uses. One
      // month here, so a single bar: Sept's aggregate return.
      expect(body.performance.monthlyReturns).toHaveLength(1)
      expect(body.performance.monthlyReturns[0].month).toBe("2026-09")
      // Not 10% — the aggregate is ONE account, so the day is worth
      // (ΣV₂ / ΣV₁) − 1 = 10979.6/10431.5 − 1, in which the 10%-gaining USD
      // portfolio is the minority of the money. A per-portfolio average would
      // say 10% and would be a claim about no portfolio at all.
      expect(body.performance.monthlyReturns[0].returnPercent).toBeCloseTo(5.25, 2)
      // §82.1's withholding predicate, shared with the per-portfolio tab.
      expect(body.performance.annualizedReturn).toBeNull()
      expect(body.performance.annualizedReturnWithheldReason).toBe("insufficient_history")
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

  it("uses capitalBasis for single-portfolio analytics as well as the merged route", async () => {
    const h = await makeHarness("analytics-capital-basis")
    const a = app(h.db)
    const pf = await seedPfWithSnapshots(h, "Only pf", "USD", [
      { snapshotDate: "2026-09-01", value: "500", invested: "400" },
      { snapshotDate: "2026-09-02", value: "600", invested: "400" },
    ])

    const res = await a.request(`/api/portfolios/${pf.id}/analytics?timeframe=ALL`, { headers: h.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.performance.capitalBasis).toBe(400)
    expect(body.performance).not.toHaveProperty("totalInvested")
  })

  it("returns pending AND the other portfolios' series when one has < 2 snapshots and backfillable history", async () => {
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
    // §83.2 — the flag and the partial sum together. This used to be an EMPTY
    // series: one brand-new portfolio erased every other portfolio's history
    // from a view whose entire purpose is the cumulative total.
    expect(body.performance.timeSeries).toHaveLength(2)
    expect(body.performance.totalValue).toBe(600)
    expect(body.performance.timeWeightedReturn).toBe(20)
    expect(body.benchmarks).toEqual([])

    // Clean up: nothing should have been enqueued, but keep the runner state
    // isolated regardless.
    __resetBackfillRunnerForTests()
  })

  it("§72.7: neither GET /merged nor GET /:id/analytics enqueues a backfill", async () => {
    // A GET must not mutate, and here it was not merely impolite: enqueueBackfill
    // keys its queue by portfolioId and REPLACES a queued pass's run function, so
    // browsing mid-rebuild downgraded the import's recalcPortfolioHistory (which
    // ends with a pricing pass) to a plain runBackfill (which does not). That is
    // why 51 positions came back unpriced on 2026-09-28 — the two portfolios
    // already RUNNING survived, every one still QUEUED was replaced.
    //
    // Asserting on the queue rather than on a spy: the hazard is the enqueue, and
    // "we stopped calling the function we called" is not the property that matters.
    const h = await makeHarness("no-get-backfill")
    const a = app(h.db)
    const empty = await (
      await a.request("/api/portfolios", {
        method: "POST", headers: h.headers, body: JSON.stringify({ name: "Hollow", currency: "USD" }),
      })
    ).json()
    await h.db.insert(portfolioTransactions).values({
      userId: h.user.id, portfolioId: empty.id, type: "BUY", instrumentSymbol: "AAPL",
      quantity: "1", price: "150", currency: "USD", totalAmount: "150",
      executedAt: new Date("2026-09-01T12:00:00Z"),
    })

    for (const url of ["/api/portfolios/merged", `/api/portfolios/${empty.id}/analytics`]) {
      const res = await a.request(url, { headers: h.headers })
      expect(res.status, url).toBe(200)
      // It still REPORTS the pending state — that part is a read and the UI needs it.
      expect((await res.json()).backfillStatus, url).toBe("pending")
    }
    expect(__backfillRunnerEnqueuedForTests(), "no backfill may be enqueued by a GET").toBe(false)
    __resetBackfillRunnerForTests()
  })

  /**
   * §83.3 — `?benchmarks=` on the aggregate. The overlay must mirror the MONEY
   * (flows bought at the day's close), never the value ratio: a deposit into a
   * portfolio that happens to also be flat must not read as the benchmark
   * outperforming by exactly the deposit.
   */
  describe("benchmarks on the aggregate (§83.3)", () => {
    beforeEach(() => {
      process.env.INSTRUMENTS_URL = "http://instruments:3000"
    })
    afterEach(() => {
      vi.unstubAllGlobals()
      delete process.env.INSTRUMENTS_URL
    })

    /** 404 is the documented "no data for this key", so unknown tickers drop. */
    function mockPriceBars(series: Record<string, { dates: string[]; closes: number[] }>) {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockImplementation((url: string) => {
          const sym = decodeURIComponent(String(url).match(/\/instruments\/([^/]+)\/price-bars/)?.[1] ?? "")
          const data = series[sym]
          if (!data) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) })
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ symbol: sym, dates: data.dates, closes: data.closes, stale: false }),
          })
        }),
      )
    }

    it("buys the benchmark with the deposit, so the line moves only on flow-free days", async () => {
      const h = await makeHarness("merged-bench-deposit")
      const a = app(h.db)
      const DAYS = ["2026-07-01", "2026-07-02", "2026-07-03"]
      // SPY flat, then +10% on the last day.
      mockPriceBars({ SPY: { dates: DAYS, closes: [100, 100, 110] } })

      const pf = await seedPfWithSnapshots(h, "A", "USD", [
        { snapshotDate: "2026-07-01", value: "1000", invested: "1000" },
        { snapshotDate: "2026-07-02", value: "2000", invested: "2000" },
        { snapshotDate: "2026-07-03", value: "2200", invested: "2000" },
      ])
      // The deposit that took invested 1000 → 2000 on the 2nd.
      await h.db.insert(portfolioCashTransactions).values({
        userId: h.user.id,
        portfolioId: pf.id,
        type: "DEPOSIT",
        amount: "1000",
        currency: "USD",
        transactionDate: "2026-07-02",
      })

      const res = await a.request("/api/portfolios/merged?timeframe=ALL&benchmarks=SPY", { headers: h.headers })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.benchmarks).toHaveLength(1)
      const line = body.benchmarks[0].timeSeries.map((p: { value: number }) => p.value)
      // 100 → 100 → 110. The mirror BOUGHT on the 2nd, so the deposit day is flat;
      // a value-ratio mirror would print 200 there and report +120% overall.
      expect(line).toEqual([100, 100, 110])
      expect(body.benchmarks[0].returnPercent).toBe(10)
    })

    it("is not perturbed by a transfer between two of the user's own portfolios", async () => {
      const h = await makeHarness("merged-bench-transfer")
      const a = app(h.db)
      const DAYS = ["2026-07-01", "2026-07-02", "2026-07-03"]
      mockPriceBars({ SPY: { dates: DAYS, closes: [100, 100, 110] } })

      const a1 = await seedPfWithSnapshots(h, "A", "USD", [
        { snapshotDate: "2026-07-01", value: "1000", invested: "1000" },
        { snapshotDate: "2026-07-02", value: "1000", invested: "1000" },
        { snapshotDate: "2026-07-03", value: "1000", invested: "1000" },
      ])
      const b = await seedPfWithSnapshots(h, "B", "USD", [
        { snapshotDate: "2026-07-01", value: "0", invested: "0" },
        { snapshotDate: "2026-07-02", value: "0", invested: "0" },
        { snapshotDate: "2026-07-03", value: "0", invested: "0" },
      ])
      // A paired transfer: −1000 out of A, +1000 into B, same day. Both legs are
      // in `dailyExternalFlows`, so they cancel in the SUM — money moving between
      // your own portfolios is not money entering the account.
      await h.db.insert(portfolioCashTransactions).values([
        { userId: h.user.id, portfolioId: a1.id, type: "TRANSFER", amount: "-1000", currency: "USD", transactionDate: "2026-07-02", toPortfolioId: b.id },
        { userId: h.user.id, portfolioId: b.id, type: "TRANSFER", amount: "1000", currency: "USD", transactionDate: "2026-07-02", toPortfolioId: a1.id },
      ])

      const res = await a.request("/api/portfolios/merged?timeframe=ALL&benchmarks=SPY", { headers: h.headers })
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.benchmarks[0].returnPercent).toBe(10)
      expect(body.benchmarks[0].timeSeries.map((p: { value: number }) => p.value)).toEqual([100, 100, 110])
    })

    it("drops unknown tickers, and stays [] with no benchmarks param", async () => {
      const h = await makeHarness("merged-bench-unknown")
      const a = app(h.db)
      mockPriceBars({})
      await seedPfWithSnapshots(h, "A", "USD", [
        { snapshotDate: "2026-07-01", value: "500", invested: "400" },
        { snapshotDate: "2026-07-02", value: "600", invested: "400" },
      ])

      const unknown = await (await a.request("/api/portfolios/merged?benchmarks=NOPE", { headers: h.headers })).json()
      expect(unknown.benchmarks).toEqual([])
      // The aggregate is still returned — a bad ticker drops the OVERLAY, not the page.
      expect(unknown.performance.timeSeries).toHaveLength(2)

      const none = await (await a.request("/api/portfolios/merged", { headers: h.headers })).json()
      expect(none.benchmarks).toEqual([])
    })
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
