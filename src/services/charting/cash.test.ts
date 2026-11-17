import { describe, expect, it, beforeEach } from "vitest"
import { createTestDb } from "../../db/test-db.js"
import { portfolios, portfolioCashTransactions, portfolioTransactions } from "../../db/schema.js"
import type { DB } from "../../db/index.js"
import { cashBalanceSeriesForScope } from "./cash.js"

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
  await db.insert(portfolioTransactions).values({
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
  })
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