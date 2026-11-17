import { describe, expect, it, beforeEach } from "vitest"
import { createTestDb } from "../../db/test-db.js"
import {
  chartEventFacts,
  chartPositionDaily,
  labels,
  portfolios,
  positionLabels,
  positions,
} from "../../db/schema.js"
import type { DB } from "../../db/index.js"
import { getScopedPerformance } from "./performance.js"

let db: DB

const pub = (portfolioId: string, generation = 1) => ({ portfolioId, generation })

async function addPortfolio(name: string) {
  const [row] = await db.insert(portfolios).values({ userId: "user-1", name, baseCurrency: "USD" }).returning({ id: portfolios.id })
  return row.id
}

async function addPosition(portfolioId: string, symbol: string) {
  const [row] = await db
    .insert(positions)
    .values({ userId: "user-1", symbol, assetType: "STOCK", instrumentCurrency: "USD" })
    .returning({ id: positions.id })
  return row.id
}

async function addFact(portfolioId: string, positionId: string, day: string, value: string, remainingBasis: string) {
  await db.insert(chartPositionDaily).values({
    generation: 1,
    portfolioId,
    positionId,
    day,
    value,
    remainingBasis,
    quantity: "1",
  })
}

async function addEvent(
  portfolioId: string,
  date: string,
  receiptKind: string,
  amount: string,
  positionId: string | null = null,
  generation = 1,
) {
  await db.insert(chartEventFacts).values({
    generation,
    portfolioId,
    positionId,
    eventDate: date,
    receiptKind,
    amountBase: amount,
    amountOriginal: amount,
    originalCurrency: "USD",
  })
}

beforeEach(async () => {
  ;({ db } = await createTestDb())
})

describe("getScopedPerformance", () => {
  it("reports value, capital basis, invested and cumulative income/options", async () => {
    const pf = await addPortfolio("A")
    const pos = await addPosition(pf, "AAPL")
    await addFact(pf, pos, "2026-01-01", "1000", "800")
    await addFact(pf, pos, "2026-01-02", "1100", "800")
    await addEvent(pf, "2026-01-01", "dividend", "100", pos)
    await addEvent(pf, "2026-01-02", "interest", "50", pos)
    await addEvent(pf, "2026-01-01", "option", "40", pos)
    await addEvent(pf, "2026-01-01", "contribution", "1000")
    await addEvent(pf, "2026-01-02", "withdrawal", "200")

    const out = await getScopedPerformance(db, [pub(pf)])
    expect(out.points).toEqual([
      { date: "2026-01-01", value: 1000, capitalBasis: 800, invested: 1000, cumulativeIncome: 100, cumulativeOptions: 40 },
      { date: "2026-01-02", value: 1100, capitalBasis: 800, invested: 800, cumulativeIncome: 150, cumulativeOptions: 40 },
    ])
  })

  it("reflects an event on a non-fact day on the next point", async () => {
    const pf = await addPortfolio("A")
    const pos = await addPosition(pf, "AAPL")
    await addFact(pf, pos, "2026-01-01", "100", "100")
    await addFact(pf, pos, "2026-01-03", "120", "100")
    await addEvent(pf, "2026-01-02", "dividend", "50", pos)

    const out = await getScopedPerformance(db, [pub(pf)])
    expect(out.points[0].cumulativeIncome).toBe(0)
    expect(out.points[1].cumulativeIncome).toBe(50)
  })

  it("narrows income to positions carrying any selected label (OR)", async () => {
    const pf = await addPortfolio("A")
    const aapl = await addPosition(pf, "AAPL")
    const msft = await addPosition(pf, "MSFT")
    const [label] = await db
      .insert(labels)
      .values({ userId: "user-1", name: "Core", color: "#112233" })
      .returning({ id: labels.id })
    await db.insert(positionLabels).values({ positionId: aapl, labelId: label.id })
    await addFact(pf, aapl, "2026-01-01", "60", "60")
    await addFact(pf, msft, "2026-01-01", "40", "40")
    await addEvent(pf, "2026-01-01", "dividend", "60", aapl)
    await addEvent(pf, "2026-01-01", "dividend", "40", msft)

    const out = await getScopedPerformance(db, [pub(pf)], { labelIds: [label.id] })
    // Both value and income are label-scoped (a filtered series, not a clipped
    // all-account total).
    expect(out.points[0].value).toBe(60)
    expect(out.points[0].cumulativeIncome).toBe(60)
  })

  it("returns nothing for an empty scope", async () => {
    const out = await getScopedPerformance(db, [])
    expect(out.points).toEqual([])
  })
})