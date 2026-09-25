/** recompute.test.ts — POST /:id/recompute force-rebuild (plan §27.2) */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Hono } from "hono"
import { createPortfolioRoutes } from "./portfolios.js"
import { makeHarness } from "./test-utils.js"
import {
  portfolios,
  positions,
  portfolioTransactions,
  valueSnapshots,
  portfolioCashTransactions,
} from "../db/schema.js"
import { eq, and } from "drizzle-orm"
import { getBackfillStatus } from "../services/backfill.js"
import { __resetBackfillRunnerForTests } from "../services/backfill-runner.js"

type Harness = Awaited<ReturnType<typeof makeHarness>>
type DB = Harness["db"]

function app(db: Parameters<typeof createPortfolioRoutes>[0]) {
  const a = new Hono()
  a.route("/api/portfolios", createPortfolioRoutes(db))
  return a
}

function mockPriceBars(series: Record<string, { dates: string[]; closes: number[] }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      const sym = decodeURIComponent(String(url).match(/\/instruments\/([^/]+)\/price-bars/)?.[1] ?? "")
      const data = series[sym]
      if (!data) return Promise.resolve({ ok: false, json: async () => ({}) })
      return Promise.resolve({
        ok: true,
        json: async () => ({ symbol: sym, dates: data.dates, closes: data.closes, stale: false }),
      })
    }),
  )
}

async function seedPortfolio(db: DB, userId: string) {
  const [pf] = await db
    .insert(portfolios)
    .values({ userId, name: "Recompute PF", baseCurrency: "USD" })
    .returning()
  return pf
}

async function seedBuy(db: DB, userId: string, portfolioId: string, symbol: string, qty: number, price: number, date: string) {
  await db.insert(portfolioTransactions).values({
    userId,
    portfolioId,
    type: "BUY",
    instrumentSymbol: symbol,
    quantity: String(qty),
    price: String(price),
    currency: "USD",
    instrumentCurrency: "USD",
    totalAmount: String(qty * price),
    executedAt: new Date(`${date}T12:00:00Z`),
  })
  // §62.4 — pair a funding DEPOSIT so the position's cash nets to 0.
  await db.insert(portfolioCashTransactions).values({
    userId,
    portfolioId,
    type: "DEPOSIT",
    amount: String(qty * price),
    currency: "USD",
    transactionDate: date,
  })
}

async function seedPosition(db: DB, userId: string, portfolioId: string, symbol: string, qty: number, avg: number) {
  await db.insert(positions).values({
    userId,
    portfolioId,
    symbol,
    quantity: String(qty),
    averageCostBasis: String(avg),
    instrumentCurrency: "USD",
    isOpen: true,
    currentPrice: null,
    priceSource: "manual",
  })
}

/** Poll until the enqueued recompute pass has drained (status flips to terminal). */
async function waitForComplete(db: DB, portfolioId: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const status = await getBackfillStatus(db, portfolioId)
    if (status === "complete" || status === "failed") return status
    if (Date.now() > deadline) throw new Error(`recompute did not finish in time (last status: ${status})`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe("POST /api/portfolios/:id/recompute (plan §27.2)", () => {
  beforeEach(() => {
    process.env.INSTRUMENTS_URL = "http://instruments:3000"
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.INSTRUMENTS_URL
    __resetBackfillRunnerForTests()
  })

  it("404 for a portfolio not owned by the user", async () => {
    const h = await makeHarness("recalc-route-owner")
    const a = app(h.db)
    // Portfolio owned by a different user
    const other = await seedPortfolio(h.db, "someone-else")

    const res = await a.request(`/api/portfolios/${other.id}/recompute`, {
      method: "POST",
      headers: h.headers,
    })
    expect(res.status).toBe(404)

    // A nonexistent id also 404s
    const res2 = await a.request("/api/portfolios/00000000-0000-0000-0000-000000000000/recompute", {
      method: "POST",
      headers: h.headers,
    })
    expect(res2.status).toBe(404)
  })

  it("returns pending and rebuilds value_snapshots from BUYs once the pass drains", async () => {
    const h = await makeHarness("recalc-route-build")
    const a = app(h.db)
    const pf = await seedPortfolio(h.db, h.user.id)
    await seedBuy(h.db, h.user.id, pf.id, "AAPL", 10, 150, "2026-07-01")
    await seedPosition(h.db, h.user.id, pf.id, "AAPL", 10, 150)
    mockPriceBars({ AAPL: { dates: ["2026-07-01", "2026-07-02", "2026-07-03"], closes: [150, 155, 160] } })

    const res = await a.request(`/api/portfolios/${pf.id}/recompute`, { method: "POST", headers: h.headers })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ backfillStatus: "pending" })

    expect(await waitForComplete(h.db, pf.id)).toBe("complete")
    const snaps = await h.db
      .select()
      .from(valueSnapshots)
      .where(eq(valueSnapshots.portfolioId, pf.id))
      .orderBy(valueSnapshots.snapshotDate)
    const byDate = new Map(snaps.map((s) => [s.snapshotDate, Number(s.value)]))
    expect(byDate.get("2026-07-01")).toBeCloseTo(1500)
    expect(byDate.get("2026-07-03")).toBeCloseTo(1600)
  })

  it("replaces stale rows: a day after the position was fully sold disappears", async () => {
    const h = await makeHarness("recalc-route-stale")
    const a = app(h.db)
    const pf = await seedPortfolio(h.db, h.user.id)
    await seedBuy(h.db, h.user.id, pf.id, "AAPL", 10, 150, "2026-07-01")
    // Full sale two days later — no open position from 2026-07-02 on
    await h.db.insert(portfolioTransactions).values({
      userId: h.user.id,
      portfolioId: pf.id,
      type: "SELL",
      instrumentSymbol: "AAPL",
      quantity: "10",
      price: "155",
      currency: "USD",
      instrumentCurrency: "USD",
      totalAmount: "1550",
      executedAt: new Date("2026-07-02T12:00:00Z"),
    })
    await seedPosition(h.db, h.user.id, pf.id, "AAPL", 10, 150)
    // Stale snapshot row on a day with no open position (after full sale).
    await h.db.insert(valueSnapshots).values([
      { portfolioId: pf.id, snapshotDate: "2026-06-15", value: "9999", invested: "9999" },
      { portfolioId: pf.id, snapshotDate: "2026-07-01", value: "1", invested: "1" },
    ])
    mockPriceBars({ AAPL: { dates: ["2026-07-01", "2026-07-02"], closes: [150, 155] } })

    const res = await a.request(`/api/portfolios/${pf.id}/recompute`, { method: "POST", headers: h.headers })
    expect(res.status).toBe(200)
    expect(await waitForComplete(h.db, pf.id)).toBe("complete")

    const dates = (await h.db.select().from(valueSnapshots).where(eq(valueSnapshots.portfolioId, pf.id))).map((s) => s.snapshotDate)
    expect(dates).not.toContain("2026-06-15") // stale day removed by full replace
    // §62.4 — after the full SELL the proceeds are held as cash, so later days
    // carry the cash value (the sale proceeds), not nothing.
    expect(dates).toContain("2026-07-03")
    const sold = await h.db
      .select({ value: valueSnapshots.value })
      .from(valueSnapshots)
      .where(and(eq(valueSnapshots.portfolioId, pf.id), eq(valueSnapshots.snapshotDate, "2026-07-03")))
    expect(Number(sold[0].value)).toBeCloseTo(1550) // sale proceeds as cash
    expect(dates).toContain("2026-07-01")
  })

  it("BUY/SELL-less portfolio: marks complete with 0 rows, no crash", async () => {
    const h = await makeHarness("recalc-route-empty")
    const a = app(h.db)
    const pf = await seedPortfolio(h.db, h.user.id)
    mockPriceBars({})

    const res = await a.request(`/api/portfolios/${pf.id}/recompute`, { method: "POST", headers: h.headers })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ backfillStatus: "pending" })

    expect(await waitForComplete(h.db, pf.id)).toBe("complete")
    const snaps = await h.db.select().from(valueSnapshots).where(eq(valueSnapshots.portfolioId, pf.id))
    expect(snaps.length).toBe(0)
  })
})
