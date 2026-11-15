import { describe, expect, it, beforeEach } from "vitest"
import { eq } from "drizzle-orm"
import { createTestDb } from "../../db/test-db.js"
import { chartPositionDaily, chartProjectionState, portfolioCashTransactions, portfolios } from "../../db/schema.js"
import type { DB } from "../../db/index.js"
import { markChartingDirty, recomputeChartingForPortfolio, recomputeDirtyCharting } from "./invalidation.js"
import type { PriceBarSeries } from "../backfill.js"

let db: DB

async function addPortfolio(name = "A") {
  const [row] = await db.insert(portfolios).values({ userId: "user-1", name, baseCurrency: "USD" }).returning({ id: portfolios.id })
  return row.id
}

function fakeFetcher(): (s: string) => Promise<PriceBarSeries | null> {
  return async () => null
}

beforeEach(async () => {
  ;({ db } = await createTestDb())
})

describe("charting invalidation", () => {
  it("marks a portfolio stale and bumps the version on each invalidation", async () => {
    const pf = await addPortfolio()
    await markChartingDirty(db, pf, "2026-01-01")
    let [state] = await db.select().from(chartProjectionState).where(eq(chartProjectionState.portfolioId, pf))
    expect(state.status).toBe("stale")
    expect(state.version).toBe(1)
    expect(state.dirtyFrom).toBe("2026-01-01")

    await markChartingDirty(db, pf, "2026-01-02")
    ;[state] = await db.select().from(chartProjectionState).where(eq(chartProjectionState.portfolioId, pf))
    expect(state.version).toBe(2)
    expect(state.dirtyFrom).toBe("2026-01-02")
  })

  it("recomputes a portfolio at the next generation and clears the dirty flag", async () => {
    const pf = await addPortfolio()
    await db.insert(portfolioCashTransactions).values({ userId: "user-1", portfolioId: pf, type: "DEPOSIT", amount: "1000", currency: "USD", exchangeRate: "1", transactionDate: "2026-01-01" })
    await markChartingDirty(db, pf)

    await recomputeChartingForPortfolio(db, pf, "token", { fetcher: fakeFetcher(), from: "2026-01-01", to: "2026-01-02" })
    const [state] = await db.select().from(chartProjectionState).where(eq(chartProjectionState.portfolioId, pf))
    expect(state.status).toBe("complete")
    expect(state.generation).toBe(1)

    const facts = await db.select().from(chartPositionDaily).where(eq(chartPositionDaily.portfolioId, pf))
    expect(facts.length).toBe(0) // cash-only portfolio → no position facts
  })

  it("recomputeDirtyCharting rebuilds only stale portfolios", async () => {
    const pf = await addPortfolio()
    await db.insert(portfolioCashTransactions).values({ userId: "user-1", portfolioId: pf, type: "DEPOSIT", amount: "1000", currency: "USD", exchangeRate: "1", transactionDate: "2026-01-01" })
    await markChartingDirty(db, pf)

    const res = await recomputeDirtyCharting(db, "token", { fetcher: fakeFetcher(), from: "2026-01-01", to: "2026-01-02" })
    expect(res.rebuilt).toBe(1)
    expect(res.failed).toBe(0)

    const [state] = await db.select().from(chartProjectionState).where(eq(chartProjectionState.portfolioId, pf))
    expect(state.status).toBe("complete")
  })
})