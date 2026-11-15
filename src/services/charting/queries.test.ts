import { describe, expect, it, beforeEach } from "vitest"
import { createTestDb } from "../../db/test-db.js"
import { chartPositionDaily, portfolios, positions } from "../../db/schema.js"
import type { DB } from "../../db/index.js"
import { getScopedDailySeries } from "./queries.js"

let db: DB

async function addPortfolio(userId: string, name: string) {
  const [row] = await db.insert(portfolios).values({ userId, name }).returning({ id: portfolios.id })
  return row.id
}

async function addPosition(userId: string, symbol: string) {
  const [row] = await db.insert(positions).values({ userId, symbol }).returning({ id: positions.id })
  return row.id
}

async function addFact(
  portfolioId: string,
  positionId: string,
  day: string,
  values: { value: string; remainingBasis: string; income: string; netFlow: string; realizedGain: string },
  generation = 1,
) {
  await db.insert(chartPositionDaily).values({ generation, portfolioId, positionId, day, ...values })
}

beforeEach(async () => {
  ;({ db } = await createTestDb())
})

describe("getScopedDailySeries", () => {
  it("sums per-position facts by day across accounts", async () => {
    const a = await addPortfolio("user-1", "A")
    const b = await addPortfolio("user-1", "B")
    const pa = await addPosition("user-1", "AAPL")
    const pb = await addPosition("user-1", "MSFT")

    await addFact(a, pa, "2026-01-01", { value: "100", remainingBasis: "80", income: "5", netFlow: "100", realizedGain: "0" })
    await addFact(b, pb, "2026-01-01", { value: "200", remainingBasis: "150", income: "7", netFlow: "200", realizedGain: "0" })
    await addFact(a, pa, "2026-01-02", { value: "110", remainingBasis: "80", income: "0", netFlow: "0", realizedGain: "3" })

    const series = await getScopedDailySeries(db, [a, b], 1)
    expect(series.points).toHaveLength(2)
    expect(series.points[0]).toMatchObject({ date: "2026-01-01", value: 300, remainingBasis: 230, income: 12, netFlow: 300 })
    expect(series.points[1]).toMatchObject({ date: "2026-01-02", value: 110, realizedGain: 3 })
  })

  it("scopes to the given accounts and generation", async () => {
    const a = await addPortfolio("user-1", "A")
    const pa = await addPosition("user-1", "AAPL")
    await addFact(a, pa, "2026-01-01", { value: "100", remainingBasis: "80", income: "0", netFlow: "0", realizedGain: "0" }, 1)
    await addFact(a, pa, "2026-01-01", { value: "999", remainingBasis: "0", income: "0", netFlow: "0", realizedGain: "0" }, 2)

    const gen1 = await getScopedDailySeries(db, [a], 1)
    expect(gen1.points[0].value).toBe(100)
    const gen2 = await getScopedDailySeries(db, [a], 2)
    expect(gen2.points[0].value).toBe(999)
  })

  it("honours the date window", async () => {
    const a = await addPortfolio("user-1", "A")
    const pa = await addPosition("user-1", "AAPL")
    for (const day of ["2026-01-01", "2026-02-01", "2026-03-01"]) {
      await addFact(a, pa, day, { value: "100", remainingBasis: "80", income: "0", netFlow: "0", realizedGain: "0" })
    }
    const series = await getScopedDailySeries(db, [a], 1, "2026-02-01", "2026-02-28")
    expect(series.points.map((p) => p.date)).toEqual(["2026-02-01"])
  })

  it("returns no points for an empty account set", async () => {
    const series = await getScopedDailySeries(db, [], 1)
    expect(series.points).toEqual([])
  })
})