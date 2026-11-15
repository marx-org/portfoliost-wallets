import { describe, expect, it, beforeEach } from "vitest"
import { createTestDb } from "../../db/test-db.js"
import { chartEventFacts, labels, portfolios, positionLabels, positions } from "../../db/schema.js"
import type { DB } from "../../db/index.js"
import { aggregateIncome, annualIncomeEquivalent, annualIncomeSeries, cumulativeIncomeSeries, monthlyIncomeSeries, linearTrend } from "./income.js"

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

describe("cumulativeIncomeSeries", () => {
  it("opens with the lifetime pre-window total and stays flat on a zero month", async () => {
    const a = await addPortfolio("user-1", "A")
    await addEvent(a, "2025-12-10", "dividend", "100") // before the window
    await addEvent(a, "2026-01-10", "dividend", "20")
    await addEvent(a, "2026-03-10", "dividend", "5")
    const agg = await aggregateIncome(db, [a], 1, "2026-01-01", "2026-03-31")
    const monthly = monthlyIncomeSeries(agg)
    const cum = await cumulativeIncomeSeries(db, [a], 1, monthly, { from: "2026-01-01" })

    expect(cum.map((p) => p.date)).toEqual(["2026-01-01", "2026-02-01", "2026-03-01"])
    // 100 before the window + 20 in January, not just the in-window 20.
    expect(cum[0]).toMatchObject({ dividends: 20, interest: 0, total: 120, openingBalance: 100 })
    // February has no receipts: the curve is flat at 120.
    expect(cum[1]).toMatchObject({ total: 120, openingBalance: 100 })
    expect(cum[2]).toMatchObject({ total: 125, openingBalance: 100 })
  })

  it("excludes options from the curve", async () => {
    const a = await addPortfolio("user-1", "A")
    await addEvent(a, "2026-01-10", "dividend", "20")
    await addEvent(a, "2026-01-11", "option", "999")
    const agg = await aggregateIncome(db, [a], 1)
    const cum = await cumulativeIncomeSeries(db, [a], 1, monthlyIncomeSeries(agg))
    expect(cum[0]).toMatchObject({ dividends: 20, options: 0, total: 20 })
  })

  it("matches the canonical in-window income sum plus the opening", async () => {
    const a = await addPortfolio("user-1", "A")
    await addEvent(a, "2025-06-10", "dividend", "100")
    await addEvent(a, "2026-01-10", "dividend", "20")
    await addEvent(a, "2026-01-11", "interest", "5")
    const agg = await aggregateIncome(db, [a], 1, "2026-01-01", "2026-12-31")
    const cum = await cumulativeIncomeSeries(db, [a], 1, monthlyIncomeSeries(agg), { from: "2026-01-01" })
    const final = cum[cum.length - 1]
    expect(final.total).toBe(125) // 100 opening + 20 dividend + 5 interest
  })
})

describe("aggregateIncome label scope", () => {
  async function seedLabelled() {
    const a = await addPortfolio("user-1", "A")
    const [p] = await db.insert(positions).values({ userId: "user-1", symbol: "AAPL" }).returning({ id: positions.id })
    const [l1] = await db.insert(labels).values({ userId: "user-1", name: "L1", color: "#111111" }).returning({ id: labels.id })
    const [l2] = await db.insert(labels).values({ userId: "user-1", name: "L2", color: "#222222" }).returning({ id: labels.id })
    await db.insert(positionLabels).values([
      { positionId: p.id, labelId: l1.id },
      { positionId: p.id, labelId: l2.id },
    ])
    await db.insert(chartEventFacts).values({
      generation: 1,
      portfolioId: a,
      positionId: p.id,
      eventDate: "2026-01-10",
      receiptKind: "dividend",
      amountBase: "100",
      amountOriginal: "100",
      originalCurrency: "USD",
    })
    return { a, l1, l2 }
  }

  it("counts an event once when a position carries two selected labels", async () => {
    const { a, l1, l2 } = await seedLabelled()
    const one = await aggregateIncome(db, [a], 1, undefined, undefined, [l1.id])
    expect(one.annual[0].dividends).toBe(100)
    const both = await aggregateIncome(db, [a], 1, undefined, undefined, [l1.id, l2.id])
    expect(both.annual[0].dividends).toBe(100) // overlap intersects, never doubles
  })

  it("returns nothing for a label that matches no position", async () => {
    const { a } = await seedLabelled()
    const [other] = await db.insert(labels).values({ userId: "user-1", name: "L3", color: "#333333" }).returning({ id: labels.id })
    const out = await aggregateIncome(db, [a], 1, undefined, undefined, [other.id])
    expect(out.annual).toEqual([])
  })
})

describe("annualIncomeSeries", () => {
  const bucket = (period: string, dividends: number, interest = 0, options = 0) => ({
    period,
    dividends,
    interest,
    options,
    total: dividends + interest + options,
  })

  it("computes YoY from the prior year and labels the current year partial", () => {
    const out = annualIncomeSeries([bucket("2025", 100), bucket("2026", 125)], new Date("2026-06-15T00:00:00Z"))
    expect(out.map((p) => p.year)).toEqual([2025, 2026])
    expect(out[1]).toMatchObject({ total: 125, priorYearTotal: 100, yoyChangePercent: 25, partial: true })
    expect(out[0].partial).toBe(false)
    expect(out[0].yoyChangePercent).toBeNull() // no 2024 in the dataset
  })

  it("yields undefined YoY for a zero or missing prior year", () => {
    const out = annualIncomeSeries([bucket("2025", 0), bucket("2026", 125)])
    expect(out[1].priorYearTotal).toBe(0)
    expect(out[1].yoyChangePercent).toBeNull()
  })

  it("fills a gap year between observed years with a true zero bar", () => {
    const out = annualIncomeSeries([bucket("2024", 100), bucket("2026", 125)])
    expect(out.map((p) => p.year)).toEqual([2024, 2025, 2026])
    expect(out[1]).toMatchObject({ total: 0, dividends: 0, interest: 0, options: 0 })
    // The year after a zero prior has no ratio.
    expect(out[2].priorYearTotal).toBeNull()
    expect(out[2].yoyChangePercent).toBeNull()
  })

  it("keeps the annual total equal to the monthly and quarterly sums", async () => {
    const a = await addPortfolio("user-1", "A")
    await addEvent(a, "2026-01-10", "dividend", "100")
    await addEvent(a, "2026-02-10", "interest", "5")
    await addEvent(a, "2026-05-10", "dividend", "20")
    const agg = await aggregateIncome(db, [a], 1)
    const annual = annualIncomeSeries(agg.annual)
    const total = annual.reduce((s, p) => s + p.total, 0)
    const monthly = agg.monthly.reduce((s, b) => s + b.total, 0)
    const quarterly = agg.quarterly.reduce((s, b) => s + b.total, 0)
    expect(total).toBe(monthly)
    expect(total).toBe(quarterly)
    expect(total).toBe(125)
  })
})

describe("annualIncomeEquivalent", () => {
  const year = (y: number, total: number, partial = false): import("./income.js").AnnualIncomePoint => ({
    year: y,
    dividends: total,
    interest: 0,
    options: 0,
    total,
    priorYearTotal: null,
    yoyChangePercent: null,
    partial,
  })

  it("divides the annual total by 365 for the daily equivalent", () => {
    const out = annualIncomeEquivalent([year(2025, 365), year(2026, 730)], "day")
    expect(out.map((p) => p.amount)).toEqual([1, 2])
    expect(out[0]).toMatchObject({ basis: "days", divisor: 365 })
  })

  it("divides the annual total by 12 for the monthly equivalent", () => {
    const out = annualIncomeEquivalent([year(2025, 1200)], "month")
    expect(out[0]).toMatchObject({ amount: 100, basis: "months", divisor: 12 })
  })

  it("keeps 365 across a leap year and does not divide by elapsed days", () => {
    const out = annualIncomeEquivalent([year(2024, 366)], "day")
    expect(out[0]).toMatchObject({ divisor: 365, amount: roundish(366 / 365) })
  })

  it("marks the current partial year and still divides by the full-year divisor", () => {
    const out = annualIncomeEquivalent([year(2026, 600, true)], "month")
    expect(out[0]).toMatchObject({ amount: 50, partial: true, divisor: 12 })
  })

  it("matches the annual chart's totals", () => {
    const points = annualIncomeSeries([
      { period: "2026", dividends: 1200, interest: 0, options: 0, total: 1200 },
    ])
    const daily = annualIncomeEquivalent(points, "day")
    expect(daily[0].amount).toBe(roundish(points[0].total / 365))
  })
})

function roundish(n: number): number {
  return Math.round(n * 1e8) / 1e8
}
