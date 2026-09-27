import { afterEach, beforeEach, describe, expect, it } from "vitest"
import crypto from "node:crypto"
import { makeHarness, type Harness } from "../routes/test-utils.js"
import { portfolios, portfolioTransactions, portfolioCashTransactions } from "../db/schema.js"
import { mockInstrumentsFx, unmockInstrumentsFx } from "../test-fx-mock.js"
import { crossRate } from "@marx2/contracts/fx"
import {
  tradeCashEffects,
  cashBalances,
  cashBalanceSeries,
  dailyExternalFlows,
} from "./cashLedger.js"

beforeEach(() => mockInstrumentsFx({ table: { USD: 1.08, EUR: 1.08, PLN: 4.3 }, asOf: "2024-12-31" }))
afterEach(() => unmockInstrumentsFx())

let h: Harness
let userId = "user-1"
let portfolioId: string

async function seedPortfolio() {
  portfolioId = crypto.randomUUID()
  await h.db.insert(portfolios).values({ userId, id: portfolioId, name: "P", baseCurrency: "PLN" })
}

async function trade(row: {
  type: "BUY" | "SELL" | "DIVIDEND"
  totalAmount: string | number
  feesSettled?: string | number
  currency: string
  feeCurrency?: string
  executedAt: string
}) {
  await h.db.insert(portfolioTransactions).values({
    userId,
    portfolioId,
    type: row.type,
    instrumentSymbol: "AAPL",
    currency: row.currency,
    feeCurrency: row.feeCurrency,
    totalAmount: String(row.totalAmount),
    feesSettled: row.feesSettled != null ? String(row.feesSettled) : null,
    executedAt: new Date(row.executedAt),
  })
}

async function ext(row: {
  type: "DEPOSIT" | "WITHDRAWAL" | "TRANSFER"
  amount: string | number
  currency: string
  transactionDate: string
}) {
  await h.db.insert(portfolioCashTransactions).values({
    userId,
    portfolioId,
    type: row.type,
    amount: String(row.amount),
    currency: row.currency,
    transactionDate: row.transactionDate,
  })
}

describe("tradeCashEffects (pure)", () => {
  it("BUY debits both the principal and the fee (a fee is a cost)", () => {
    const m = tradeCashEffects({ type: "BUY", totalAmount: 1000, feesSettled: 10, currency: "USD" })
    // principal −1000 + fee −10, same ccy → net −1010
    expect(m.get("USD")).toBeCloseTo(-1010)
    expect(m.size).toBe(1)
  })

  it("BUY with a fee in a different currency keeps both legs", () => {
    const m = tradeCashEffects({ type: "BUY", totalAmount: 1000, feesSettled: 10, currency: "USD", feeCurrency: "EUR" })
    expect(m.get("USD")).toBeCloseTo(-1000)
    expect(m.get("EUR")).toBeCloseTo(-10)
  })

  it("SELL credits the principal and debits the fee leg", () => {
    const m = tradeCashEffects({ type: "SELL", totalAmount: 1200, feesSettled: 5, currency: "USD" })
    expect(m.get("USD")).toBeCloseTo(1195)
  })

  it("DIVIDEND credits net (totalAmount is net of tax, §49) and debits the fee", () => {
    const m = tradeCashEffects({ type: "DIVIDEND", totalAmount: 225.48, feesSettled: 0, currency: "EUR" })
    expect(m.get("EUR")).toBeCloseTo(225.48)
  })

  it("empty notional + fee → empty map", () => {
    expect(tradeCashEffects({ type: "BUY", totalAmount: 0, feesSettled: 0, currency: "USD" }).size).toBe(0)
  })
})

describe("cashBalances", () => {
  beforeEach(async () => {
    h = await makeHarness()
    await seedPortfolio()
  })

  it("replays trade + external effects per currency", async () => {
    await trade({ type: "BUY", totalAmount: 1000, feesSettled: 10, currency: "USD", executedAt: "2024-01-15T10:00:00.000Z" })
    await trade({ type: "SELL", totalAmount: 480, feesSettled: 4, currency: "USD", executedAt: "2024-02-15T10:00:00.000Z" })
    await ext({ type: "DEPOSIT", amount: 500, currency: "USD", transactionDate: "2024-01-01" })

    const b = await cashBalances(h.db, null, portfolioId)
    // BUY −1010 + SELL +476 + DEPOSIT +500 = −34
    expect(b.get("USD")).toBeCloseTo(-34)
  })

  it("isolate: no rows → empty map", async () => {
    const b = await cashBalances(h.db, null, portfolioId)
    expect(b.size).toBe(0)
  })

  it("asOf cuts off later rows", async () => {
    await ext({ type: "DEPOSIT", amount: 100, currency: "USD", transactionDate: "2024-01-01" })
    await ext({ type: "DEPOSIT", amount: 200, currency: "USD", transactionDate: "2024-06-01" })

    const b = await cashBalances(h.db, null, portfolioId, "2024-03-31")
    expect(b.get("USD")).toBeCloseTo(100)
  })
})

describe("cashBalanceSeries", () => {
  beforeEach(async () => {
    h = await makeHarness()
    await seedPortfolio()
  })

  it("carries forward per-day base totals with FX", async () => {
    // 1000 USD deposited 2024-01-01, base PLN (USD→PLN = 4.3/1.08)
    await ext({ type: "DEPOSIT", amount: 1000, currency: "USD", transactionDate: "2024-01-01" })
    const usdPln = 4.3 / 1.08

    const s = await cashBalanceSeries(h.db, null, portfolioId, "2024-01-01", "2024-01-05", "PLN")
    expect(s.get("2024-01-01")).toBeCloseTo(1000 * usdPln, 4)
    // carried forward unchanged on later days
    expect(s.get("2024-01-05")).toBeCloseTo(1000 * usdPln, 4)
    // contiguous
    expect([...s.keys()]).toHaveLength(5)
  })

  it("base currency is 1:1", async () => {
    await ext({ type: "DEPOSIT", amount: 500, currency: "PLN", transactionDate: "2024-01-02" })
    const s = await cashBalanceSeries(h.db, null, portfolioId, "2024-01-01", "2024-01-03", "PLN")
    expect(s.get("2024-01-01")).toBe(0)
    expect(s.get("2024-01-02")).toBeCloseTo(500)
  })

  it("empty window → empty map", async () => {
    const s = await cashBalanceSeries(h.db, null, portfolioId, "2024-02-01", "2024-01-01", "PLN")
    expect(s.size).toBe(0)
  })
})

describe("dailyExternalFlows", () => {
  beforeEach(async () => {
    h = await makeHarness()
    await seedPortfolio()
  })

  it("sums external rows in base currency per day; trades are not flows", async () => {
    await trade({ type: "BUY", totalAmount: 1000, currency: "USD", executedAt: "2024-01-01T10:00:00.000Z" })
    await ext({ type: "DEPOSIT", amount: 1000, currency: "USD", transactionDate: "2024-01-01" })
    await ext({ type: "WITHDRAWAL", amount: -200, currency: "USD", transactionDate: "2024-01-01" })

    const usdPln = 4.3 / 1.08
    const f = await dailyExternalFlows(h.db, null, portfolioId, "2024-01-01", "2024-01-31", "PLN")
    // (1000 − 200) USD → base; the BUY trade contributes nothing
    expect(f.get("2024-01-01")).toBeCloseTo(800 * usdPln, 4)
    expect(f.size).toBe(1)
  })

  it("empty rows → empty map", async () => {
    const f = await dailyExternalFlows(h.db, null, portfolioId, "2024-01-01", "2024-01-31", "PLN")
    expect(f.size).toBe(0)
  })
})

/**
 * §66.4 — both cash-ledger conversions inlined
 * `(...)?.rate ?? 1`, which degraded a missing FX rate to 1:1 while accepting
 * and then IGNORING the `opts` they were handed. So a multi-currency portfolio's
 * cash balance and its "money actually put in" could each be wrong by an FX
 * factor with nothing logged — even on the historical backfill, which explicitly
 * asks for strict.
 */
describe("§66.4: cash-ledger FX respects opts.strict", () => {
  const prevUrl = process.env.INSTRUMENTS_URL

  beforeEach(async () => {
    // only EUR is known, so every USD>PLN cross-rate 404s
    mockInstrumentsFx({ table: {} })
    h = await makeHarness()
    await seedPortfolio()
  })
  afterEach(() => {
    if (prevUrl === undefined) delete process.env.INSTRUMENTS_URL
    else process.env.INSTRUMENTS_URL = prevUrl
  })

  async function depositUsd() {
    await h.db.insert(portfolioCashTransactions).values({
      userId, portfolioId, type: "DEPOSIT", amount: "100", currency: "USD",
      transactionDate: "2024-06-01",
    })
  }

  it("strict: an unresolvable pair throws instead of silently becoming 1:1", async () => {
    await depositUsd()
    // the base is PLN and the row is USD, with no USD>PLN rate available
    await expect(
      dailyExternalFlows(h.db, null, portfolioId, "2024-01-01", "2024-12-31", "PLN", { strict: true }),
    ).rejects.toThrow()
  })

  it("non-strict: an unresolvable pair degrades to 1:1 and does not throw", async () => {
    await depositUsd()
    const flows = await dailyExternalFlows(h.db, null, portfolioId, "2024-01-01", "2024-12-31", "PLN")
    expect(flows.get("2024-06-01")).toBe(100) // left unconverted, by design
  })

  it("a resolvable pair is converted and never degraded", async () => {
    // both legs of the cross must exist; the expectation is derived from the same
    // table via the same contract helper the mock uses, so it cannot encode a
    // wrong rate convention
    const table = { USD: 1.08, PLN: 4.3 }
    mockInstrumentsFx({ table })
    await depositUsd()
    const rate = crossRate("USD", "PLN", { EUR: 1, ...table })
    if (rate === undefined) throw new Error("test table cannot resolve USD>PLN")
    const flows = await dailyExternalFlows(h.db, null, portfolioId, "2024-01-01", "2024-12-31", "PLN", { strict: true })
    expect(flows.get("2024-06-01")).toBeCloseTo(100 * rate, 6)
  })
})
