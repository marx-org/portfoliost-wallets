import { describe, expect, it } from "vitest"
import { makeHarness, insertPosition } from "../../routes/test-utils.js"
import { portfolios, stockChartCategories } from "../../db/schema.js"
import {
  isStockChartCategory,
  listHoldableStocks,
  listStockCategories,
  upsertStockCategory,
} from "./categories.js"

/** Drizzle wraps the driver error; return the combined message for matching. */
async function dbErrorMessage(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn()
    return ""
  } catch (e) {
    const err = e as Error & { cause?: Error }
    return `${err.message} ${err.cause?.message ?? ""}`
  }
}

async function seedStocks(userId: string) {
  const h = await makeHarness(userId)
  const [a] = await h.db.insert(portfolios).values({ userId, name: "A", baseCurrency: "USD" }).returning()
  const [b] = await h.db.insert(portfolios).values({ userId, name: "B", baseCurrency: "USD" }).returning()
  // The same equity held in two accounts, plus a same-ticker OPTION that must
  // never be classified as the equity.
  const aaplA = await insertPosition(h.db, { userId, symbol: "AAPL", companyName: "Apple", assetType: "STOCK", instrumentCurrency: "USD", portfolioId: a.id })
  const aaplB = await insertPosition(h.db, { userId, symbol: "AAPL", companyName: "Apple", assetType: "STOCK", instrumentCurrency: "USD", portfolioId: b.id })
  const option = await insertPosition(h.db, { userId, symbol: "AAPL", companyName: "Apple 26C", assetType: "OPTION", instrumentCurrency: "USD", portfolioId: a.id })
  return { h, a, b, aaplA, aaplB, option }
}

describe("stock categories", () => {
  it("exposes only STOCK instruments, excluding a same-ticker option", async () => {
    const { h } = await seedStocks("user-1")
    const stocks = await listHoldableStocks(h.db, "user-1")
    expect(stocks.map((s) => s.symbol)).toEqual(["AAPL"]) // one distinct equity
    expect(stocks).toHaveLength(1)
    expect(stocks[0].instrumentCurrency).toBe("USD")
    expect(stocks[0].name).toBe("Apple")
  })

  it("narrows holdable stocks to the requested account", async () => {
    const { h, a } = await seedStocks("user-1")
    const stocks = await listHoldableStocks(h.db, "user-1", { accountIds: [a.id] })
    expect(stocks.map((s) => s.symbol)).toEqual(["AAPL"])
  })

  it("stores one assignment per owner/stock and shares it across accounts", async () => {
    const { h } = await seedStocks("user-1")
    await upsertStockCategory(h.db, "user-1", { symbol: "AAPL", instrumentCurrency: "USD", category: "high_growth" })
    // A second upsert (the same stock seen from another account) updates, not duplicates.
    await upsertStockCategory(h.db, "user-1", { symbol: "AAPL", instrumentCurrency: "USD", category: "balanced" })
    const rows = await listStockCategories(h.db, "user-1")
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ symbol: "AAPL", instrumentCurrency: "USD", category: "balanced" })
    expect(rows[0].updatedAt).toBeInstanceOf(Date)
  })

  it("retains an assignment after a reload", async () => {
    const { h } = await seedStocks("user-1")
    await upsertStockCategory(h.db, "user-1", { symbol: "MSFT", instrumentCurrency: "USD", category: "very_high_growth" })
    const rows = await listStockCategories(h.db, "user-1")
    expect(rows).toHaveLength(1)
    expect(rows[0].category).toBe("very_high_growth")
  })

  it("isolates assignments between users", async () => {
    const { h } = await seedStocks("user-1")
    await upsertStockCategory(h.db, "user-1", { symbol: "AAPL", instrumentCurrency: "USD", category: "high_yield" })
    const other = await listStockCategories(h.db, "user-2")
    expect(other).toEqual([])
    // user-2 may create their own assignment for the same stock.
    await upsertStockCategory(h.db, "user-2", { symbol: "AAPL", instrumentCurrency: "USD", category: "balanced" })
    const mine = await listStockCategories(h.db, "user-1")
    const theirs = await listStockCategories(h.db, "user-2")
    expect(mine[0].category).toBe("high_yield")
    expect(theirs[0].category).toBe("balanced")
  })

  it("accepts exactly the fixed category set and rejects anything else", () => {
    for (const c of ["balanced", "high_yield", "high_growth", "very_high_growth", "not_classified"]) {
      expect(isStockChartCategory(c)).toBe(true)
    }
    for (const c of ["growth", "HIGH_YIELD", "", null, undefined, 1]) {
      expect(isStockChartCategory(c)).toBe(false)
    }
  })

  it("rejects a non-enum category at the database level", async () => {
    const { h } = await seedStocks("user-1")
    const msg = await dbErrorMessage(() =>
      h.db.insert(stockChartCategories).values({
        userId: "user-1",
        symbol: "AAPL",
        instrumentCurrency: "USD",
        category: "bogus",
      }),
    )
    expect(msg).toMatch(/chk_stock_chart_categories_category|violates check/u)
  })

  it("enforces the unique (owner, symbol, currency) key", async () => {
    const { h } = await seedStocks("user-1")
    await upsertStockCategory(h.db, "user-1", { symbol: "AAPL", instrumentCurrency: "USD", category: "balanced" })
    const msg = await dbErrorMessage(() =>
      h.db.insert(stockChartCategories).values({
        userId: "user-1",
        symbol: "AAPL",
        instrumentCurrency: "USD",
        category: "high_growth",
      }),
    )
    expect(msg).toMatch(/duplicate key|uq_stock_chart_categories_owner_stock/u)
  })
})