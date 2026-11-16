import { describe, expect, it, beforeEach } from "vitest"
import { eq } from "drizzle-orm"
import { createTestDb } from "../../db/test-db.js"
import {
  chartEventFacts,
  chartPositionDaily,
  chartProjectionState,
  labels,
  portfolioCashTransactions,
  portfolioTransactions,
  portfolios,
  positions,
  positionPortfolios,
} from "../../db/schema.js"
import type { DB } from "../../db/index.js"
import {
  CHART_TAIL_DAYS,
  chartFactsWindow,
  markChartingDirty,
  recomputeChartingForPortfolio,
  refreshChartingFacts,
  refreshFleetChartingFacts,
} from "./invalidation.js"
import { calendarDays } from "../backfill.js"
import type { PriceBarSeries } from "../backfill.js"

let db: DB

async function addPortfolio(name = "A") {
  const [row] = await db
    .insert(portfolios)
    .values({ userId: "user-1", name, baseCurrency: "USD" })
    .returning({ id: portfolios.id })
  return row.id
}

async function addStockPortfolio(name: string) {
  const pf = await addPortfolio(name)
  const [pos] = await db
    .insert(positions)
    .values({ userId: "user-1", symbol: "AAPL" })
    .returning({ id: positions.id })
  await db.insert(positionPortfolios).values({ positionId: pos.id, portfolioId: pf })
  await db.insert(portfolioTransactions).values({
    userId: "user-1",
    portfolioId: pf,
    positionId: pos.id,
    type: "BUY",
    instrumentSymbol: "AAPL",
    assetType: "STOCK",
    quantity: "10",
    price: "100",
    currency: "USD",
    exchangeRate: "1",
    executedAt: new Date("2026-01-01T00:00:00Z"),
  })
  return { pf, pos: pos.id }
}

function fixedPrice(price: number) {
  return async (symbol: string, from: string, to: string): Promise<PriceBarSeries | null> => {
    const dates = calendarDays(from, to)
    return { symbol, dates, closes: dates.map(() => price), stale: false }
  }
}

async function readProjection(portfolioId: string) {
  const [row] = await db
    .select()
    .from(chartProjectionState)
    .where(eq(chartProjectionState.portfolioId, portfolioId))
  return row
}

async function rowsForGeneration(portfolioId: string, generation: number) {
  return db
    .select({ day: chartPositionDaily.day, value: chartPositionDaily.value, generation: chartPositionDaily.generation })
    .from(chartPositionDaily)
    .where(eq(chartPositionDaily.portfolioId, portfolioId))
    .orderBy(chartPositionDaily.day)
    .then((rows) => rows.filter((row) => row.generation === generation))
}

beforeEach(async () => {
  ;({ db } = await createTestDb())
})

describe("charting invalidation", () => {
  it("marks a portfolio stale, coalesces dirtyFrom to the earliest date, and null forces a full rebuild", async () => {
    const pf = await addPortfolio()

    await markChartingDirty(db, pf, "2026-01-02")
    let state = await readProjection(pf)
    expect(state.status).toBe("stale")
    expect(state.version).toBe(1)
    expect(state.dirtyFrom).toBe("2026-01-02")

    await markChartingDirty(db, pf, "2026-01-01")
    state = await readProjection(pf)
    expect(state.version).toBe(2)
    expect(state.dirtyFrom).toBe("2026-01-01")

    await markChartingDirty(db, pf, "2026-06-01")
    state = await readProjection(pf)
    expect(state.dirtyFrom).toBe("2026-01-01")

    await markChartingDirty(db, pf, null)
    state = await readProjection(pf)
    expect(state.dirtyFrom).toBeNull()
  })

  it("recomputes a portfolio at the next generation and clears the dirty flag", async () => {
    const pf = await addPortfolio()
    await db.insert(portfolioCashTransactions).values({
      userId: "user-1",
      portfolioId: pf,
      type: "DEPOSIT",
      amount: "1000",
      currency: "USD",
      exchangeRate: "1",
      transactionDate: "2026-01-01",
    })
    await markChartingDirty(db, pf)

    await recomputeChartingForPortfolio(db, pf, "token", { fetcher: fixedPrice(100), from: "2026-01-01", to: "2026-01-02" })
    const state = await readProjection(pf)
    expect(state.status).toBe("complete")
    expect(state.generation).toBe(1)

    const facts = await db
      .select()
      .from(chartPositionDaily)
      .where(eq(chartPositionDaily.portfolioId, pf))
    expect(facts.length).toBe(0) // cash-only portfolio → no position facts
  })
})

describe("charting refresh windows", () => {
  it("bootstraps a portfolio with no projection row and skips virtual portfolios", async () => {
    const [label] = await db
      .insert(labels)
      .values({ userId: "user-1", name: "Virtual", color: "#6b7280" })
      .returning({ id: labels.id })
    const [virtual] = await db
      .insert(portfolios)
      .values({ userId: "user-1", name: "Virtual view", baseCurrency: "USD", isVirtual: true, labelId: label.id })
      .returning({ id: portfolios.id })
    const { pf } = await addStockPortfolio("Bootstrap")

    const res = await refreshFleetChartingFacts(db, "token", {
      now: new Date("2026-01-03T00:00:00Z"),
      fetcher: fixedPrice(100),
    })
    expect(res).toEqual({ refreshed: 1, bootstrapped: 1, failed: 0 })

    const state = await readProjection(pf)
    expect(state.generation).toBe(1)
    expect(state.status).toBe("complete")

    const rows = await rowsForGeneration(pf, 1)
    expect(rows.map((r) => r.day)).toEqual(["2026-01-01", "2026-01-02", "2026-01-03"])
    expect(Number(rows[2].value)).toBe(1000)

    const virtualState = await db
      .select()
      .from(chartProjectionState)
      .where(eq(chartProjectionState.portfolioId, virtual.id))
    expect(virtualState).toHaveLength(0)
    const virtualRows = await db
      .select()
      .from(chartPositionDaily)
      .where(eq(chartPositionDaily.portfolioId, virtual.id))
    expect(virtualRows).toHaveLength(0)
  })

  it("extends a clean projection with a bounded tail without advancing the generation", async () => {
    const { pf } = await addStockPortfolio("Tail")

    await refreshChartingFacts(db, pf, "token", {
      now: new Date("2026-01-03T00:00:00Z"),
      fetcher: fixedPrice(100),
    })
    const first = await rowsForGeneration(pf, 1)
    expect(first.length).toBe(3)

    const window = await chartFactsWindow(db, pf, new Date("2026-01-04T00:00:00Z"))
    expect(window.generation).toBe(1)
    expect(window.from).toBe("2026-01-01")
    expect(window.to).toBe("2026-01-04")

    await refreshChartingFacts(db, pf, "token", {
      now: new Date("2026-01-04T00:00:00Z"),
      fetcher: fixedPrice(110),
    })

    const state = await readProjection(pf)
    expect(state.generation).toBe(1)
    expect(state.status).toBe("complete")
    expect(state.dirtyFrom).toBeNull()

    const rows = await rowsForGeneration(pf, 1)
    expect(rows.map((r) => r.day)).toEqual(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"])
    expect(Number(rows[3].value)).toBe(1100)
  })

  it("keeps a failed tail refresh readable and picks the portfolio up again on the next pass", async () => {
    const { pf } = await addStockPortfolio("Fail")

    await recomputeChartingForPortfolio(db, pf, "token", { fetcher: fixedPrice(100), from: "2026-01-01", to: "2026-01-02" })
    await markChartingDirty(db, pf, "2026-01-02")

    const failed = await refreshFleetChartingFacts(db, "token", {
      now: new Date("2026-01-03T00:00:00Z"),
      fetcher: async () => {
        throw new Error("provider down")
      },
    })
    expect(failed).toEqual({ refreshed: 0, bootstrapped: 0, failed: 1 })

    const state = await readProjection(pf)
    expect(state.generation).toBe(1)
    expect(state.status).toBe("stale")

    const readable = await rowsForGeneration(pf, 1)
    expect(readable.length).toBe(2)

    const next = await refreshFleetChartingFacts(db, "token", {
      now: new Date("2026-01-04T00:00:00Z"),
      fetcher: fixedPrice(120),
    })
    expect(next).toEqual({ refreshed: 1, bootstrapped: 0, failed: 0 })

    const recovered = await readProjection(pf)
    expect(recovered.generation).toBe(1)
    expect(recovered.status).toBe("complete")

    const rows = await rowsForGeneration(pf, 1)
    expect(rows.length).toBe(4)
    expect(Number(rows[3].value)).toBe(1200)
  })

  it("prunes superseded generations when a rebuild advances generation", async () => {
    const { pf } = await addStockPortfolio("Prune")
    await recomputeChartingForPortfolio(db, pf, "token", { fetcher: fixedPrice(100), from: "2026-01-01", to: "2026-01-02" })
    const first = await rowsForGeneration(pf, 1)
    expect(first).toHaveLength(2)

    await markChartingDirty(db, pf, "2026-01-01")
    await recomputeChartingForPortfolio(db, pf, "token", { fetcher: fixedPrice(120), from: "2026-01-01", to: "2026-01-02" })

    const after = await db
      .select({ generation: chartPositionDaily.generation, value: chartPositionDaily.value })
      .from(chartPositionDaily)
      .where(eq(chartPositionDaily.portfolioId, pf))
      .orderBy(chartPositionDaily.day)

    expect(after).toHaveLength(2)
    expect(after.map((r) => r.generation)).toEqual([2, 2])
    expect(Number(after[1].value)).toBe(1200)
  })

  it("uses the documented tail window rather than rebuilding all history on a clean pass", async () => {
    const { pf } = await addStockPortfolio("Tail window")
    await refreshChartingFacts(db, pf, "token", { now: new Date("2026-01-10T00:00:00Z"), fetcher: fixedPrice(100) })

    const window = await chartFactsWindow(db, pf, new Date("2026-01-11T00:00:00Z"))
    expect(window.generation).toBe(1)
    expect(window.from).toBe("2026-01-08")
    expect(window.to).toBe("2026-01-11")

    await refreshChartingFacts(db, pf, "token", { fetcher: fixedPrice(110), now: new Date("2026-01-11T00:00:00Z") })
    const rows = await rowsForGeneration(pf, 1)
    const day7 = rows.find((row) => row.day === "2026-01-07")
    const day8 = rows.find((row) => row.day === "2026-01-08")
    expect(Number(day7?.value)).toBe(1000) // outside the tail: not re-priced
    expect(Number(day8?.value)).toBe(1100) // inside the tail: re-priced
    expect(Number(rows[rows.length - 1].value)).toBe(1100)
  })

  it("exposes CHART_TAIL_DAYS so the refresh window is bounded and testable", () => {
    expect(CHART_TAIL_DAYS).toBe(2)
  })
})
