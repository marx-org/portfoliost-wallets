import { describe, expect, it, beforeEach } from "vitest"
import { createTestDb } from "../../db/test-db.js"
import { chartEventFacts, portfolios } from "../../db/schema.js"
import type { DB } from "../../db/index.js"
import { aggregateIncome, monthlyIncomeSeries, linearTrend } from "./income.js"

let db: DB

async function addPortfolio(userId: string, name: string) {
  const [row] = await db.insert(portfolios).values({ userId, name }).returning({ id: portfolios.id })
  return row.id
}

async function addEvent(portfolioId: string, date: string, receiptKind: string, amountBase: string, generation = 1) {
  await db.insert(chartEventFacts).values({
    generation,
    portfolioId,
    eventDate: date,
    receiptKind,
    amountBase,
    amountOriginal: amountBase,
    originalCurrency: "USD",
  })
}

beforeEach(async () => {
  ;({ db } = await createTestDb())
})

describe("aggregateIncome", () => {
  it("buckets dividends/interest/options by month, quarter and year", async () => {
    const a = await addPortfolio("user-1", "A")
    await addEvent(a, "2026-01-10", "dividend", "100")
    await addEvent(a, "2026-01-20", "interest", "5")
    await addEvent(a, "2026-02-05", "option", "40")
    await addEvent(a, "2026-04-01", "dividend", "200")

    const out = await aggregateIncome(db, [a], 1)
    expect(out.monthly).toEqual([
      { period: "2026-01", dividends: 100, interest: 5, options: 0, total: 105 },
      { period: "2026-02", dividends: 0, interest: 0, options: 40, total: 40 },
      { period: "2026-04", dividends: 200, interest: 0, options: 0, total: 200 },
    ])
    expect(out.quarterly).toEqual([
      { period: "2026-Q1", dividends: 100, interest: 5, options: 40, total: 145 },
      { period: "2026-Q2", dividends: 200, interest: 0, options: 0, total: 200 },
    ])
    expect(out.annual).toEqual([{ period: "2026", dividends: 300, interest: 5, options: 40, total: 345 }])
  })

  it("excludes contributions, withdrawals, transfers and trade cash effects", async () => {
    const a = await addPortfolio("user-1", "A")
    await addEvent(a, "2026-01-10", "dividend", "100")
    await addEvent(a, "2026-01-11", "contribution", "1000")
    await addEvent(a, "2026-01-12", "withdrawal", "50")
    await addEvent(a, "2026-01-13", "trade", "25")
    await addEvent(a, "2026-01-14", "cash", "10")

    const out = await aggregateIncome(db, [a], 1)
    expect(out.annual).toEqual([{ period: "2026", dividends: 100, interest: 0, options: 0, total: 100 }])
  })

  it("scopes to accounts, generation and window", async () => {
    const a = await addPortfolio("user-1", "A")
    const b = await addPortfolio("user-1", "B")
    await addEvent(a, "2026-01-10", "dividend", "100")
    await addEvent(b, "2026-01-10", "dividend", "200")
    await addEvent(a, "2026-01-10", "dividend", "999", 2)

    const gen1 = await aggregateIncome(db, [a], 1)
    expect(gen1.annual[0].dividends).toBe(100)
    const both = await aggregateIncome(db, [a, b], 1)
    expect(both.annual[0].dividends).toBe(300)
    const windowed = await aggregateIncome(db, [a], 1, "2026-02-01", "2026-12-31")
    expect(windowed.annual).toEqual([])
  })

  it("returns empty buckets for an empty account set", async () => {
    const out = await aggregateIncome(db, [], 1)
    expect(out).toEqual({ monthly: [], quarterly: [], annual: [] })
  })
})
describe("monthlyIncomeSeries", () => {
  it("marks the current and future months partial", () => {
    const agg = {
      monthly: [
        { period: "2026-01", dividends: 100, interest: 0, options: 0, total: 100 },
        { period: "2026-12", dividends: 0, interest: 0, options: 0, total: 0 },
      ],
      quarterly: [],
      annual: [],
    }
    const pts = monthlyIncomeSeries(agg, new Date("2026-06-15T00:00:00Z"))
    // Gaps are filled as true zero months; only the observed endpoints exist.
    expect(pts).toHaveLength(12)
    expect(pts[0]).toMatchObject({ period: "2026-01", dividends: 100, partial: false })
    // February 2026 is a past month (now = June 2026), so it is complete zero.
    expect(pts[1]).toMatchObject({ period: "2026-02", dividends: 0, interest: 0, options: 0, total: 0, partial: false })
    expect(pts[5]).toMatchObject({ period: "2026-06", total: 0, partial: true }) // current month
    expect(pts[11]).toMatchObject({ period: "2026-12", partial: true }) // future
  })

  it("fills a true zero month between two receipt months", () => {
    const agg = {
      monthly: [
        { period: "2026-01", dividends: 100, interest: 0, options: 0, total: 100 },
        // 2026-02 has no receipts: aggregateIncome omits it, series must show zero.
        { period: "2026-03", dividends: 200, interest: 0, options: 0, total: 200 },
      ],
      quarterly: [],
      annual: [],
    }
    // now is after the window, so every month is complete (no partial flag).
    const pts = monthlyIncomeSeries(agg, new Date("2027-01-01T00:00:00Z"))
    expect(pts.map((p) => p.period)).toEqual(["2026-01", "2026-02", "2026-03"])
    expect(pts[1]).toMatchObject({ period: "2026-02", dividends: 0, total: 0, partial: false })
  })

  it("returns an empty series when there are no monthly buckets", () => {
    expect(monthlyIncomeSeries({ monthly: [], quarterly: [], annual: [] })).toEqual([])
  })
})

describe("linearTrend", () => {
  it("fits complete points and ignores partial", () => {
    const t = linearTrend([
      { period: "2026-01", value: 100 },
      { period: "2026-02", value: 200 },
      { period: "2026-03", value: 300, partial: true },
    ])
    expect(t).not.toBeNull()
    expect(t!.slope).toBe(100)
    expect(t!.intercept).toBe(100)
  })

  it("returns null with fewer than two complete points", () => {
    expect(linearTrend([{ period: "2026-01", value: 100, partial: true }])).toBeNull()
  })
})
