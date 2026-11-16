import { describe, expect, it, beforeEach } from "vitest"
import { createTestDb } from "../../db/test-db.js"
import { chartPositionDaily, portfolios, positions } from "../../db/schema.js"
import type { DB } from "../../db/index.js"
import { getScopedDailySeries } from "./queries.js"

let db: DB

/** One scoped account pinned to the generation its facts are published at (#95). */
const pub = (portfolioId: string, generation = 1) => ({ portfolioId, generation })

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

    const series = await getScopedDailySeries(db, [pub(a, 1), pub(b, 1)])
    expect(series.points).toHaveLength(2)
    expect(series.points[0]).toMatchObject({ date: "2026-01-01", value: 300, remainingBasis: 230, income: 12, netFlow: 300 })
    expect(series.points[1]).toMatchObject({ date: "2026-01-02", value: 110, realizedGain: 3 })
  })

  it("scopes to the given account at its published generation", async () => {
    const a = await addPortfolio("user-1", "A")
    const pa = await addPosition("user-1", "AAPL")
    await addFact(a, pa, "2026-01-01", { value: "100", remainingBasis: "80", income: "0", netFlow: "0", realizedGain: "0" }, 1)
    await addFact(a, pa, "2026-01-01", { value: "999", remainingBasis: "0", income: "0", netFlow: "0", realizedGain: "0" }, 2)

    const gen1 = await getScopedDailySeries(db, [pub(a, 1)])
    expect(gen1.points[0].value).toBe(100)
    const gen2 = await getScopedDailySeries(db, [pub(a, 2)])
    expect(gen2.points[0].value).toBe(999)
  })

  it("reads each account at its own published generation", async () => {
    const a = await addPortfolio("user-1", "A")
    const b = await addPortfolio("user-1", "B")
    const pa = await addPosition("user-1", "AAPL")
    const pb = await addPosition("user-1", "MSFT")
    await addFact(a, pa, "2026-01-01", { value: "100", remainingBasis: "80", income: "0", netFlow: "0", realizedGain: "0" }, 1)
    await addFact(b, pb, "2026-01-01", { value: "200", remainingBasis: "150", income: "0", netFlow: "0", realizedGain: "0" }, 3)

    // Generations are per portfolio. Reading the scope at a common min() would
    // look for generation 1 in B too and find nothing, emptying the scope (#95).
    const series = await getScopedDailySeries(db, [pub(a, 1), pub(b, 3)])
    expect(series.points).toHaveLength(1)
    expect(series.points[0].value).toBe(300)
    expect(series.generation).toBe(3)

    // An account with nothing published contributes no rows rather than zeroing
    // the accounts that do.
    const partial = await getScopedDailySeries(db, [pub(a, 1), pub(b, 0)])
    expect(partial.points[0].value).toBe(100)
  })

  it("honours the date window", async () => {
    const a = await addPortfolio("user-1", "A")
    const pa = await addPosition("user-1", "AAPL")
    for (const day of ["2026-01-01", "2026-02-01", "2026-03-01"]) {
      await addFact(a, pa, day, { value: "100", remainingBasis: "80", income: "0", netFlow: "0", realizedGain: "0" })
    }
    const series = await getScopedDailySeries(db, [pub(a, 1)], "2026-02-01", "2026-02-28")
    expect(series.points.map((p) => p.date)).toEqual(["2026-02-01"])
  })

  it("returns no points for an empty account set", async () => {
    const series = await getScopedDailySeries(db, [])
    expect(series.points).toEqual([])
  })
})