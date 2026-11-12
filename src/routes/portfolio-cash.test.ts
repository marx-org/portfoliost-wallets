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
import { mockInstrumentsFx, unmockInstrumentsFx } from "../test-fx-mock.js"

async function boot(userId = "user-1") {
  const h = await makeHarness(userId)
  const app = new Hono().route("/api/portfolios", createPortfolioCashRoutes(h.db))
  return { ...h, app }
}

async function makePf(h: Harness, name = "P1", baseCurrency = "PLN", cashBaseCurrencyOnly = false) {
  const id = crypto.randomUUID()
  await h.db.insert(portfolios).values({ userId: "user-1", id, name, baseCurrency, cashBaseCurrencyOnly })
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

  it("cash-base-only current cash and balance history agree after dated FX replay", async () => {
    mockInstrumentsFx({ table: { USD: 1.08, PLN: 4.3 }, asOf: "2024-12-31" })
    try {
      const h = await boot()
      const pf = await makePf(h, "PLN only", "PLN", true)
      await h.db.insert(portfolioTransactions).values({
        userId: "user-1",
        portfolioId: pf,
        type: "BUY",
        instrumentSymbol: "AAPL",
        quantity: "1",
        price: "100",
        totalAmount: "100",
        currency: "USD",
        executedAt: new Date("2024-01-01T10:00:00.000Z"),
      })
      await h.db.insert(portfolioCashTransactions).values({
        userId: "user-1",
        portfolioId: pf,
        type: "DEPOSIT",
        amount: "50",
        currency: "USD",
        transactionDate: "2024-01-02",
      })

      const current = await (await h.app.request(`/api/portfolios/${pf}/cash`, { headers: h.headers })).json()
      expect(current.balances).toHaveLength(1)
      expect(current.balances[0].currency).toBe("PLN")

      const history = await (
        await h.app.request(`/api/portfolios/${pf}/cash/balance-history?period=ALL`, { headers: h.headers })
      ).json()
      expect(history.data.at(-1).balance).toBeCloseTo(current.balances[0].balance, 6)
    } finally {
      unmockInstrumentsFx()
    }
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

  it("cash-base-only portfolios accept base-currency cash and reject foreign deposits or withdrawals", async () => {
    const h = await boot()
    const pf = await makePf(h, "PLN only", "PLN", true)

    const deposit = await post(h, `/api/portfolios/${pf}/cash/deposits`, { amount: 100, currency: "USD" })
    const withdrawal = await post(h, `/api/portfolios/${pf}/cash/withdrawals`, { amount: 10, currency: "EUR" })
    expect(deposit.status).toBe(422)
    expect(withdrawal.status).toBe(422)

    const valid = await post(h, `/api/portfolios/${pf}/cash/deposits`, { amount: 50, currency: "PLN" })
    expect(valid.status).toBe(201)
    const cash = await (await h.app.request(`/api/portfolios/${pf}/cash`, { headers: h.headers })).json()
    expect(cash.balances).toEqual([{ currency: "PLN", balance: 50 }])
  })

  it("a settlement-currency portfolio accepts only that currency and reports one balance", async () => {
    mockInstrumentsFx({ table: { USD: 1.08, PLN: 4.3 }, asOf: "2024-12-31" })
    try {
      const h = await boot()
      const pf = crypto.randomUUID()
      await h.db.insert(portfolios).values({ userId: "user-1", id: pf, name: "IBKR", baseCurrency: "PLN", cashCurrency: "USD" })

      const rejected = await post(h, `/api/portfolios/${pf}/cash/deposits`, { amount: 100, currency: "PLN" })
      expect(rejected.status).toBe(422)

      const deposit = await post(h, `/api/portfolios/${pf}/cash/deposits`, { amount: 100, currency: "USD" })
      expect(deposit.status).toBe(201)

      const cash = await (await h.app.request(`/api/portfolios/${pf}/cash`, { headers: h.headers })).json()
      expect(cash.baseCurrency).toBe("PLN")
      expect(cash.balances).toEqual([{ currency: "USD", balance: 100 }])
      // 100 USD at 4.3/1.08 = 3.98148 PLN per USD
      expect(cash.total).toBe(398.15)
    } finally {
      unmockInstrumentsFx()
    }
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

describe("POST interest / fees / conversions (#245)", () => {
  it("interest keeps its sign: credited positive, charged negative", async () => {
    const h = await boot()
    const pf = await makePf(h, "IBKR", "PLN")

    const credited = await post(h, `/api/portfolios/${pf}/cash/interest`, { amount: 0.7, currency: "USD", transactionDate: "2024-04-03" })
    const charged = await post(h, `/api/portfolios/${pf}/cash/interest`, { amount: -0.26, currency: "USD", transactionDate: "2024-06-05" })
    expect(credited.status).toBe(201)
    expect((await credited.json()).amount).toBe(0.7)
    expect((await charged.json()).amount).toBe(-0.26)

    const cash = await (await h.app.request(`/api/portfolios/${pf}/cash`, { headers: h.headers })).json()
    expect(cash.balances.find((b: any) => b.currency === "USD").balance).toBeCloseTo(0.44, 6)
  })

  it("a fee is always booked as a debit, whatever sign the caller sends", async () => {
    const h = await boot()
    const pf = await makePf(h, "IBKR", "PLN")
    const res = await post(h, `/api/portfolios/${pf}/cash/fees`, { amount: 1.25, currency: "USD", description: "ADR fee" })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.type).toBe("FEE")
    expect(body.amount).toBe(-1.25)
  })

  it("a conversion stores both legs and moves both balances", async () => {
    const h = await boot()
    const pf = await makePf(h, "P1", "PLN")
    const res = await post(h, `/api/portfolios/${pf}/cash/conversions`, {
      amount: -1000, currency: "EUR", toCurrency: "USD", toAmount: 1150.4, transactionDate: "2024-01-03",
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.type).toBe("FX_CONVERSION")
    expect(body.amount).toBe(-1000)
    expect(body.toCurrency).toBe("USD")
    expect(body.toAmount).toBe(1150.4)

    const cash = await (await h.app.request(`/api/portfolios/${pf}/cash`, { headers: h.headers })).json()
    expect(cash.balances.find((b: any) => b.currency === "EUR").balance).toBe(-1000)
    expect(cash.balances.find((b: any) => b.currency === "USD").balance).toBe(1150.4)
  })

  it("a conversion with no second leg is a correction of one balance", async () => {
    const h = await boot()
    const pf = await makePf(h, "IBKR", "PLN", false)
    await post(h, `/api/portfolios/${pf}/cash/deposits`, { amount: 100, currency: "USD" })
    const res = await post(h, `/api/portfolios/${pf}/cash/conversions`, {
      amount: -60.515636, currency: "USD", toAmount: 0, description: "FX USD/SEK - net in base",
    })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.toCurrency).toBe("USD")

    const recent = await (await h.app.request(`/api/portfolios/cash/recent-transactions?limit=10`, { headers: h.headers })).json()
    const label = recent.data.find((r: any) => r.type === "FX_CONVERSION")?.displayLabel
    expect(label).toBe("Correction")
  })

  it("a settlement-currency portfolio rejects a conversion between two foreign currencies", async () => {
    const h = await boot()
    const pf = crypto.randomUUID()
    await h.db.insert(portfolios).values({ userId: "user-1", id: pf, name: "IBKR", baseCurrency: "PLN", cashCurrency: "USD" })

    const bad = await post(h, `/api/portfolios/${pf}/cash/conversions`, { amount: -100, currency: "EUR", toCurrency: "SEK", toAmount: 110 })
    expect(bad.status).toBe(422)

    const ok = await post(h, `/api/portfolios/${pf}/cash/conversions`, { amount: -100, currency: "EUR", toCurrency: "USD", toAmount: 110 })
    expect(ok.status).toBe(201)
  })

  it("PATCH edits the second leg of a conversion and keeps the correction invariant", async () => {
    const h = await boot()
    const pf = crypto.randomUUID()
    await h.db.insert(portfolios).values({ userId: "user-1", id: pf, name: "IBKR", baseCurrency: "PLN", cashCurrency: "USD" })

    const created = await post(h, `/api/portfolios/${pf}/cash/conversions`, { amount: -1000, currency: "EUR", toCurrency: "USD", toAmount: 1150.4 })
    const id = (await created.json()).id

    const patched = await h.app.request(`/api/portfolios/cash/transactions/${id}`, {
      method: "PATCH",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({ toAmount: 1151 }),
    })
    expect(patched.status).toBe(200)
    const body = await patched.json()
    expect(body.toAmount).toBe(1151)
    expect(body.toCurrency).toBe("USD")

    mockInstrumentsFx({ table: { USD: 1, EUR: 1, PLN: 4 }, asOf: "2024-01-01" })
    try {
      const cash = await (await h.app.request(`/api/portfolios/${pf}/cash`, { headers: h.headers })).json()
      // 1 000 EUR handed over at 1:1, 1 151 USD received → +151 USD
      expect(cash.balances).toEqual([{ currency: "USD", balance: 151 }])
    } finally {
      unmockInstrumentsFx()
    }
  })

  it("a conversion charge in a currency neither leg is in is rejected", async () => {
    const h = await boot()
    const pf = await makePf(h, "IBKR", "PLN")
    const res = await post(h, `/api/portfolios/${pf}/cash/conversions`, {
      amount: -1000, currency: "EUR", toCurrency: "USD", toAmount: 1150.4,
      fees: 5, feesType: "fixed", feeCurrency: "PLN",
    })
    expect(res.status).toBe(422)
    expect((await res.json()).message).toMatch(/belongs to neither leg/)

    // The charge in the leg received is accepted; the writer nets it there.
    const ok = await post(h, `/api/portfolios/${pf}/cash/conversions`, {
      amount: -1000, currency: "EUR", toCurrency: "USD", toAmount: 1145.4,
      fees: 5, feesType: "fixed", feeCurrency: "USD",
    })
    expect(ok.status).toBe(201)
  })

  it("a conversion can be patched to a zero first leg — the correction is the second leg", async () => {
    const h = await boot()
    const pf = crypto.randomUUID()
    await h.db.insert(portfolios).values({ userId: "user-1", id: pf, name: "IBKR", baseCurrency: "PLN", cashCurrency: "USD" })

    const created = await post(h, `/api/portfolios/${pf}/cash/conversions`, {
      amount: -0.93, currency: "USD", toAmount: 0, description: "FX USD/SEK - net in base",
    })
    const id = (await created.json()).id

    const patched = await h.app.request(`/api/portfolios/cash/transactions/${id}`, {
      method: "PATCH",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({ amount: 0, toAmount: 5.12 }),
    })
    expect(patched.status).toBe(200)
    const body = await patched.json()
    // Same-currency legs collapse into one signed amount: the row is a
    // correction of one balance, not two legs.
    expect(Number(body.amount)).toBe(5.12)
    expect(body.toAmount).toBeNull()

    mockInstrumentsFx({ table: { USD: 1, EUR: 1, PLN: 4 }, asOf: "2024-01-01" })
    try {
      const cash = await (await h.app.request(`/api/portfolios/${pf}/cash`, { headers: h.headers })).json()
      expect(cash.balances).toEqual([{ currency: "USD", balance: 5.12 }])
    } finally {
      unmockInstrumentsFx()
    }

    // …but a zero amount on a deposit is still a delete-the-row signal.
    const dep = await post(h, `/api/portfolios/${pf}/cash/deposits`, { amount: 10, currency: "USD" })
    const depId = (await dep.json()).id
    const bad = await h.app.request(`/api/portfolios/cash/transactions/${depId}`, {
      method: "PATCH",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({ amount: 0 }),
    })
    expect(bad.status).toBe(422)
  })

  it("virtual portfolios are read-only for the new kinds", async () => {
    const h = await boot()
    const pf = crypto.randomUUID()
    await h.db.insert(portfolios).values({ userId: "user-1", id: pf, name: "Virtual", baseCurrency: "PLN", isVirtual: true })
    const res = await post(h, `/api/portfolios/${pf}/cash/interest`, { amount: 1 })
    expect(res.status).toBe(409)
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
      expect(cr.currency).toBe("PLN") // the destination leg uses the destination base currency
      expect(Number(d.targetAmount)).toBe(430) // debit leg stores the credit leg it created
      expect(Number(cr.targetAmount)).toBe(-100) // credit leg stores the debit it paired with
    } finally {
      unmockInstrumentsFx()
    }
  })

  it("cash-base-only transfer requires source base currency and credits in the destination base", async () => {
    const h = await boot()
    const src = await makePf(h, "PLN only", "PLN", true)
    const dst = await makePf(h, "USD only", "USD", true)

    const rejected = await post(h, `/api/portfolios/${src}/cash/transfers`, {
      amount: 100,
      currency: "EUR",
      toPortfolioId: dst,
    })
    expect(rejected.status).toBe(422)

    const accepted = await post(h, `/api/portfolios/${src}/cash/transfers`, {
      amount: 100,
      currency: "PLN",
      toPortfolioId: dst,
      targetFxRate: 0.25,
    })
    expect(accepted.status).toBe(201)
    const rows = await h.db.select().from(portfolioCashTransactions).where(eq(portfolioCashTransactions.type, "TRANSFER"))
    const debit = rows.find((r) => Number(r.amount) < 0)!
    const credit = rows.find((r) => Number(r.amount) > 0)!
    expect(debit.currency).toBe("PLN")
    expect(credit.currency).toBe("USD")
    expect(Number(credit.amount)).toBe(25)
    const cash = await (await h.app.request(`/api/portfolios/${dst}/cash`, { headers: h.headers })).json()
    expect(cash.balances).toEqual([{ currency: "USD", balance: 25 }])
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

  it("a conversion's balanceAfter counts both legs (#245)", async () => {
    const h = await boot()
    const pf = await makePf(h, "P1", "USD")
    await h.db.insert(portfolioCashTransactions).values([
      { userId: "user-1", portfolioId: pf, type: "DEPOSIT", amount: "100", currency: "USD", transactionDate: "2024-01-01" },
      {
        userId: "user-1",
        portfolioId: pf,
        type: "FX_CONVERSION",
        amount: "-1000",
        currency: "EUR",
        toCurrency: "USD",
        toAmount: "1100",
        transactionDate: "2024-01-02",
      },
      {
        userId: "user-1",
        portfolioId: pf,
        type: "FX_CONVERSION",
        amount: "-60.5",
        currency: "USD",
        toCurrency: "USD",
        toAmount: null,
        transactionDate: "2024-01-03",
      },
    ])

    const res = await h.app.request(`/api/portfolios/${pf}/cash/transactions`, { headers: h.headers })
    const body = await res.json()
    const [correction, conversion] = body.items
    // The row is reported in the currency of its own leg, and the running sum
    // must carry the received leg too — otherwise the correction below is
    // reported against a balance that never existed.
    expect(correction.balanceAfter).toBe(1139.5) // 100 + 1100 − 60.5
    expect(conversion.balanceAfter).toBe(-1000)

    const cash: { balances: Array<{ currency: string; balance: number }> } =
      await (await h.app.request(`/api/portfolios/${pf}/cash`, { headers: h.headers })).json()
    expect(cash.balances.find((b) => b.currency === "USD")!.balance).toBe(1139.5)
    expect(cash.balances.find((b) => b.currency === "EUR")!.balance).toBe(-1000)
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

  it("PATCH rejects non-base currencies and refuses to edit legacy foreign cash rows", async () => {
    const h = await boot()
    const pf = await makePf(h, "PLN only", "PLN", true)
    const [row] = await h.db
      .insert(portfolioCashTransactions)
      .values({ userId: "user-1", portfolioId: pf, type: "DEPOSIT", amount: "100", currency: "PLN" })
      .returning()

    const foreign = await h.app.request(`/api/portfolios/cash/transactions/${row.id}`, {
      method: "PATCH",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({ currency: "USD" }),
    })
    expect(foreign.status).toBe(422)
    const base = await h.app.request(`/api/portfolios/cash/transactions/${row.id}`, {
      method: "PATCH",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({ currency: "PLN", amount: 125 }),
    })
    expect(base.status).toBe(200)

    const [legacy] = await h.db
      .insert(portfolioCashTransactions)
      .values({ userId: "user-1", portfolioId: pf, type: "DEPOSIT", amount: "10", currency: "EUR" })
      .returning()
    const legacyEdit = await h.app.request(`/api/portfolios/cash/transactions/${legacy.id}`, {
      method: "PATCH",
      headers: { ...h.headers, "content-type": "application/json" },
      body: JSON.stringify({ amount: 20 }),
    })
    expect(legacyEdit.status).toBe(422)
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
