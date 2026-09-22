/** cashFlows.test.ts (D50) — dailyNetCashFlows helper */
import { describe, expect, it } from "vitest"
import { makeHarness } from "../routes/test-utils.js"
import { portfolios, portfolioTransactions } from "../db/schema.js"
import { dailyNetCashFlows } from "./cashFlows.js"

async function seedPortfolio(db: Awaited<ReturnType<typeof makeHarness>>["db"], userId: string) {
  const [pf] = await db
    .insert(portfolios)
    .values({ userId, name: "CF PF", currency: "USD", baseCurrency: "USD" })
    .returning()
  return pf
}

async function seedTx(
  db: Awaited<ReturnType<typeof makeHarness>>["db"],
  userId: string,
  portfolioId: string,
  type: "BUY" | "SELL",
  qty: number,
  price: number,
  date: string,
  feesSettled = 0,
) {
  await db.insert(portfolioTransactions).values({
    userId,
    portfolioId,
    type,
    instrumentSymbol: "SPY",
    quantity: String(qty),
    price: String(price),
    currency: "USD",
    instrumentCurrency: "USD",
    totalAmount: String(qty * price),
    feesSettled: String(feesSettled),
    executedAt: new Date(`${date}T12:00:00Z`),
  })
}

describe("dailyNetCashFlows (D50)", () => {
  it("BUY deploys +cash, SELL releases −cash (fees included)", async () => {
    const { db, user } = await makeHarness("cf-1")
    const pf = await seedPortfolio(db, user.id)
    await seedTx(db, user.id, pf.id, "BUY", 10, 100, "2026-07-01", 2.5) // +1002.5
    await seedTx(db, user.id, pf.id, "SELL", 2, 110, "2026-07-03", 1) // −(220−1) = −219

    const flows = await dailyNetCashFlows(db, "Bearer t", pf.id, "2026-07-01", "2026-07-05", "USD")
    expect(flows.get("2026-07-01")).toBeCloseTo(1002.5)
    expect(flows.get("2026-07-03")).toBeCloseTo(-219)
    expect(flows.get("2026-07-02")).toBeUndefined()
  })

  it("aggregates multiple transactions on the same day and respects window", async () => {
    const { db, user } = await makeHarness("cf-2")
    const pf = await seedPortfolio(db, user.id)
    await seedTx(db, user.id, pf.id, "BUY", 1, 50, "2026-07-02") // +50
    await seedTx(db, user.id, pf.id, "BUY", 1, 30, "2026-07-02") // +30

    const flows = await dailyNetCashFlows(db, "Bearer t", pf.id, "2026-07-03", "2026-07-04", "USD")
    expect(flows.size).toBe(0) // window excludes 07-02
    const full = await dailyNetCashFlows(db, "Bearer t", pf.id, "2026-07-01", "2026-07-10", "USD")
    expect(full.get("2026-07-02")).toBeCloseTo(80)
  })
})