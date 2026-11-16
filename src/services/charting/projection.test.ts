import { describe, expect, it, beforeEach } from "vitest"
import { randomUUID } from "node:crypto"
import { eq } from "drizzle-orm"
import { createTestDb } from "../../db/test-db.js"
import {
  chartEventFacts,
  chartPositionDaily,
  portfolioCashTransactions,
  portfolioTransactions,
  portfolios,
  positions,
  positionPortfolios,
} from "../../db/schema.js"
import type { DB } from "../../db/index.js"
import { buildChartFacts } from "./projection.js"
import type { PriceBarSeries } from "../backfill.js"

let db: DB

async function addPortfolio(userId: string, name: string) {
  const [row] = await db.insert(portfolios).values({ userId, name, baseCurrency: "USD" }).returning({ id: portfolios.id })
  return row.id
}

async function addPosition(userId: string, portfolioId: string, symbol: string) {
  const [pos] = await db.insert(positions).values({ userId, symbol }).returning({ id: positions.id })
  await db.insert(positionPortfolios).values({ positionId: pos.id, portfolioId })
  return pos.id
}

async function addTx(row: typeof portfolioTransactions.$inferInsert) {
  const [inserted] = await db.insert(portfolioTransactions).values(row).returning()
  return inserted
}

async function addCash(row: typeof portfolioCashTransactions.$inferInsert) {
  await db.insert(portfolioCashTransactions).values(row)
}

function fakeFetcher(series: Record<string, { dates: string[]; closes: number[] }>) {
  return async (symbol: string): Promise<PriceBarSeries | null> => {
    const s = series[symbol]
    if (!s) return null
    return { symbol, dates: s.dates, closes: s.closes, stale: false }
  }
}

beforeEach(async () => {
  ;({ db } = await createTestDb())
})

describe("buildChartFacts", () => {
  it("builds per-position daily value/basis and income/realized facts", async () => {
    const pf = await addPortfolio("user-1", "A")
    const pos = await addPosition("user-1", pf, "AAPL")

    await addTx({ userId: "user-1", portfolioId: pf, positionId: pos, type: "BUY", instrumentSymbol: "AAPL", assetType: "STOCK", quantity: "10", price: "100", currency: "USD", exchangeRate: "1", executedAt: new Date("2026-01-01T00:00:00Z") })
    await addTx({ userId: "user-1", portfolioId: pf, positionId: pos, type: "DIVIDEND", instrumentSymbol: "AAPL", assetType: "STOCK", quantity: "10", price: "0.5", currency: "USD", exchangeRate: "1", executedAt: new Date("2026-01-02T00:00:00Z") })
    await addTx({ userId: "user-1", portfolioId: pf, positionId: pos, type: "SELL", instrumentSymbol: "AAPL", assetType: "STOCK", quantity: "2", price: "120", currency: "USD", exchangeRate: "1", realizedGainLoss: "40", convertedRealizedGainLoss: "40", executedAt: new Date("2026-01-03T00:00:00Z") })

    const fetcher = fakeFetcher({ AAPL: { dates: ["2026-01-01", "2026-01-02", "2026-01-03"], closes: [100, 120, 120] } })

    const res = await buildChartFacts(db, pf, "token", { generation: 1, from: "2026-01-01", to: "2026-01-03", fetcher })
    expect(res.positionRows).toBeGreaterThan(0)

    const facts = await db.select().from(chartPositionDaily).where(eq(chartPositionDaily.generation, 1))
    const byDay = new Map(facts.map((f) => [f.day, f]))
    expect(Number(byDay.get("2026-01-01")!.quantity)).toBe(10)
    expect(Number(byDay.get("2026-01-01")!.value)).toBe(1000)
    expect(Number(byDay.get("2026-01-01")!.remainingBasis)).toBe(1000)
    expect(Number(byDay.get("2026-01-02")!.value)).toBe(1200)
    expect(Number(byDay.get("2026-01-02")!.income)).toBe(5)
    expect(Number(byDay.get("2026-01-03")!.quantity)).toBe(8)
    expect(Number(byDay.get("2026-01-03")!.realizedGain)).toBe(40)
  })

  it("emits normalized income/cash event facts", async () => {
    const pf = await addPortfolio("user-1", "A")
    const pos = await addPosition("user-1", pf, "AAPL")

    await addTx({ userId: "user-1", portfolioId: pf, positionId: pos, type: "DIVIDEND", instrumentSymbol: "AAPL", assetType: "STOCK", quantity: "10", price: "0.5", currency: "USD", exchangeRate: "1", executedAt: new Date("2026-01-02T00:00:00Z") })
    await addCash({ userId: "user-1", portfolioId: pf, type: "DEPOSIT", amount: "1000", currency: "USD", exchangeRate: "1", transactionDate: "2026-01-01" })
    await addCash({ userId: "user-1", portfolioId: pf, type: "INTEREST", amount: "2", currency: "USD", exchangeRate: "1", transactionDate: "2026-01-02" })

    const fetcher = fakeFetcher({})
    await buildChartFacts(db, pf, "token", { generation: 1, from: "2026-01-01", to: "2026-01-03", fetcher })

    const events = await db.select().from(chartEventFacts).where(eq(chartEventFacts.generation, 1))
    const byKind = new Map(events.map((e) => [e.receiptKind, Number(e.amountBase)]))
    expect(byKind.get("dividend")).toBe(5)
    expect(byKind.get("contribution")).toBe(1000)
    expect(byKind.get("interest")).toBe(2)
  })

  it("dates a cash event from created_at when transaction_date is null", async () => {
    const pf = await addPortfolio("user-1", "A")
    await addCash({ userId: "user-1", portfolioId: pf, type: "DEPOSIT", amount: "100", currency: "USD", exchangeRate: "1", transactionDate: null })
    const fetcher = fakeFetcher({})
    await buildChartFacts(db, pf, "token", { generation: 1, fetcher })
    const events = await db.select().from(chartEventFacts).where(eq(chartEventFacts.generation, 1))
    expect(events).toHaveLength(1)
    expect(events[0].eventDate).toBe(new Date().toISOString().slice(0, 10))
  })

  it("is idempotent: a re-run replaces the same generation", async () => {
    const pf = await addPortfolio("user-1", "A")
    await addCash({ userId: "user-1", portfolioId: pf, type: "DEPOSIT", amount: "1000", currency: "USD", exchangeRate: "1", transactionDate: "2026-01-01" })
    const fetcher = fakeFetcher({})

    await buildChartFacts(db, pf, "token", { generation: 1, from: "2026-01-01", to: "2026-01-02", fetcher })
    await buildChartFacts(db, pf, "token", { generation: 1, from: "2026-01-01", to: "2026-01-02", fetcher })

    const events = await db.select().from(chartEventFacts).where(eq(chartEventFacts.generation, 1))
    expect(events).toHaveLength(1)
  })

  it("does not mix a foreign position's facts into another portfolio", async () => {
    const pf1 = await addPortfolio("user-1", "A")
    const pf2 = await addPortfolio("user-1", "B")
    const pos1 = await addPosition("user-1", pf1, "AAPL")
    const pos2 = await addPosition("user-1", pf2, "AAPL")

    await addTx({ userId: "user-1", portfolioId: pf1, positionId: pos1, type: "BUY", instrumentSymbol: "AAPL", assetType: "STOCK", quantity: "10", price: "100", currency: "USD", exchangeRate: "1", executedAt: new Date("2026-01-01T00:00:00Z") })
    await addTx({ userId: "user-1", portfolioId: pf2, positionId: pos2, type: "BUY", instrumentSymbol: "AAPL", assetType: "STOCK", quantity: "20", price: "100", currency: "USD", exchangeRate: "1", executedAt: new Date("2026-01-01T00:00:00Z") })

    const fetcher = fakeFetcher({ AAPL: { dates: ["2026-01-01", "2026-01-02"], closes: [100, 100] } })
    await buildChartFacts(db, pf1, "token", { generation: 1, from: "2026-01-01", to: "2026-01-02", fetcher })

    const facts = await db.select().from(chartPositionDaily).where(eq(chartPositionDaily.generation, 1))
    expect(facts).toHaveLength(2)
    expect(facts.every((f) => f.portfolioId === pf1)).toBe(true)
    expect(Number(facts[0].quantity)).toBe(10)
  })

  it("replays in-kind transfers as quantity moves and never as income", async () => {
    const pf = await addPortfolio("user-1", "A")
    const pos = await addPosition("user-1", pf, "AAPL")

    const buy = await addTx({ userId: "user-1", portfolioId: pf, positionId: pos, type: "BUY", instrumentSymbol: "AAPL", assetType: "STOCK", quantity: "10", price: "100", currency: "USD", exchangeRate: "1", executedAt: new Date("2026-01-01T00:00:00Z") })
    const transferGroupId = randomUUID()
    const transferOut = await addTx({ userId: "user-1", portfolioId: pf, positionId: pos, type: "TRANSFER_OUT", instrumentSymbol: "AAPL", assetType: "STOCK", quantity: "3", price: "120", currency: "USD", exchangeRate: "1", sourceTransactionId: buy.id, transferGroupId, executedAt: new Date("2026-01-03T00:00:00Z") })
    await addTx({ userId: "user-1", portfolioId: pf, positionId: pos, type: "TRANSFER_IN", instrumentSymbol: "AAPL", assetType: "STOCK", quantity: "5", price: "100", currency: "USD", exchangeRate: "1", linkedTransferId: transferOut.id, transferGroupId, executedAt: new Date("2026-01-02T00:00:00Z") })

    const fetcher = fakeFetcher({ AAPL: { dates: ["2026-01-01", "2026-01-02", "2026-01-03"], closes: [100, 100, 100] } })
    await buildChartFacts(db, pf, "token", { generation: 1, from: "2026-01-01", to: "2026-01-03", fetcher })

    const facts = await db.select().from(chartPositionDaily).where(eq(chartPositionDaily.generation, 1))
    const byDay = new Map(facts.map((f) => [f.day, f]))
    expect(Number(byDay.get("2026-01-01")!.quantity)).toBe(10)
    expect(Number(byDay.get("2026-01-02")!.quantity)).toBe(15)
    expect(Number(byDay.get("2026-01-03")!.quantity)).toBe(12)
    // Basis follows the transfer legs at their own prices: 1000 + 500 - 360.
    expect(Number(byDay.get("2026-01-03")!.remainingBasis)).toBe(1140)

    const events = await db.select().from(chartEventFacts).where(eq(chartEventFacts.generation, 1))
    expect(events.filter((e) => e.receiptKind === "transfer")).toHaveLength(2)
    // A transfer is not income and must never become a dividend/interest row.
    expect(events.some((e) => e.receiptKind === "dividend" || e.receiptKind === "interest")).toBe(false)
  })

  it("uses the converted total for a trade with a third-currency fee and emits no fee event", async () => {
    const pf = await addPortfolio("user-1", "A")
    const pos = await addPosition("user-1", pf, "AAPL")

    // Execution in EUR, instrument quoted in USD, fee settled in PLN: the fact's
    // base-currency amount is the stored converted total, and the fee is not a
    // separate chart event.
    await addTx({
      userId: "user-1", portfolioId: pf, positionId: pos, type: "BUY",
      instrumentSymbol: "AAPL", assetType: "STOCK", quantity: "10", price: "100",
      currency: "EUR", instrumentCurrency: "USD", exchangeRate: "1.1",
      fees: "5", feeCurrency: "PLN", totalAmount: "1100", convertedTotalAmount: "1105",
      executedAt: new Date("2026-01-01T00:00:00Z"),
    })

    await buildChartFacts(db, pf, "token", { generation: 1, from: "2026-01-01", to: "2026-01-02", fetcher: fakeFetcher({}) })

    const events = await db.select().from(chartEventFacts).where(eq(chartEventFacts.generation, 1))
    expect(events).toHaveLength(1)
    expect(events[0].receiptKind).toBe("trade")
    expect(Number(events[0].amountBase)).toBe(1105)

    // The position basis is quantity x price x rate — the fee is not capital.
    const [fact] = await db.select().from(chartPositionDaily).where(eq(chartPositionDaily.generation, 1))
    expect(Number(fact.remainingBasis)).toBe(1100)
  })

  it("falls back to rate 1 when the FX rate is zero or missing", async () => {
    const pf = await addPortfolio("user-1", "A")
    const pos = await addPosition("user-1", pf, "AAPL")

    await addTx({ userId: "user-1", portfolioId: pf, positionId: pos, type: "BUY", instrumentSymbol: "AAPL", assetType: "STOCK", quantity: "10", price: "100", currency: "USD", exchangeRate: "0", executedAt: new Date("2026-01-01T00:00:00Z") })
    await addTx({ userId: "user-1", portfolioId: pf, positionId: pos, type: "BUY", instrumentSymbol: "AAPL", assetType: "STOCK", quantity: "5", price: "100", currency: "USD", exchangeRate: null, executedAt: new Date("2026-01-01T00:00:00Z") })
    await addCash({ userId: "user-1", portfolioId: pf, type: "DEPOSIT", amount: "1000", currency: "USD", exchangeRate: null, transactionDate: "2026-01-01" })

    await buildChartFacts(db, pf, "token", { generation: 1, from: "2026-01-01", to: "2026-01-01", fetcher: fakeFetcher({}) })

    const [fact] = await db.select().from(chartPositionDaily).where(eq(chartPositionDaily.generation, 1))
    expect(Number(fact.quantity)).toBe(15)
    expect(Number(fact.remainingBasis)).toBe(1500)

    const events = await db.select().from(chartEventFacts).where(eq(chartEventFacts.generation, 1))
    const tradeTotal = events.filter((e) => e.receiptKind === "trade").reduce((s, e) => s + Number(e.amountBase), 0)
    expect(tradeTotal).toBe(1500)
    const contribution = events.filter((e) => e.receiptKind === "contribution").reduce((s, e) => s + Number(e.amountBase), 0)
    expect(contribution).toBe(1000)
  })

  it("carries the previous close into a window that starts on a non-trading day", async () => {
    const pf = await addPortfolio("user-1", "A")
    const pos = await addPosition("user-1", pf, "AAPL")
    await addTx({ userId: "user-1", portfolioId: pf, positionId: pos, type: "BUY", instrumentSymbol: "AAPL", assetType: "STOCK", quantity: "10", price: "100", currency: "USD", exchangeRate: "1", executedAt: new Date("2026-01-01T00:00:00Z") })

    // A weekend/holiday tail: the source has no bar inside [from, to] but returns
    // the previous close when asked (includePrevious). Without it the rebuild
    // would write value 0 for both days — the bug that emptied the last two days
    // of the production chart.
    const fetcher = async (
      symbol: string,
      _from: string,
      _to: string,
      _authToken: string,
      _signal?: AbortSignal,
      _currency?: string,
      _baseCcy?: string,
      includePrevious?: boolean,
    ): Promise<PriceBarSeries | null> =>
      includePrevious
        ? { symbol, dates: ["2025-12-31"], closes: [100], stale: false }
        : { symbol, dates: [], closes: [], stale: false }

    await buildChartFacts(db, pf, "token", { generation: 1, from: "2026-01-01", to: "2026-01-02", fetcher })

    const rows = await db.select().from(chartPositionDaily).where(eq(chartPositionDaily.generation, 1))
    expect(rows).toHaveLength(2)
    expect(Number(rows[0].value)).toBe(1000)
    // A carried close is still a known price; `carriedForward` is what marks it
    // as reused rather than a real bar for that day.
    expect(rows[0].priceKnown).toBe(true)
    expect(rows[0].carriedForward).toBe(true)
  })

  it("restates from transactions dated before the window and reflects a backdated edit or delete", async () => {
    const pf = await addPortfolio("user-1", "A")
    const pos = await addPosition("user-1", pf, "AAPL")

    const january = await addTx({ userId: "user-1", portfolioId: pf, positionId: pos, type: "BUY", instrumentSymbol: "AAPL", assetType: "STOCK", quantity: "10", price: "100", currency: "USD", exchangeRate: "1", executedAt: new Date("2026-01-01T00:00:00Z") })
    await addTx({ userId: "user-1", portfolioId: pf, positionId: pos, type: "BUY", instrumentSymbol: "AAPL", assetType: "STOCK", quantity: "5", price: "100", currency: "USD", exchangeRate: "1", executedAt: new Date("2026-02-01T00:00:00Z") })

    const fetcher = fakeFetcher({ AAPL: { dates: ["2026-02-01", "2026-02-02"], closes: [100, 100] } })
    await buildChartFacts(db, pf, "token", { generation: 1, from: "2026-02-01", to: "2026-02-02", fetcher })

    const factsFor = async () => {
      const rows = await db.select().from(chartPositionDaily).where(eq(chartPositionDaily.generation, 1))
      return rows.filter((r) => r.day === "2026-02-01")
    }
    // The January buy is outside the window but still part of the open quantity:
    // a window is a reporting slice, not a fresh start.
    expect(Number((await factsFor())[0].quantity)).toBe(15)
    const events = await db.select().from(chartEventFacts).where(eq(chartEventFacts.generation, 1))
    expect(events.map((e) => e.eventDate)).toEqual(["2026-02-01"])

    // A backdated edit restates the facts that include the edited day.
    await db.update(portfolioTransactions).set({ quantity: "4" }).where(eq(portfolioTransactions.id, january.id))
    await buildChartFacts(db, pf, "token", { generation: 1, from: "2026-02-01", to: "2026-02-02", fetcher })
    expect(Number((await factsFor())[0].quantity)).toBe(9)

    // So does deleting it: the projection replays the ledger on every build.
    await db.delete(portfolioTransactions).where(eq(portfolioTransactions.id, january.id))
    await buildChartFacts(db, pf, "token", { generation: 1, from: "2026-02-01", to: "2026-02-02", fetcher })
    expect(Number((await factsFor())[0].quantity)).toBe(5)
  })
})