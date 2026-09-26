import { describe, expect, it } from "vitest"
import { Hono } from "hono"
import crypto from "node:crypto"
import { and, eq } from "drizzle-orm"
import { makeHarness, type Harness } from "./test-utils.js"
import { createPortfolioCashRoutes } from "./portfolio-cash.js"
import {
  portfolios,
  portfolioCashTransactions,
  portfolioTransactions,
} from "../db/schema.js"

async function boot(userId = "user-1") {
  const h = await makeHarness(userId)
  const app = new Hono().route("/api/portfolios", createPortfolioCashRoutes(h.db))
  return { ...h, app }
}

async function makePf(h: Harness, name = "P1", baseCurrency = "PLN") {
  const id = crypto.randomUUID()
  await h.db.insert(portfolios).values({ userId: "user-1", id, name, baseCurrency })
  return id
}

function post(h: Harness, path: string, body: unknown) {
  return h.app.request(path, {
    method: "POST",
    headers: { ...h.headers, "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("GET /:id/cash (62.3)", () => {
  it("reports per-currency balances + base total (replayed)", async () => {
    const h = await boot()
    const pf = await makePf(h) // base PLN
    await h.db.insert(portfolioCashTransactions).values({
      userId: "user-1",
      portfolioId: pf,
      type: "DEPOSIT",
      amount: "100",
      currency: "PLN",
    })
    // no FX mock → 1:1 degrade, so total = 100
    const res = await h.app.request(`/api/portfolios/${pf}/cash`, { headers: h.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.baseCurrency).toBe("PLN")
    expect(body.balances).toEqual([{ currency: "PLN", balance: 100 }])
    expect(body.total).toBe(100)
  })

  it("404 for another user's portfolio", async () => {
    const h = await boot()
    const other = crypto.randomUUID()
    await h.db.insert(portfolios).values({ userId: "someone-else", id: other, name: "X", baseCurrency: "USD" })
    const res = await h.app.request(`/api/portfolios/${other}/cash`, { headers: h.headers })
    expect(res.status).toBe(404)
  })
})

describe("POST deposits / withdrawals (62.3)", () => {
  it("deposit defaults currency to baseCurrency and stores +amount", async () => {
    const h = await boot()
    const pf = await makePf(h, "P1", "PLN")
    const res = await post(h, `/api/portfolios/${pf}/cash/deposits`, { amount: 250 })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.type).toBe("DEPOSIT")
    expect(body.currency).toBe("PLN")
    expect(body.amount).toBe(250)
  })

  it("deposit in a foreign currency keeps that currency; withdrawal stores −amount", async () => {
    const h = await boot()
    const pf = await makePf(h, "P1", "PLN")
    await post(h, `/api/portfolios/${pf}/cash/deposits`, { amount: 100, currency: "USD" })
    const w = await post(h, `/api/portfolios/${pf}/cash/withdrawals`, { amount: 40, currency: "USD" })
    expect(w.status).toBe(201)
    const wb = await w.json()
    expect(wb.type).toBe("WITHDRAWAL")
    expect(wb.currency).toBe("USD")
    expect(wb.amount).toBe(-40)

    const res = await h.app.request(`/api/portfolios/${pf}/cash`, { headers: h.headers })
    const balances = await res.json()
    expect(balances.balances.find((b: any) => b.currency === "USD").balance).toBe(60)
  })

  it("withdrawal clamps to negative even if a positive value is sent", async () => {
    const h = await boot()
    const pf = await makePf(h)
    const w = await post(h, `/api/portfolios/${pf}/cash/withdrawals`, { amount: 75 })
    expect((await w.json()).amount).toBe(-75)
  })

  it("404 when the portfolio is not owned", async () => {
    const h = await boot()
    const other = crypto.randomUUID()
    await h.db.insert(portfolios).values({ userId: "else", id: other, name: "Z", baseCurrency: "USD" })
    const res = await post(h, `/api/portfolios/${other}/cash/deposits`, { amount: 1 })
    expect(res.status).toBe(404)
  })
})

describe("POST transfers (62.3)", () => {
  it("same-ccy transfer inserts a paired legs with linkedTxId both ways and both balances move", async () => {
    const h = await boot()
    const src = await makePf(h, "Src", "USD")
    const dst = await makePf(h, "Dst", "USD")
    await post(h, `/api/portfolios/${src}/cash/deposits`, { amount: 500 })

    const res = await post(h, `/api/portfolios/${src}/cash/transfers`, {
      amount: 200,
      currency: "USD",
      toPortfolioId: dst,
    })
    expect(res.status).toBe(201)
    const debit = await res.json()
    expect(debit.type).toBe("TRANSFER")
    expect(debit.amount).toBe(-200) // sent as-is (debit)
    expect(debit.toPortfolioId).toBe(dst)

    const rows = await h.db
      .select()
      .from(portfolioCashTransactions)
      .where(eq(portfolioCashTransactions.type, "TRANSFER"))
    expect(rows).toHaveLength(2)
    const d = rows.find((r) => Number(r.amount) < 0)!
    const cr = rows.find((r) => Number(r.amount) > 0)!
    expect(d.portfolioId).toBe(src)
    expect(cr.portfolioId).toBe(dst)
    expect(Number(d.amount)).toBe(-200) // debit leg (src)
    expect(Number(cr.amount)).toBe(200) // credit leg (dst)
    // linkedTxId both ways
    expect(d.linkedTxId).toBe(cr.id)
    expect(cr.linkedTxId).toBe(d.id)
    // both legs show the transfer direction in the description
    expect(d.description).toBe("→ Dst")
    expect(cr.description).toBe("from Src")

    const cashSrc = await (await h.app.request(`/api/portfolios/${src}/cash`, { headers: h.headers })).json()
    const cashDst = await (await h.app.request(`/api/portfolios/${dst}/cash`, { headers: h.headers })).json()
    expect(cashSrc.balances[0].balance).toBe(300)
    expect(cashDst.balances[0].balance).toBe(200)
  })

  it("cross-ccy transfer computes the target leg at the FX rate", async () => {
    const { mockInstrumentsFx, unmockInstrumentsFx } = await import("../test-fx-mock.js")
    mockInstrumentsFx({ table: { USD: 1.08, EUR: 1.08, PLN: 4.3 }, asOf: "2024-12-31" })
    try {
      const h = await boot()
      const src = await makePf(h, "Src", "USD")
      const dst = await makePf(h, "Dst", "PLN")
      await post(h, `/api/portfolios/${src}/cash/deposits`, { amount: 100 })

      const res = await post(h, `/api/portfolios/${src}/cash/transfers`, {
        amount: 100,
        currency: "USD",
        toPortfolioId: dst,
        targetFxRate: 4.3,
      })
      expect(res.status).toBe(201)

      const rows = await h.db
        .select()
        .from(portfolioCashTransactions)
        .where(eq(portfolioCashTransactions.type, "TRANSFER"))
      expect(rows).toHaveLength(2)
      const d = rows.find((r) => Number(r.amount) < 0)!
      const cr = rows.find((r) => Number(r.amount) > 0)!
      expect(Number(d.amount)).toBe(-100)
      expect(Number(cr.amount)).toBe(430) // 100 × 4.3
      expect(Number(d.targetAmount)).toBe(430) // debit leg stores the credit leg it created
      expect(Number(cr.targetAmount)).toBe(-100) // credit leg stores the debit it paired with
    } finally {
      unmockInstrumentsFx()
    }
  })

  it("rejects a transfer to the source portfolio with 400", async () => {
    const h = await boot()
    const src = await makePf(h, "Src", "USD")
    const res = await post(h, `/api/portfolios/${src}/cash/transfers`, {
      amount: 10,
      currency: "USD",
      toPortfolioId: src,
    })
    expect(res.status).toBe(400)
  })

  it("404 for a transfer target owned by another user", async () => {
    const h = await boot()
    const src = await makePf(h, "Src", "USD")
    const foreign = crypto.randomUUID()
    await h.db.insert(portfolios).values({ userId: "else", id: foreign, name: "F", baseCurrency: "USD" })
    const res = await post(h, `/api/portfolios/${src}/cash/transfers`, {
      amount: 10,
      currency: "USD",
      toPortfolioId: foreign,
    })
    expect(res.status).toBe(404)
  })
})

describe("GET /:id/cash/transactions (62.3)", () => {
  it("lists external rows with balanceAfter as a running window sum", async () => {
    const h = await boot()
    const pf = await makePf(h, "P1", "USD")
    await h.db.insert(portfolioCashTransactions).values([
      { userId: "user-1", portfolioId: pf, type: "DEPOSIT", amount: "100", currency: "USD", transactionDate: "2024-01-01" },
      { userId: "user-1", portfolioId: pf, type: "WITHDRAWAL", amount: "-30", currency: "USD", transactionDate: "2024-01-02" },
    ])

    const res = await h.app.request(`/api/portfolios/${pf}/cash/transactions`, { headers: h.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.total).toBe(2)
    // newest first
    const [first, second] = body.items
    expect(first.balanceAfter).toBe(70) // 100 − 30
    expect(second.balanceAfter).toBe(100)
  })

  it("trade effects feed balanceAfter (a BUY debits the same currency)", async () => {
    const h = await boot()
    const pf = await makePf(h, "P1", "USD")
    await h.db.insert(portfolioTransactions).values({
      userId: "user-1",
      portfolioId: pf,
      type: "BUY",
      instrumentSymbol: "AAPL",
      quantity: "10",
      price: "50",
      totalAmount: "500",
      currency: "USD",
      executedAt: new Date("2024-01-01T00:00:00.000Z"),
    })
    await h.db.insert(portfolioCashTransactions).values({
      userId: "user-1",
      portfolioId: pf,
      type: "DEPOSIT",
      amount: "1000",
      currency: "USD",
      transactionDate: "2024-01-02",
    })

    const res = await h.app.request(`/api/portfolios/${pf}/cash/transactions`, { headers: h.headers })
    const body = await res.json()
    // single external row; its own-currency balance after = −500 (BUY) + 1000 = 500
    expect(body.items).toHaveLength(1)
    expect(body.items[0].balanceAfter).toBe(500)
  })

  it("filters by ?labels= (AND)", async () => {
    const h = await boot()
    const pf = await makePf(h, "P1", "USD")
    const { labels } = await import("../db/schema.js")
    const [lbl] = await h.db.insert(labels).values({ userId: "user-1", name: "Crypto", color: "#00ff00" }).returning()
    const rows = await h.db.insert(portfolioCashTransactions).values([
      { userId: "user-1", portfolioId: pf, type: "DEPOSIT", amount: "1", currency: "USD", transactionDate: "2024-01-01" },
      { userId: "user-1", portfolioId: pf, type: "DEPOSIT", amount: "2", currency: "USD", transactionDate: "2024-01-02" },
    ]).returning()
    const { portfolioCashTransactionLabels } = await import("../db/schema.js")
    await h.db.insert(portfolioCashTransactionLabels).values({ cashTransactionId: rows[0].id, labelId: lbl.id })

    const res = await h.app.request(`/api/portfolios/${pf}/cash/transactions?labels=${lbl.id}`, { headers: h.headers })
    const body = await res.json()
    expect(body.total).toBe(1)
    expect(body.items[0].id).toBe(rows[0].id)
  })
})

describe("GET /cash/recent-transactions (62.3)", () => {
  it("lists external rows across portfolios with displayLabel + isInternalTransfer", async () => {
    const h = await boot()
    const pf = await makePf(h, "P1", "USD")
    await h.db.insert(portfolioCashTransactions).values({
      userId: "user-1",
      portfolioId: pf,
      type: "DEPOSIT",
      amount: "100",
      currency: "USD",
      transactionDate: "2024-01-01",
    })

    const res = await h.app.request("/api/portfolios/cash/recent-transactions", { headers: h.headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.meta.total).toBe(1)
    expect(body.data[0].displayLabel).toBe("Deposit")
    expect(body.data[0].isInternalTransfer).toBe(false)
    expect(body.data[0].portfolioName).toBe("P1")
  })
})

describe("PATCH / DELETE / labels on a cash row (62.3)", () => {
  async function seedRow(h: Harness, pf: string) {
    const [r] = await h.db
      .insert(portfolioCashTransactions)
      .values({ userId: "user-1", portfolioId: pf, type: "DEPOSIT", amount: "100", currency: "USD" })
      .returning()
    return r
  }

  it("PATCH updates amount/date/description and returns labels", async () => {
    const h = await boot()
    const pf = await makePf(h, "P1", "USD")
    const r = await seedRow(h, pf)
    const res = await h.app.request(`/api/portfolios/cash/transactions/${r.id}`, {
      method: "PATCH",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({ amount: 120, date: "2024-02-01", description: "note" }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Number(body.amount)).toBe(120)
    expect(body.date).toBe("2024-02-01")
    expect(Array.isArray(body.labels)).toBe(true)
  })

  it("PATCH a WITHDRAWAL re-clamps the sign and patches currency+fees", async () => {
    const h = await boot()
    const pf = await makePf(h, "P1", "USD")
    const [w] = await h.db
      .insert(portfolioCashTransactions)
      .values({ userId: "user-1", portfolioId: pf, type: "WITHDRAWAL", amount: "-100", currency: "USD" })
      .returning()
    // edit as a magnitude +150 in EUR with a fixed fee → stored as −150 EUR
    const res = await h.app.request(`/api/portfolios/cash/transactions/${w.id}`, {
      method: "PATCH",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({ amount: 150, currency: "EUR", fees: 5, feesType: "fixed" }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(Number(body.amount)).toBe(-150)
    expect(body.currency).toBe("EUR")
    expect(Number(body.fees)).toBe(5)
    expect(body.feeCurrency).toBe("EUR")
  })

  it("PATCH a zero amount → 422 (the non-zero constraint)", async () => {
    const h = await boot()
    const pf = await makePf(h, "P1", "USD")
    const r = await seedRow(h, pf)
    const res = await h.app.request(`/api/portfolios/cash/transactions/${r.id}`, {
      method: "PATCH",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({ amount: 0 }),
    })
    expect(res.status).toBe(422)
  })

  it("DELETE removes the row (204)", async () => {
    const h = await boot()
    const pf = await makePf(h, "P1", "USD")
    const r = await seedRow(h, pf)
    const res = await h.app.request(`/api/portfolios/cash/transactions/${r.id}`, { method: "DELETE", headers: h.headers })
    expect(res.status).toBe(204)
    expect(await h.db.select().from(portfolioCashTransactions).where(and(eq(portfolioCashTransactions.id, r.id)))).toHaveLength(0)
  })

  it("set-labels replace semantics + returns labels", async () => {
    const h = await boot()
    const pf = await makePf(h, "P1", "USD")
    const r = await seedRow(h, pf)
    const { labels } = await import("../db/schema.js")
    const [a] = await h.db.insert(labels).values({ userId: "user-1", name: "A", color: "#111111" }).returning()
    const [b] = await h.db.insert(labels).values({ userId: "user-1", name: "B", color: "#222222" }).returning()

    const res = await h.app.request(`/api/portfolios/cash/transactions/${r.id}/labels`, {
      method: "POST",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({ labelIds: [a.id, b.id] }),
    })
    expect(res.status).toBe(200)
    const items = await res.json()
    expect(items.map((l: any) => l.name).sort()).toEqual(["A", "B"])
  })

  it("404 for another user's row on PATCH/DELETE", async () => {
    const h = await boot()
    const foreignPf = crypto.randomUUID()
    await h.db.insert(portfolios).values({ userId: "else", id: foreignPf, name: "F", baseCurrency: "USD" })
    const [foreignRow] = await h.db
      .insert(portfolioCashTransactions)
      .values({
        userId: "else",
        portfolioId: foreignPf,
        type: "DEPOSIT",
        amount: "1",
        currency: "USD",
      })
      .returning()
    const res = await h.app.request(`/api/portfolios/cash/transactions/${foreignRow.id}`, { method: "DELETE", headers: h.headers })
    expect(res.status).toBe(404)
  })
})
