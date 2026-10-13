import { describe, expect, it } from "vitest"
import { Hono } from "hono"
import { eq } from "drizzle-orm"
import { makeHarness } from "./test-utils.js"
import { createPortfolioRoutes } from "./portfolios.js"
import { createPortfolioCashRoutes } from "./portfolio-cash.js"
import { createTransactionLabelRoutes } from "./transaction-labels.js"
import {
  labels,
  portfolioCashTransactions,
  portfolioTransactions,
  positionPortfolios,
} from "../db/schema.js"

/**
 * #146 — a virtual portfolio is a read-only projection over its label's
 * instruments and their existing transactions. The SPA hides the controls, but
 * hiding a button is not an authorization boundary: every mutation route must
 * reject server-side, and the cash surface must be deliberately absent (404)
 * rather than merely empty. These tests hit the route modules directly with a
 * virtual portfolio and assert the stable error, so a regression that drops a
 * guard fails here instead of shipping.
 */

const LABEL_ID = "11111111-1111-4111-8111-111111111111"
const TX_ID = "22222222-2222-4222-8222-222222222222"
const POSITION_ID = "33333333-3333-4333-8333-333333333333"
const OTHER_PORTFOLIO_ID = "44444444-4444-4444-8444-444444444444"

const BUY_BODY = {
  type: "BUY",
  symbol: "AAPL",
  instrumentName: "Apple Inc",
  quantity: 1,
  price: 150,
  currency: "USD",
}

/**
 * Mount the same three route modules the service mounts under /api/portfolios
 * (index.ts:49-57), against one PGlite db, and seed one virtual portfolio.
 */
async function boot() {
  const h = await makeHarness()
  const a = new Hono()
  a.route("/api/portfolios", createPortfolioCashRoutes(h.db))
  a.route("/api/portfolios", createPortfolioRoutes(h.db))
  a.route("/api/portfolios", createTransactionLabelRoutes(h.db))

  await h.db.insert(labels).values({ id: LABEL_ID, userId: h.user.id, name: "Virtual", color: "#000000" })
  const res = await a.request("/api/portfolios", {
    method: "POST",
    headers: h.headers,
    body: JSON.stringify({ name: "Virtual", isVirtual: true, labelId: LABEL_ID, baseCurrency: "USD" }),
  })
  expect(res.status).toBe(201)
  const virtual = await res.json()
  return { h, a, virtual }
}

describe("virtual portfolio read-only enforcement (#146)", () => {
  it("the cash surface is deliberately absent — 404 CashUnavailable on every read", async () => {
    const { h, a, virtual } = await boot()
    for (const path of ["/cash", "/cash/balance-history", "/cash/transactions"]) {
      const res = await a.request(`/api/portfolios/${virtual.id}${path}`, { headers: h.headers })
      expect(res.status, `${path} status`).toBe(404)
      expect((await res.json()).error, `${path} error`).toBe("CashUnavailable")
    }
  })

  it("every transaction/position/dividend/cash mutation route rejects with 409 ReadOnlyPortfolio", async () => {
    const { h, a, virtual } = await boot()
    const cases: Array<{ method: string; path: string; body?: unknown }> = [
      // Transactions — BUY and an explicit DIVIDEND (the criterion names dividends).
      { method: "POST", path: "/transactions", body: BUY_BODY },
      { method: "POST", path: "/transactions", body: { ...BUY_BODY, type: "DIVIDEND" } },
      { method: "PATCH", path: `/transactions/${TX_ID}`, body: { quantity: 5 } },
      { method: "DELETE", path: `/transactions/${TX_ID}` },
      // Transaction labels — a membership change through the label route.
      { method: "POST", path: `/transactions/${TX_ID}/labels`, body: { labelIds: [] } },
      // Positions.
      { method: "POST", path: "/positions", body: { ...BUY_BODY } },
      { method: "PATCH", path: `/positions/${POSITION_ID}`, body: { quantity: 5 } },
      { method: "DELETE", path: `/positions/${POSITION_ID}` },
      // Cash movement.
      { method: "POST", path: "/cash/deposits", body: { amount: 100 } },
      { method: "POST", path: "/cash/withdrawals", body: { amount: 100 } },
      {
        method: "POST",
        path: "/cash/transfers",
        body: { amount: 100, currency: "USD", toPortfolioId: OTHER_PORTFOLIO_ID },
      },
    ]

    for (const { method, path, body } of cases) {
      const res = await a.request(`/api/portfolios/${virtual.id}${path}`, {
        method,
        headers: h.headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
      expect(res.status, `${method} ${path}`).toBe(409)
      expect((await res.json()).error, `${method} ${path}`).toBe("ReadOnlyPortfolio")
    }

    // The rejection is a real no-op: nothing was written under the virtual id.
    // A guard that returns 409 after inserting would pass the status assertions.
    const txRows = await h.db.select().from(portfolioTransactions).where(eq(portfolioTransactions.portfolioId, virtual.id))
    const posRows = await h.db.select().from(positionPortfolios).where(eq(positionPortfolios.portfolioId, virtual.id))
    const cashRows = await h.db.select().from(portfolioCashTransactions).where(eq(portfolioCashTransactions.portfolioId, virtual.id))
    expect(txRows, "no transaction may be created on a virtual portfolio").toEqual([])
    expect(posRows, "no position membership may be created on a virtual portfolio").toEqual([])
    expect(cashRows, "no cash row may be created on a virtual portfolio").toEqual([])
  })

  it("a casual portfolio keeps its full mutation surface (the guard is not global)", async () => {
    const h = await makeHarness()
    const a = new Hono()
    a.route("/api/portfolios", createPortfolioCashRoutes(h.db))
    a.route("/api/portfolios", createPortfolioRoutes(h.db))

    const casual = await (
      await a.request("/api/portfolios", {
        method: "POST",
        headers: h.headers,
        body: JSON.stringify({ name: "Casual", baseCurrency: "USD" }),
      })
    ).json()

    // The same POST the virtual portfolio rejects must be accepted here, or the
    // guard is over-broad and would break every casual portfolio.
    const res = await a.request(`/api/portfolios/${casual.id}/transactions`, {
      method: "POST",
      headers: h.headers,
      body: JSON.stringify(BUY_BODY),
    })
    expect(res.status).toBe(201)

    const deposit = await a.request(`/api/portfolios/${casual.id}/cash/deposits`, {
      method: "POST",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({ amount: 100 }),
    })
    expect(deposit.status).toBe(201)

    const cash = await a.request(`/api/portfolios/${casual.id}/cash`, { headers: h.headers })
    expect(cash.status).toBe(200)
  })
})
