import { describe, expect, it, beforeEach } from "vitest"
import { eq } from "drizzle-orm"
import { createTestDb } from "../../db/test-db.js"
import { chartPositionDaily, chartProjectionState, labels, portfolioCashTransactions, portfolioTransactions, portfolios, positions, positionPortfolios } from "../../db/schema.js"
import type { DB } from "../../db/index.js"
import { markChartingDirty, portfoliosNeedingChartingRebuild, recomputeChartingForPortfolio, recomputeDirtyCharting } from "./invalidation.js"
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

describe("charting projection bootstrap and pruning", () => {
  async function addStockPortfolio(name: string) {
    const [row] = await db.insert(portfolios).values({ userId: "user-1", name, baseCurrency: "USD" }).returning({ id: portfolios.id })
    const pf = row.id
    const [pos] = await db.insert(positions).values({ userId: "user-1", symbol: "AAPL" }).returning({ id: positions.id })
    await db.insert(positionPortfolios).values({ positionId: pos.id, portfolioId: pf })
    await db.insert(portfolioTransactions).values({
      userId: "user-1", portfolioId: pf, positionId: pos.id, type: "BUY", instrumentSymbol: "AAPL", assetType: "STOCK",
      quantity: "10", price: "100", currency: "USD", exchangeRate: "1", executedAt: new Date("2026-01-01T00:00:00Z"),
    })
    return { pf, pos }
  }

  const closes = (closes: number[]) => async (symbol: string): Promise<PriceBarSeries | null> => ({
    symbol,
    dates: ["2026-01-01", "2026-01-02"],
    closes,
    stale: false,
  })

  it("bootstraps a portfolio that has never been projected", async () => {
    const { pf } = await addStockPortfolio("Bootstrap")
    // No chart_projection_state row exists at all — the case production was in.
    expect(await portfoliosNeedingChartingRebuild(db)).toEqual([pf])

    const res = await recomputeDirtyCharting(db, "token", { fetcher: closes([100, 110]), from: "2026-01-01", to: "2026-01-02" })
    expect(res).toEqual({ rebuilt: 1, failed: 0 })

    const [state] = await db.select().from(chartProjectionState).where(eq(chartProjectionState.portfolioId, pf))
    expect(state.generation).toBe(1)
    expect(state.status).toBe("complete")

    const rows = await db.select({ day: chartPositionDaily.day, value: chartPositionDaily.value })
      .from(chartPositionDaily)
      .where(eq(chartPositionDaily.portfolioId, pf))
    expect(rows).toHaveLength(2)
    expect(Number(rows[1].value)).toBe(1100)

    // Nothing left to rebuild on the next pass.
    expect(await portfoliosNeedingChartingRebuild(db)).toEqual([])
  })

  it("never projects a virtual portfolio", async () => {
    const [label] = await db.insert(labels).values({ userId: "user-1", name: "Virtual", color: "#6b7280" }).returning({ id: labels.id })
    const [virtual] = await db
      .insert(portfolios)
      .values({ userId: "user-1", name: "Virtual view", baseCurrency: "USD", isVirtual: true, labelId: label.id })
      .returning({ id: portfolios.id })
    const { pf } = await addStockPortfolio("Real")

    const ids = await portfoliosNeedingChartingRebuild(db)
    expect(ids).toEqual([pf])

    const res = await recomputeDirtyCharting(db, "token", { fetcher: closes([100]), from: "2026-01-01", to: "2026-01-02" })
    expect(res.rebuilt).toBe(1)
    const virtualRows = await db.select().from(chartPositionDaily).where(eq(chartPositionDaily.portfolioId, virtual.id))
    expect(virtualRows).toHaveLength(0)
    const virtualState = await db.select().from(chartProjectionState).where(eq(chartProjectionState.portfolioId, virtual.id))
    expect(virtualState).toHaveLength(0)
  })

  it("publishing a generation prunes the superseded one", async () => {
    const { pf } = await addStockPortfolio("Prune")
    await recomputeChartingForPortfolio(db, pf, "token", { fetcher: closes([100, 100]), from: "2026-01-01", to: "2026-01-02" })
    const first = await db.select({ generation: chartPositionDaily.generation, value: chartPositionDaily.value })
      .from(chartPositionDaily)
      .where(eq(chartPositionDaily.portfolioId, pf))
    expect(first).toHaveLength(2)
    expect(first[0].generation).toBe(1)

    await markChartingDirty(db, pf, "2026-01-01")
    await recomputeChartingForPortfolio(db, pf, "token", { fetcher: closes([100, 120]), from: "2026-01-01", to: "2026-01-02" })

    const after = await db.select({ generation: chartPositionDaily.generation, value: chartPositionDaily.value })
      .from(chartPositionDaily)
      .where(eq(chartPositionDaily.portfolioId, pf))
    // Only the published generation is kept: readers pin it, and a daily rebuild
    // would otherwise add a whole history per generation.
    expect(after).toHaveLength(2)
    expect(after.map((r) => r.generation)).toEqual([2, 2])
    expect(Number(after[1].value)).toBe(1200)
  })

  it("keeps the last complete generation readable when a rebuild fails", async () => {
    const { pf } = await addStockPortfolio("Fail")
    await recomputeChartingForPortfolio(db, pf, "token", { fetcher: closes([100, 110]), from: "2026-01-01", to: "2026-01-02" })
    await markChartingDirty(db, pf, "2026-01-02")

    const res = await recomputeDirtyCharting(db, "token", {
      from: "2026-01-01",
      to: "2026-01-02",
      fetcher: async () => { throw new Error("provider down") },
    })
    expect(res).toEqual({ rebuilt: 0, failed: 1 })

    const [state] = await db.select().from(chartProjectionState).where(eq(chartProjectionState.portfolioId, pf))
    expect(state.generation).toBe(1)
    expect(state.status).toBe("stale")
    const rows = await db.select({ generation: chartPositionDaily.generation }).from(chartPositionDaily).where(eq(chartPositionDaily.portfolioId, pf))
    expect(rows.map((r) => r.generation)).toEqual([1, 1])

    // The same portfolio is picked up again by the next pass.
    expect(await portfoliosNeedingChartingRebuild(db)).toEqual([pf])
  })
})