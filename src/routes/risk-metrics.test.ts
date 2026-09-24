/** risk-metrics.test.ts — route-level tests for GET /:id/risk-metrics (plan 2.6) */
import { describe, expect, it } from "vitest"
import { Hono } from "hono"
import { createPortfolioRoutes } from "./portfolios.js"
import { makeHarness } from "./test-utils.js"
import { portfolios, valueSnapshots } from "../db/schema.js"
import { calendarDays } from "../services/backfill.js"

function app(db: Parameters<typeof createPortfolioRoutes>[0]) {
  const a = new Hono()
  a.route("/api/portfolios", createPortfolioRoutes(db))
  return a
}

async function seedPortfolio(db: Awaited<ReturnType<typeof makeHarness>>["db"], userId: string) {
  const [pf] = await db
    .insert(portfolios)
    .values({ userId, name: "Risk PF", baseCurrency: "USD" })
    .returning()
  return pf
}

/**
 * Seed `n` daily snapshots with linearly rising values (UTC-safe dates).
 * Uses calendarDays to avoid local-timezone date arithmetic bugs.
 */
async function seedLinearSnapshots(
  db: Awaited<ReturnType<typeof makeHarness>>["db"],
  portfolioId: string,
  n: number,
  startValue = 1000,
  step = 5,
  startDate = "2025-01-01",
) {
  // Derive the end date by adding n-1 days to startDate (UTC)
  const endMs = new Date(`${startDate}T00:00:00Z`).getTime() + (n - 1) * 86400000
  const endDate = new Date(endMs).toISOString().slice(0, 10)
  const days = calendarDays(startDate, endDate)

  for (const [i, date] of days.entries()) {
    const value = String(startValue + i * step)
    await db.insert(valueSnapshots).values({
      portfolioId,
      snapshotDate: date,
      value,
      invested: String(startValue),
      netFlow: "0",
      cumulativeTwr: String(100 + i),
      cumulativeMwr: String(100 + i),
    })
  }
}

describe("GET /:id/risk-metrics", () => {
  it("returns 404 for an unknown portfolio", async () => {
    const { db, headers } = await makeHarness("rm-404")
    const a = app(db)
    const res = await a.request("/api/portfolios/00000000-0000-0000-0000-000000000000/risk-metrics", { headers })
    expect(res.status).toBe(404)
  })

  it("returns 401 when auth headers are missing", async () => {
    const { db, user } = await makeHarness("rm-401")
    const a = app(db)
    const pf = await seedPortfolio(db, user.id)
    const res = await a.request(`/api/portfolios/${pf.id}/risk-metrics`, { headers: {} })
    expect(res.status).toBe(401)
  })

  it("returns zeros/null for portfolio with no snapshots", async () => {
    const { db, user, headers } = await makeHarness("rm-empty")
    const a = app(db)
    const pf = await seedPortfolio(db, user.id)

    const res = await a.request(`/api/portfolios/${pf.id}/risk-metrics`, { headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sharpeRatio).toBe(0)
    expect(body.maxDrawdown).toBe(0)
    expect(body.volatility).toBe(0)
    expect(body.winRate).toBe(0)
    expect(body.annualizedReturn).toBeNull()
    expect(body.annualizedReturnWithheldReason).toBe("insufficient_history")
  })

  it("returns positive sharpe/sortino and winRate=100 for a rising series", async () => {
    const { db, user, headers } = await makeHarness("rm-rising")
    const a = app(db)
    const pf = await seedPortfolio(db, user.id)
    // 252 snapshots rising by 5 per day
    await seedLinearSnapshots(db, pf.id, 252, 1000, 5)

    const res = await a.request(`/api/portfolios/${pf.id}/risk-metrics?timeframe=ALL`, { headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sharpeRatio).toBeGreaterThan(0)
    expect(body.sortinoRatio).toBeGreaterThan(0)
    expect(body.winRate).toBe(100)
    expect(body.volatility).toBeGreaterThan(0)
    expect(body.maxDrawdown).toBe(0)   // no drawdown on purely rising series
    expect(body.periodReturnPercent).toBeGreaterThan(0)
  })

  it("returns a non-null annualizedReturn for long enough history (>= 60pts, >= 90 days)", async () => {
    const { db, user, headers } = await makeHarness("rm-annret")
    const a = app(db)
    const pf = await seedPortfolio(db, user.id)
    // 100 snapshots starting 2025-01-01 → 2025-04-11 (> 90 calendar days)
    await seedLinearSnapshots(db, pf.id, 100, 1000, 5, "2025-01-01")

    const res = await a.request(`/api/portfolios/${pf.id}/risk-metrics?timeframe=ALL`, { headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.annualizedReturn).not.toBeNull()
    expect(body.annualizedReturnWithheldReason).toBeNull()
  })

  it("withholds annualizedReturn when timeframe window is too short (< 60 pts)", async () => {
    const { db, user, headers } = await makeHarness("rm-short")
    const a = app(db)
    const pf = await seedPortfolio(db, user.id)
    // Seed 100 historical snapshots but query only the last 1M (≈30 days)
    await seedLinearSnapshots(db, pf.id, 100, 1000, 5, "2025-01-01")

    const res = await a.request(`/api/portfolios/${pf.id}/risk-metrics?timeframe=1M`, { headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.annualizedReturnWithheldReason).toBe("insufficient_history")
    expect(body.annualizedReturn).toBeNull()
  })

  it("returns moneyWeightedReturn from the last cumulativeMwr snapshot", async () => {
    const { db, user, headers } = await makeHarness("rm-mwr")
    const a = app(db)
    const pf = await seedPortfolio(db, user.id)
    // 3 snapshots with explicit MWR values
    const days = calendarDays("2026-07-01", "2026-07-03")
    for (const [i, d] of days.entries()) {
      await db.insert(valueSnapshots).values({
        portfolioId: pf.id,
        snapshotDate: d,
        value: String(1000 + i * 50),
        invested: "1000",
        netFlow: "0",
        cumulativeMwr: String(100 + i * 5), // last = 110
      })
    }

    const res = await a.request(`/api/portfolios/${pf.id}/risk-metrics?timeframe=ALL`, { headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    // mwrPercent = lastMwr (110) − 100 = 10
    expect(body.moneyWeightedReturn).toBe(10)
  })

  it("returns null moneyWeightedReturn when no snapshots exist", async () => {
    const { db, user, headers } = await makeHarness("rm-nomwr")
    const a = app(db)
    const pf = await seedPortfolio(db, user.id)

    const res = await a.request(`/api/portfolios/${pf.id}/risk-metrics`, { headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.moneyWeightedReturn).toBeNull()
  })

  it("respects the timeframe query param and trims the series", async () => {
    const { db, user, headers } = await makeHarness("rm-timeframe")
    const a = app(db)
    const pf = await seedPortfolio(db, user.id)
    // Seed 252 snapshots (ALL) and compare ALL vs 1M
    await seedLinearSnapshots(db, pf.id, 252, 1000, 5)

    const resAll = await a.request(`/api/portfolios/${pf.id}/risk-metrics?timeframe=ALL`, { headers })
    const res1M = await a.request(`/api/portfolios/${pf.id}/risk-metrics?timeframe=1M`, { headers })

    expect(resAll.status).toBe(200)
    expect(res1M.status).toBe(200)

    const all = await resAll.json()
    const m1 = await res1M.json()
    // Longer history → larger period return
    expect(all.periodReturnPercent).toBeGreaterThan(m1.periodReturnPercent)
  })
})
