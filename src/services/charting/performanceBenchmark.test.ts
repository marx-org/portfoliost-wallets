import { describe, expect, it, beforeEach, vi } from "vitest"
import { createTestDb } from "../../db/test-db.js"
import { chartEventFacts, chartPositionDaily, portfolios, positions } from "../../db/schema.js"
import type { DB } from "../../db/index.js"
import { buildBenchmarkSeries } from "../backfill.js"

vi.mock("../backfill.js", () => ({
  buildBenchmarkSeries: vi.fn(async (symbol: string, _from: string, _to: string, _auth: string, name: string) => ({
    symbol,
    name,
    timeSeries: [{ date: "2026-01-01", value: 100 }],
    absoluteTimeSeries: [{ date: "2026-01-01", value: 1000 }],
    returnPercent: 0,
    volatility: 0,
  })),
}))

const { getScopedBenchmarkSeries } = await import("./performance.js")

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

async function addFact(portfolioId: string, positionId: string, day: string, value: string) {
  await db.insert(chartPositionDaily).values({
    generation: 1,
    portfolioId,
    positionId,
    day,
    value,
    remainingBasis: value,
    quantity: "1",
  })
}

async function addEvent(portfolioId: string, date: string, receiptKind: string, amount: string) {
  await db.insert(chartEventFacts).values({
    generation: 1,
    portfolioId,
    eventDate: date,
    receiptKind,
    amountBase: amount,
    amountOriginal: amount,
    originalCurrency: "USD",
  })
}

beforeEach(async () => {
  ;({ db } = await createTestDb())
  vi.mocked(buildBenchmarkSeries).mockClear()
})

describe("getScopedBenchmarkSeries", () => {
  it("mirrors the scoped external flows and starting value into the shared engine", async () => {
    const pf = await addPortfolio("A")
    const pos = await addPosition(pf, "AAPL")
    await addFact(pf, pos, "2026-01-01", "1000")
    await addEvent(pf, "2026-01-01", "contribution", "1000")
    await addEvent(pf, "2026-01-02", "withdrawal", "200")

    const out = await getScopedBenchmarkSeries(db, [pub(pf)], {
      from: "2026-01-01",
      to: "2026-01-03",
      baseCurrency: "USD",
      authToken: "token",
      symbols: ["SPY"],
    })

    expect(out).toHaveLength(1)
    expect(out[0].symbol).toBe("SPY")
    const call = vi.mocked(buildBenchmarkSeries).mock.calls[0]
    expect(call[0]).toBe("SPY")
    const ctx = call[5] as unknown as { baseCurrency: string; seedValue: number; calcType: string; flows: Map<string, number> }
    expect(ctx.baseCurrency).toBe("USD")
    expect(ctx.seedValue).toBe(1000)
    expect(ctx.calcType).toBe("timeWeighted")
    expect(ctx.flows.get("2026-01-01")).toBe(1000)
    expect(ctx.flows.get("2026-01-02")).toBe(-200)
  })

  it("returns nothing when no benchmark symbols are requested", async () => {
    const out = await getScopedBenchmarkSeries(db, [pub("pf")], {
      from: "2026-01-01",
      to: "2026-01-03",
      baseCurrency: "USD",
      authToken: null,
      symbols: [],
    })
    expect(out).toEqual([])
  })
})