import { describe, expect, it, beforeEach } from "vitest"
import { createTestDb } from "../../db/test-db.js"
import {
  chartEventFacts,
  labels,
  portfolioCashTransactionLabels,
  portfolioCashTransactions,
  portfolios,
  portfolioTransactions,
} from "../../db/schema.js"
import type { DB } from "../../db/index.js"
import { annualContributions, cashBalanceSeriesForScope } from "./cash.js"

let db: DB

const pub = (portfolioId: string, generation = 1) => ({ portfolioId, generation })

async function addPortfolio(name: string) {
  const [row] = await db.insert(portfolios).values({ userId: "user-1", name, baseCurrency: "USD" }).returning({ id: portfolios.id })
  return row.id
}

async function addCash(
  portfolioId: string,
  type: string,
  amount: string,
  transactionDate: string,
  extra: { toPortfolioId?: string } = {},
) {
  await db.insert(portfolioCashTransactions).values({
    userId: "user-1",
    portfolioId,
    type: type as "DEPOSIT",
    amount,
    currency: "USD",
    transactionDate,
    ...extra,
  })
}

async function addBuy(portfolioId: string, price: string, executedAt: string) {
  const [row] = await db.insert(portfolioTransactions).values({
    userId: "user-1",
    portfolioId,
    type: "BUY",
    instrumentSymbol: "AAPL",
    assetType: "STOCK",
    quantity: "1",
    price,
    originalQuantity: "1",
    originalPrice: price,
    currency: "USD",
    exchangeRate: "1",
    totalAmount: price,
    convertedTotalAmount: price,
    feesSettled: "0",
    executedAt: new Date(executedAt),
  }).returning({ id: portfolioTransactions.id })
  return row.id
}

/** Insert an in-kind transfer transaction with the source/link fields the schema requires. */
async function addTransferTx(
  portfolioId: string,
  type: "TRANSFER_OUT" | "TRANSFER_IN",
  amount: string,
  executedAt: string,
  extra: Partial<typeof portfolioTransactions.$inferInsert> = {},
) {
  const [row] = await db
    .insert(portfolioTransactions)
    .values({
      userId: "user-1",
      portfolioId,
      type,
      instrumentSymbol: "AAPL",
      assetType: "STOCK",
      quantity: "1",
      price: amount,
      currency: "USD",
      exchangeRate: "1",
      totalAmount: amount,
      convertedTotalAmount: amount,
      feesSettled: "0",
      executedAt: new Date(executedAt),
      ...extra,
    })
    .returning({ id: portfolioTransactions.id })
  return row.id
}

/** Insert one published funding fact directly; the aggregation under test reads facts, not the ledger. */
async function addFact(
  portfolioId: string,
  receiptKind: string,
  amountBase: string,
  eventDate: string,
  extra: Partial<typeof chartEventFacts.$inferInsert> = {},
) {
  await db.insert(chartEventFacts).values({
    generation: 1,
    portfolioId,
    eventDate,
    receiptKind,
    amountBase,
    amountOriginal: String(Math.abs(Number(amountBase))),
    originalCurrency: "USD",
    standalone: true,
    ...extra,
  })
}

async function addCashTx(portfolioId: string, type: string, amount: string, transactionDate: string) {
  const [row] = await db
    .insert(portfolioCashTransactions)
    .values({
      userId: "user-1",
      portfolioId,
      type: type as "DEPOSIT",
      amount,
      currency: "USD",
      transactionDate,
    })
    .returning({ id: portfolioCashTransactions.id })
  return row.id
}

async function addLabel(name: string) {
  const [row] = await db
    .insert(labels)
    .values({ userId: "user-1", name, color: "#2563eb" })
    .returning({ id: labels.id })
  return row.id
}

beforeEach(async () => {
  ;({ db } = await createTestDb())
})

describe("cashBalanceSeriesForScope", () => {
  it("includes the opening balance before the window (100 − 30 = 70, not −30)", async () => {
    const pf = await addPortfolio("A")
    await addCash(pf, "DEPOSIT", "100", "2026-01-01")
    await addBuy(pf, "30", "2026-02-01T12:00:00Z")

    const out = await cashBalanceSeriesForScope(db, [pub(pf)], {
      from: "2026-02-01",
      to: "2026-02-28",
      displayCurrency: "USD",
      authToken: null,
    })
    const point = out.total.find((p) => p.date === "2026-02-01")
    expect(point?.balance).toBe(70)
    // The total and the single account line agree.
    const account = out.series.find((s) => s.key === pf)
    expect(account?.points.find((p) => p.date === "2026-02-01")?.balance).toBe(70)
  })

  it("keeps negative cash visible", async () => {
    const pf = await addPortfolio("A")
    await addCash(pf, "DEPOSIT", "10", "2026-01-01")
    await addBuy(pf, "30", "2026-02-01T12:00:00Z")

    const out = await cashBalanceSeriesForScope(db, [pub(pf)], {
      from: "2026-02-01",
      to: "2026-02-28",
      displayCurrency: "USD",
      authToken: null,
    })
    expect(out.total.find((p) => p.date === "2026-02-01")?.balance).toBe(-20)
  })

  it("cancels an internal A→B transfer in the combined total", async () => {
    const a = await addPortfolio("A")
    const b = await addPortfolio("B")
    await addCash(a, "DEPOSIT", "100", "2026-01-01")
    await addCash(b, "DEPOSIT", "50", "2026-01-01")
    // A sends 40 to B: A's row is negative, B's row positive.
    await addCash(a, "TRANSFER", "-40", "2026-02-01", { toPortfolioId: b })
    await addCash(b, "TRANSFER", "40", "2026-02-01")

    const out = await cashBalanceSeriesForScope(db, [pub(a), pub(b)], {
      from: "2026-02-01",
      to: "2026-02-28",
      displayCurrency: "USD",
      authToken: null,
    })
    const total = out.total.find((p) => p.date === "2026-02-01")
    // 100 − 40 + 50 + 40 = 150 (unchanged by the internal transfer).
    expect(total?.balance).toBe(150)
    expect(out.series.find((s) => s.key === "total")?.key).toBeUndefined()
    expect(out.series.at(-1)?.label).toBe("Total")
  })

  it("returns nothing for an empty scope", async () => {
    const out = await cashBalanceSeriesForScope(db, [], {
      from: "2026-01-01",
      to: "2026-02-01",
      displayCurrency: "USD",
      authToken: null,
    })
    expect(out).toEqual({ series: [], total: [], currency: "USD" })
  })
})
describe("annualContributions", () => {
  const identity = async (_from: string, amount: number) => amount
  const fixedNow = new Date("2027-01-01T00:00:00Z")

  it("counts deposits minus withdrawals and ignores trade turnover", async () => {
    const pf = await addPortfolio("A")
    await addFact(pf, "contribution", "1000", "2026-01-15")
    await addFact(pf, "withdrawal", "-200", "2026-02-15")
    await addFact(pf, "trade", "9000", "2026-03-01")

    const out = await annualContributions(db, [pub(pf)], { convert: identity, now: fixedNow })

    expect(out).toEqual([
      { year: 2026, contributions: 1000, withdrawals: 200, net: 800, transfers: 0, partial: false, unknown: false },
    ])
  })

  it("cancels internal transfers across the whole scope but exposes a one-sided boundary transfer", async () => {
    const a = await addPortfolio("A")
    const b = await addPortfolio("B")
    await addFact(a, "contribution", "100", "2026-01-01")
    await addFact(b, "contribution", "50", "2026-01-01")
    await addFact(a, "transfer", "-100", "2026-02-01")
    await addFact(b, "transfer", "100", "2026-02-01")

    const both = await annualContributions(db, [pub(a), pub(b)], { convert: identity, now: fixedNow })
    expect(both[0].transfers).toBe(0)
    expect(both[0].net).toBe(150)

    const onlyA = await annualContributions(db, [pub(a)], { convert: identity, now: fixedNow })
    expect(onlyA[0].transfers).toBe(-100)
    expect(onlyA[0].net).toBe(100)
  })

  it("signs in-kind transfer legs by their source transaction type", async () => {
    const a = await addPortfolio("A")
    const b = await addPortfolio("B")
    const source = await addBuy(a, "100", "2026-01-01T00:00:00Z")
    const out = await addTransferTx(a, "TRANSFER_OUT", "100", "2026-02-01T00:00:00Z", { sourceTransactionId: source })
    const into = await addTransferTx(b, "TRANSFER_IN", "100", "2026-02-01T00:00:00Z", { linkedTransferId: out })
    await addFact(a, "transfer", "100", "2026-02-01", { sourceTransactionId: out, standalone: false })
    await addFact(b, "transfer", "100", "2026-02-01", { sourceTransactionId: into, standalone: false })

    const both = await annualContributions(db, [pub(a), pub(b)], { convert: identity, now: fixedNow })
    expect(both[0].transfers).toBe(0)

    const onlyA = await annualContributions(db, [pub(a)], { convert: identity, now: fixedNow })
    expect(onlyA[0].transfers).toBe(-100)
  })

  it("uses standalone cash labels and counts an overlapping label once", async () => {
    const pf = await addPortfolio("A")
    const cash = await addCashTx(pf, "DEPOSIT", "1000", "2026-01-01")
    const other = await addCashTx(pf, "DEPOSIT", "500", "2026-01-02")
    const one = await addLabel("One")
    const two = await addLabel("Two")
    await db.insert(portfolioCashTransactionLabels).values([
      { cashTransactionId: cash, labelId: one },
      { cashTransactionId: cash, labelId: two },
    ])
    await addFact(pf, "contribution", "1000", "2026-01-01", { sourceCashTransactionId: cash })
    await addFact(pf, "contribution", "500", "2026-01-02", { sourceCashTransactionId: other })

    const out = await annualContributions(db, [pub(pf)], {
      convert: identity,
      labelIds: [one, two],
      now: fixedNow,
    })

    expect(out[0].contributions).toBe(1000)
    expect(out[0].net).toBe(1000)
  })

  it("converts each account base into the display currency and marks unknown rates", async () => {
    const pf = await addPortfolio("A")
    await addFact(pf, "contribution", "1000", "2026-01-01")
    await addFact(pf, "withdrawal", "-200", "2026-02-01")

    const converted = await annualContributions(db, [pub(pf)], {
      convert: async (_from, amount) => amount * 4,
      now: fixedNow,
    })
    expect(converted[0].contributions).toBe(4000)
    expect(converted[0].withdrawals).toBe(800)
    expect(converted[0].net).toBe(3200)
    expect(converted[0].unknown).toBe(false)

    const partial = await annualContributions(db, [pub(pf)], {
      convert: async (_from, amount) => (amount === 1000 ? null : amount),
      now: fixedNow,
    })
    expect(partial[0].contributions).toBe(0)
    expect(partial[0].withdrawals).toBe(200)
    expect(partial[0].net).toBe(-200)
    expect(partial[0].unknown).toBe(true)
  })

  it("marks the current calendar year partial and respects the fact window", async () => {
    const pf = await addPortfolio("A")
    await addFact(pf, "contribution", "100", "2025-06-01")
    await addFact(pf, "contribution", "200", "2026-01-15")
    await addFact(pf, "contribution", "300", "2026-07-01")

    const out = await annualContributions(db, [pub(pf)], {
      convert: identity,
      from: "2026-01-01",
      now: new Date("2026-06-15T00:00:00Z"),
    })

    expect(out).toEqual([
      { year: 2026, contributions: 500, withdrawals: 0, net: 500, transfers: 0, partial: true, unknown: false },
    ])
  })

  it("returns nothing for an empty scope", async () => {
    const out = await annualContributions(db, [], { convert: identity, now: fixedNow })
    expect(out).toEqual([])
  })
})
