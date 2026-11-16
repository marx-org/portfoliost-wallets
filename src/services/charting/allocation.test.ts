import { describe, expect, it, beforeEach } from "vitest"
import { createTestDb } from "../../db/test-db.js"
import {
  chartPositionDaily,
  portfolios,
  positions,
  positionPortfolios,
  stockChartCategories,
} from "../../db/schema.js"
import type { DB } from "../../db/index.js"
import { allocationByStockCategory } from "./allocation.js"

let db: DB

async function addPortfolio(name: string) {
  const [row] = await db
    .insert(portfolios)
    .values({ userId: "user-1", name, baseCurrency: "USD" })
    .returning({ id: portfolios.id })
  return row.id
}

async function addPosition(
  portfolioId: string,
  symbol: string,
  opts: { assetType?: string; instrumentCurrency?: string } = {},
) {
  const [pos] = await db
    .insert(positions)
    .values({
      userId: "user-1",
      symbol,
      assetType: opts.assetType ?? "STOCK",
      instrumentCurrency: opts.instrumentCurrency ?? "USD",
    })
    .returning({ id: positions.id })
  await db.insert(positionPortfolios).values({ positionId: pos.id, portfolioId })
  return pos.id
}

async function addFact(portfolioId: string, positionId: string, day: string, value: string, generation = 1) {
  await db.insert(chartPositionDaily).values({ generation, portfolioId, positionId, day, value, quantity: "1" })
}

async function assign(symbol: string, category: string, instrumentCurrency = "USD", userId = "user-1") {
  await db.insert(stockChartCategories).values({ userId, symbol, category, instrumentCurrency })
}

const pub = (portfolioId: string, generation = 1) => ({ portfolioId, generation })

beforeEach(async () => {
  ;({ db } = await createTestDb())
})

describe("allocationByStockCategory", () => {
  it("weights the categories by market value, not by stock count", async () => {
    const pf = await addPortfolio("A")
    const aapl = await addPosition(pf, "AAPL")
    const msft = await addPosition(pf, "MSFT")
    await assign("AAPL", "balanced")
    await assign("MSFT", "high_yield")
    await addFact(pf, aapl, "2026-01-02", "90")
    await addFact(pf, msft, "2026-01-02", "10")

    const out = await allocationByStockCategory(db, "user-1", [pub(pf)])
    expect(out.total).toBe(100)
    expect(out.slices).toEqual([
      { key: "balanced", value: 90 },
      { key: "high_yield", value: 10 },
    ])
  })

  it("puts an unassigned stock in not_classified instead of dropping it", async () => {
    const pf = await addPortfolio("A")
    const aapl = await addPosition(pf, "AAPL")
    const nvda = await addPosition(pf, "NVDA")
    await assign("AAPL", "balanced")
    await addFact(pf, aapl, "2026-01-02", "90")
    await addFact(pf, nvda, "2026-01-02", "10")

    const out = await allocationByStockCategory(db, "user-1", [pub(pf)])
    expect(out.slices).toEqual([
      { key: "balanced", value: 90 },
      { key: "not_classified", value: 10 },
    ])
  })

  it("excludes bonds and derivatives from the category denominator and never lets an option inherit the equity's category", async () => {
    const pf = await addPortfolio("A")
    const aapl = await addPosition(pf, "AAPL")
    const bond = await addPosition(pf, "BND", { assetType: "BOND" })
    const option = await addPosition(pf, "AAPL", { assetType: "OPTION" })
    await assign("AAPL", "balanced")
    await addFact(pf, aapl, "2026-01-02", "90")
    await addFact(pf, bond, "2026-01-02", "1000")
    await addFact(pf, option, "2026-01-02", "50")

    const out = await allocationByStockCategory(db, "user-1", [pub(pf)])
    expect(out.total).toBe(90)
    expect(out.slices).toEqual([{ key: "balanced", value: 90 }])
  })

  it("sums the same stock held in two accounts once per attributed holding", async () => {
    const pf1 = await addPortfolio("A")
    const pf2 = await addPortfolio("B")
    const aapl1 = await addPosition(pf1, "AAPL")
    const aapl2 = await addPosition(pf2, "AAPL")
    await assign("AAPL", "high_growth")
    await addFact(pf1, aapl1, "2026-01-02", "40")
    await addFact(pf2, aapl2, "2026-01-02", "40")

    const out = await allocationByStockCategory(db, "user-1", [pub(pf1), pub(pf2)])
    expect(out.total).toBe(80)
    expect(out.slices).toEqual([{ key: "high_growth", value: 80 }])
  })

  it("uses only the latest published day", async () => {
    const pf = await addPortfolio("A")
    const aapl = await addPosition(pf, "AAPL")
    await assign("AAPL", "balanced")
    await addFact(pf, aapl, "2026-01-01", "100")
    await addFact(pf, aapl, "2026-01-02", "120")

    const out = await allocationByStockCategory(db, "user-1", [pub(pf)])
    expect(out.total).toBe(120)
  })

  it("returns nothing for an empty scope", async () => {
    const out = await allocationByStockCategory(db, "user-1", [])
    expect(out).toEqual({ slices: [], total: 0 })
  })
})