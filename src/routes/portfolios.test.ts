import { describe, expect, it } from "vitest"
import { Hono } from "hono"
import { createPortfolioRoutes } from "./portfolios.js"
import { makeHarness } from "./test-utils.js"
import {
  portfolios,
  positions,
  portfolioTransactions,
} from "../db/schema.js"
import { sql } from "drizzle-orm"

function app(db: Parameters<typeof makeHarness>[0] extends string ? never : Parameters<typeof createPortfolioRoutes>[0]) {
  const a = new Hono()
  a.route("/api/portfolios", createPortfolioRoutes(db))
  return a
}

describe("Portfolio CRUD (§15 Phase B)", () => {
  it("POST /api/portfolios — creates with mandatory currency", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    const res = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "Growth", currency: "USD" }),
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.name).toBe("Growth")
    expect(body.currency).toBe("USD")
    expect(body.baseCurrency).toBe("USD")
    expect(body.strategy).toBe("GROWTH")
    expect(body.totalInvested).toBe(0)
    expect(body.id).toBeDefined()
  })

  it("POST /api/portfolios — missing currency → 422", async () => {
    const h = await makeHarness()
    const a = app(h.db)
    const res = await a.request("/api/portfolios", {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify({ name: "No CCY" }),
    })
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error).toBe("ValidationError")
  })

  it("POST /api/portfolios — invalid walletId → 422", async () => {
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
    expect(res.status).toBe(422)
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
      body: JSON.stringify({ name: "Light", currency: "PLN" }),
    })

    const res = await a.request("/api/portfolios/light", { headers: h.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.length).toBe(1)
    expect(body[0].name).toBe("Light")
    expect(body[0].currency).toBe("PLN")
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
      body: JSON.stringify({ name: "Old", currency: "USD" }),
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
    expect(body.currency).toBe("USD") // unchanged
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
