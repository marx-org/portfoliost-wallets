import { describe, expect, it, beforeEach } from "vitest"
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
  await db.insert(portfolioTransactions).values(row)
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
})