import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
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
  externalCashInvested,
} from "./cashLedger.js"

beforeEach(() => mockInstrumentsFx({ table: { USD: 1.08, EUR: 1.08, PLN: 4.3 }, asOf: "2024-12-31" }))
afterEach(() => unmockInstrumentsFx())

let h: Harness
let userId = "user-1"
let portfolioId: string
let other = ""

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

/**
 * §68.2 — Total Invested is cash inflow / outflow / TRANSFER, confirmed by the
 * user. `externalCashInvested` already summed every cash row with no type
 * filter, so the definition needed no code change — but the honest consequence
 * did need asserting, because it is easy to believe the number is "capital you
 * put in" when it is not.
 *
 * The route-level counterpart of this lives in portfolio-transactions.test.ts.
 * It is here instead because /total-metrics reads the DENORMALIZED
 * portfolios.total_integrested column, not this function, so a route test would
 * have been asserting the column rather than the basis the contract names.
 */
describe("§68.2: externalCashInvested counts transfers, and they net to zero", () => {
  beforeEach(async () => {
    mockInstrumentsFx({ table: { USD: 1.08, PLN: 4.3 } })
    h = await makeHarness()
    await seedPortfolio()
  })

  async function row(type: "DEPOSIT" | "WITHDRAWAL" | "TRANSFER", amount: string, date = "2024-06-01") {
    await h.db.insert(portfolioCashTransactions).values({
      userId, portfolioId, type, amount, currency: "PLN", transactionDate: date,
    })
  }

  it("deposits and withdrawals net; the sign lives in `amount`", async () => {
    await row("DEPOSIT", "1000")
    await row("WITHDRAWAL", "-400")
    const v = await externalCashInvested(h.db, null, portfolioId, "PLN")
    expect(v).toBe(600)
  })

  it("a transfer leg counts, which is what the user asked for", async () => {
    await row("DEPOSIT", "1000")
    await row("TRANSFER", "250")
    const v = await externalCashInvested(h.db, null, portfolioId, "PLN")
    expect(v).toBe(1250)
  })

  it("the two legs of an internal transfer net to zero at the aggregate", async () => {
    const other = crypto.randomUUID()
    await h.db.insert(portfolios).values({ userId, id: other, name: "To", baseCurrency: "PLN" })
    await row("DEPOSIT", "1000")
    await h.db.insert(portfolioCashTransactions).values({
      userId, portfolioId: other, type: "DEPOSIT", amount: "1000", currency: "PLN", transactionDate: "2024-06-01",
    })
    await row("TRANSFER", "-400") // out of this portfolio...
    await h.db.insert(portfolioCashTransactions).values({
      userId, portfolioId: other, type: "TRANSFER", amount: "400", currency: "PLN", transactionDate: "2024-06-01",
    })
    const from = await externalCashInvested(h.db, null, portfolioId, "PLN")
    const to = await externalCashInvested(h.db, null, other, "PLN")
    expect(from).toBe(600)
    expect(to).toBe(1400)
    // ...and the aggregate is untouched, because the legs cancel. This is exactly
    // the caveat the contract description states rather than hides.
    expect(from + to).toBe(2000)
  })
})

/**
 * §71 — the two cash replays disagreeing on PROD was undebuggable because
 * neither narrated itself; reconciling them meant hand-written `psql` queries
 * that were lossy and gone by the next investigation. These lock the contract
 * that the logs answer the question: with `RECALC_DEBUG=1` on, both replays
 * report their per-currency inputs AND the FX rate each leg was converted at,
 * and with it off they stay silent.
 */
describe("RECALC_DEBUG cash replay logging", () => {
  let logs: string[]
  let spy: ReturnType<typeof vi.spyOn>

  beforeEach(async () => {
    h = await makeHarness()
    await seedPortfolio()
    logs = []
    spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "))
    })
  })

  afterEach(() => {
    spy.mockRestore()
    delete process.env.RECALC_DEBUG
  })

  it("narrates both replays with per-currency balances and the rates used", async () => {
    process.env.RECALC_DEBUG = "1"
    await ext({ type: "DEPOSIT", amount: 1000, currency: "PLN", transactionDate: "2024-06-01" })
    await ext({ type: "DEPOSIT", amount: 500, currency: "USD", transactionDate: "2024-06-01" })
    await trade({ type: "BUY", totalAmount: 200, feesSettled: 5, currency: "USD", executedAt: "2024-06-02T10:00:00.000Z" })

    await cashBalances(h.db, null, portfolioId)
    await cashBalanceSeries(h.db, null, portfolioId, "2024-06-01", "2024-06-02", "PLN")
    await externalCashInvested(h.db, null, portfolioId, "PLN")

    // the live/as-of path: row counts + the per-currency result
    expect(logs).toContainEqual(expect.stringContaining("cash-balances"))
    expect(logs.some((l) => l.includes("cash-balances") && l.includes("PLN 1000.00") && l.includes("USD 295.00"))).toBe(true)
    // the historical path: the rate each leg was converted at, and the total
    expect(logs.some((l) => l.includes("cash-balance-series") && l.includes("day=2024-06-02") && l.includes("PLN 1000.00@1.000000"))).toBe(true)
    // "money actually put in", grouped per currency
    expect(logs.some((l) => l.includes("cash-invested") && l.includes("PLN 1000.00") && l.includes("USD 500.00"))).toBe(true)
  })

  it("stays silent by default", async () => {
    await ext({ type: "DEPOSIT", amount: 1000, currency: "PLN", transactionDate: "2024-06-01" })
    await cashBalances(h.db, null, portfolioId)
    await cashBalanceSeries(h.db, null, portfolioId, "2024-06-01", "2024-06-01", "PLN")
    await externalCashInvested(h.db, null, portfolioId, "PLN")
    expect(logs).toEqual([])
  })
})


/**
 * #43 — a **cash** transfer, as opposed to an in-kind stock transfer.
 *
 * Owner model, event 3: a cash transfer behaves like a deposit/withdrawal. It moves
 * **both** quantities — the cash BALANCE and the deposit/withdrawal flows — in **both**
 * accounts, with opposite signs.
 *
 * This was marked UNVERIFIED rather than correct in the #41 audit, and the reason is
 * visible in this file: the §68.2 block already exercised `TRANSFER` cash rows, but only
 * against `externalCashInvested` (the flows). Nothing covered `cashBalances` for a
 * `TRANSFER` row at all, so half the claim rested on reading the code.
 *
 * That asymmetry is not an accident of coverage. `cashBalances` is the quantity that
 * `totalValue` depends on, so a regression here silently moves the headline valuation.
 */
describe("#43: a cash transfer moves the balance AND the flows, in both accounts", () => {
  beforeEach(async () => {
    h = await makeHarness()
    await seedPortfolio()
    other = crypto.randomUUID()
    await h.db.insert(portfolios).values({ userId, id: other, name: "To", baseCurrency: "PLN" })
    // A matched pair: 400 out of `portfolioId`, 400 into `other`.
    await h.db.insert(portfolioCashTransactions).values({
      userId, portfolioId, type: "TRANSFER", amount: "-400", currency: "PLN", transactionDate: "2024-06-01",
    })
    await h.db.insert(portfolioCashTransactions).values({
      userId, portfolioId: other, type: "TRANSFER", amount: "400", currency: "PLN", transactionDate: "2024-06-01",
    })
  })

  it("moves the sender's cash BALANCE", async () => {
    expect((await cashBalances(h.db, null, portfolioId)).get("PLN")).toBeCloseTo(-400)
  })

  it("moves the receiver's cash BALANCE the other way", async () => {
    expect((await cashBalances(h.db, null, other)).get("PLN")).toBeCloseTo(400)
  })

  it("moves the sender's flows", async () => {
    expect(await externalCashInvested(h.db, null, portfolioId, "PLN")).toBeCloseTo(-400)
  })

  it("moves the receiver's flows", async () => {
    expect(await externalCashInvested(h.db, null, other, "PLN")).toBeCloseTo(400)
  })

  /**
   * The consequence that makes this worth asserting at all: the pair nets to zero in
   * BOTH quantities. A regression that hits one leg, or hits the balance but not the
   * flows, leaves each quantity individually plausible while the aggregate still
   * balances — so asserting only the legs would pass. `/merged` is built on that
   * cancellation, and #37's bug lived precisely in the gap between the two quantities.
   */
  it("both legs cancel in the balance AND in the flows", async () => {
    const bal = async (id: string) => (await cashBalances(h.db, null, id)).get("PLN") ?? 0
    expect((await bal(portfolioId)) + (await bal(other))).toBeCloseTo(0)
    expect(
      (await externalCashInvested(h.db, null, portfolioId, "PLN")) +
        (await externalCashInvested(h.db, null, other, "PLN")),
    ).toBeCloseTo(0)
  })

  /**
   * The distinction from an in-kind transfer, which is the whole reason there are two
   * quantities. A stock transfer moves the FLOWS and not the BALANCE; a cash transfer
   * moves both. Each can be wrong in the opposite direction, and `/merged` balances in
   * either case, so nothing aggregate would reveal the confusion — which is how #38's
   * double count survived a 307k PLN reconciliation delta.
   */
  it("an in-kind stock transfer moves the basis but NOT the balance", async () => {
    const { capitalBasisInvested } = await import("./transferFlows.js")
    const stock = crypto.randomUUID()
    await h.db.insert(portfolios).values({ userId, id: stock, name: "Stock", baseCurrency: "PLN" })
    // A TRANSFER_OUT with its mandatory source id, and deliberately NO cash row.
    await h.db.insert(portfolioTransactions).values({
      userId, portfolioId: stock, type: "TRANSFER_OUT", instrumentSymbol: "X",
      quantity: "2", price: "150", currency: "PLN", instrumentCurrency: "PLN",
      totalAmount: "300", executedAt: new Date("2024-06-01T10:00:00Z"),
      sourceTransactionId: crypto.randomUUID(),
    })

    // Balance: untouched — stock changing custody moves no money.
    expect((await cashBalances(h.db, null, stock)).get("PLN")).toBeUndefined()
    // Flows: moved, at COST (300), which is what capitalBasisInvested reports.
    expect(await capitalBasisInvested(h.db, null, stock, "PLN")).toBeCloseTo(-300)
    // And the genuinely-external figure still does not see it — the three-way split.
    expect(await externalCashInvested(h.db, null, stock, "PLN")).toBeCloseTo(0)
  })
})
