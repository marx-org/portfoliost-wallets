/**
 * snapshots.test.ts (H9)
 *
 * Covers:
 *  - today's snapshot with 2 USD positions
 *  - multi-currency positions (PLN, EUR) via the instruments fx stand-in
 *  - backfill with 3 positions over 10 days
 *  - timeframe filter (6M / 1Y / ALL)
 *  - empty portfolio → timeSeries: []
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { and, eq, gte } from "drizzle-orm"
import { makeHarness } from "../routes/test-utils.js"
import {
  portfolios,
  portfolioTransactions,
  positions,
  valueSnapshots,
  portfolioCashTransactions,
} from "../db/schema.js"
import { snapshotPortfolioValue } from "./quotes.js"
import { runBackfill, calendarDays } from "./backfill.js"
import { __resetBackfillRunnerForTests } from "./backfill-runner.js"
import { mockInstrumentsFx, unmockInstrumentsFx } from "../test-fx-mock.js"

// ── helpers ────────────────────────────────────────────────────────────────

async function seedPortfolio(
  db: Awaited<ReturnType<typeof makeHarness>>["db"],
  userId: string,
  baseCurrency = "USD",
) {
  const [pf] = await db
    .insert(portfolios)
    .values({ userId, name: "Snap PF", baseCurrency })
    .returning()
  return pf
}

async function seedBuy(
  db: Awaited<ReturnType<typeof makeHarness>>["db"],
  userId: string,
  portfolioId: string,
  symbol: string,
  qty: number,
  price: number,
  date: string,
  ccy = "USD",
) {
  await db.insert(portfolioTransactions).values({
    userId,
    portfolioId,
    type: "BUY",
    instrumentSymbol: symbol,
    quantity: String(qty),
    price: String(price),
    currency: ccy,
    instrumentCurrency: ccy,
    totalAmount: String(qty * price),
    executedAt: new Date(`${date}T10:00:00Z`),
  })
  // §62.4 — pair a funding DEPOSIT so the position's cash nets to 0.
  await db.insert(portfolioCashTransactions).values({
    userId,
    portfolioId,
    type: "DEPOSIT",
    amount: String(qty * price),
    currency: ccy,
    transactionDate: date,
  })
}

async function seedPosition(
  db: Awaited<ReturnType<typeof makeHarness>>["db"],
  userId: string,
  portfolioId: string,
  symbol: string,
  qty: number,
  avg: number,
  ccy = "USD",
) {
  await db.insert(positions).values({
    userId,
    portfolioId,
    symbol,
    quantity: String(qty),
    averageCostBasis: String(avg),
    instrumentCurrency: ccy,
    isOpen: true,
    currentPrice: null,
    priceSource: "manual",
  })
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

// ── tests ──────────────────────────────────────────────────────────────────

describe("snapshotPortfolioValue — today snapshot", () => {
  afterEach(() => { vi.unstubAllGlobals(); unmockInstrumentsFx() })

  it("computes the right value for 2 USD positions and writes NOTHING (§76.4)", async () => {
    const { db, user } = await makeHarness("snap-2pos")
    const pf = await seedPortfolio(db, user.id)

    // Funding: 2750 USD deposited and immediately spent on the positions —
    // the deposit is the invested basis (net external flow, 2026-09-27); the
    // paired BUY keeps the cash balance at 0 (deposit − purchase).
    await db.insert(portfolioTransactions).values({
      userId: user.id, portfolioId: pf.id, type: "BUY", instrumentSymbol: "X",
      quantity: "1", price: "2750", currency: "USD", instrumentCurrency: "USD",
      totalAmount: "2750", executedAt: new Date("2026-09-01T09:00:00Z"),
    })
    await db.insert(portfolioCashTransactions).values({
      userId: user.id, portfolioId: pf.id, type: "DEPOSIT", amount: "2750",
      currency: "USD", transactionDate: "2026-09-01",
    })
    const posRows = [
      { marketValue: "2000", averageCostBasis: "200", quantity: "10", instrumentCurrency: "USD" },
      { marketValue: "750", averageCostBasis: "250", quantity: "3", instrumentCurrency: "USD" },
    ]
    const now = new Date("2026-09-01T10:00:00Z")
    const computed = await snapshotPortfolioValue(db, "Bearer t", pf.id, posRows, now)

    expect(computed.snapshotDate).toBe("2026-09-01")
    expect(Number(computed.value)).toBeCloseTo(2750)    // 2000 + 750
    expect(Number(computed.invested)).toBeCloseTo(2750) // = the deposit (net external flow)

    // §76.4 — `computeSnapshotBatch` is the single writer of value_snapshots.
    // This function used to upsert today's row here, making it a second writer
    // of the same (portfolioId, date) with whichever ran last winning.
    const snaps = await db.select().from(valueSnapshots).where(eq(valueSnapshots.portfolioId, pf.id))
    expect(snaps).toHaveLength(0)
  })

  it("applies FX conversion for multi-currency positions (PLN, EUR → USD)", async () => {
    const { db, user } = await makeHarness("snap-multiccy")
    const pf = await seedPortfolio(db, user.id, "USD")

    // EUR-based rates (plan §48.3 — resolved via the instruments stand-in):
    // 1 EUR = 1.10 USD, 1 EUR = 4.40 PLN
    // → PLN→USD = 1.10/4.40 = 0.25; EUR→USD = 1.10/1.10 = 1.0
    mockInstrumentsFx({ table: { USD: 1.10, PLN: 4.40 }, asOf: "2026-09-01" })

    // Funding deposits: 1000 USD (for the USD leg) + 4000 PLN (for the PLN
    // leg) → invested = 1000 + 4000×(1.10/4.40) = 1000 + 1000 = 2000 USD.
    // Paired BUYs (in the portfolio base, USD) keep the cash balance at 0.
    await db.insert(portfolioTransactions).values(
      [
        { userId: user.id, portfolioId: pf.id, type: "BUY", instrumentSymbol: "P", quantity: "1", price: "1000", currency: "USD", instrumentCurrency: "PLN", totalAmount: "1000", executedAt: new Date("2026-09-01T09:00:00Z") },
        { userId: user.id, portfolioId: pf.id, type: "BUY", instrumentSymbol: "U", quantity: "1", price: "1000", currency: "USD", instrumentCurrency: "USD", totalAmount: "1000", executedAt: new Date("2026-09-01T09:00:00Z") },
      ],
    )
    await db.insert(portfolioCashTransactions).values(
      [
        { userId: user.id, portfolioId: pf.id, type: "DEPOSIT", amount: "1000", currency: "USD", transactionDate: "2026-09-01" },
        { userId: user.id, portfolioId: pf.id, type: "DEPOSIT", amount: "4000", currency: "PLN", transactionDate: "2026-09-01" },
      ],
    )
    const posRows = [
      { marketValue: "4000", averageCostBasis: "400", quantity: "10", instrumentCurrency: "PLN" },
      // 4000 PLN → 4000 × (1.10/4.40) = 4000 × 0.25 = 1000 USD
      { marketValue: "1000", averageCostBasis: "900", quantity: "1", instrumentCurrency: "USD" },
      // 1000 USD → 1000 × (1.10/1.10) = 1000 USD
    ]
    const now = new Date("2026-09-01T10:00:00Z")
    const computed = await snapshotPortfolioValue(db, "Bearer t", pf.id, posRows, now)

    expect(Number(computed.value)).toBeCloseTo(1000 + 1000) // 2000 USD
    expect(Number(computed.invested)).toBeCloseTo(1000 + 1000) // deposits: 1000 USD + 4000 PLN→1000 USD
    // §76.4 — computed, not written; the batch owns the row.
    expect(await db.select().from(valueSnapshots).where(eq(valueSnapshots.portfolioId, pf.id))).toHaveLength(0)
  })

  it("empty portfolio — no positions → value and invested are 0", async () => {
    const { db, user } = await makeHarness("snap-empty")
    const pf = await seedPortfolio(db, user.id)

    const computed = await snapshotPortfolioValue(db, "Bearer t", pf.id, [], new Date("2026-09-01T10:00:00Z"))

    expect(Number(computed.value)).toBe(0)
    expect(Number(computed.invested)).toBe(0)
    // §76.4 — a position-less portfolio is exactly the case the BATCH must own:
    // `refreshQuotesUnlocked` returns early when there are no open positions, so
    // if this path wrote, a cash-only portfolio would never get today's row.
    expect(await db.select().from(valueSnapshots).where(eq(valueSnapshots.portfolioId, pf.id))).toHaveLength(0)
  })
})

describe("runBackfill — 3 positions over 10 days (H9)", () => {
  beforeEach(() => { process.env.INSTRUMENTS_URL = "http://instruments:3000" })
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.INSTRUMENTS_URL; __resetBackfillRunnerForTests() })

  it("builds a 10-day series for 3 symbols with correct daily values", async () => {
    const { db, user } = await makeHarness("snap-bf-10d")
    const pf = await seedPortfolio(db, user.id)

    // 3 symbols bought on day 1
    await seedBuy(db, user.id, pf.id, "AAA", 10, 100, "2026-07-01")
    await seedBuy(db, user.id, pf.id, "BBB", 5, 200, "2026-07-01")
    await seedBuy(db, user.id, pf.id, "CCC", 2, 500, "2026-07-01")
    await seedPosition(db, user.id, pf.id, "AAA", 10, 100)
    await seedPosition(db, user.id, pf.id, "BBB", 5, 200)
    await seedPosition(db, user.id, pf.id, "CCC", 2, 500)

    // Generate 10 days of prices
    const days = calendarDays("2026-07-01", "2026-07-10")
    mockPriceBars({
      AAA: { dates: days, closes: days.map((_, i) => 100 + i) },      // 100..109
      BBB: { dates: days, closes: days.map((_, i) => 200 + i * 2) },  // 200..218
      CCC: { dates: days, closes: days.map((_, i) => 500 + i * 5) },  // 500..545
    })

    const now = new Date("2026-07-11T00:00:00Z")
    await runBackfill(db, pf.id, "Bearer test", now)

    const snaps = await db
      .select()
      .from(valueSnapshots)
      .where(eq(valueSnapshots.portfolioId, pf.id))
      .orderBy(valueSnapshots.snapshotDate)

    expect(snaps).toHaveLength(10)

    // Day 0 (2026-07-01): 10×100 + 5×200 + 2×500 = 1000+1000+1000 = 3000
    expect(Number(snaps[0].value)).toBeCloseTo(3000)
    // Day 9 (2026-07-10): 10×109 + 5×218 + 2×545 = 1090+1090+1090 = 3270
    expect(Number(snaps[9].value)).toBeCloseTo(3270)
  })

  it("timeSeries is empty for a portfolio with no transactions", async () => {
    const { db, user } = await makeHarness("snap-notx")
    const pf = await seedPortfolio(db, user.id)

    mockPriceBars({})
    const now = new Date("2026-07-11T00:00:00Z")
    await runBackfill(db, pf.id, "Bearer test", now)

    const snaps = await db.select().from(valueSnapshots).where(eq(valueSnapshots.portfolioId, pf.id))
    expect(snaps).toHaveLength(0)
  })
})

describe("timeframe filter (H9)", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("6M cutoff returns only recent rows", async () => {
    const { db, user } = await makeHarness("snap-tf")
    const pf = await seedPortfolio(db, user.id)

    const dates = ["2024-09-01", "2025-09-01", "2026-03-01", "2026-09-01"]
    for (const d of dates) {
      await db.insert(valueSnapshots).values({
        portfolioId: pf.id, snapshotDate: d, value: "1000", invested: "900", netFlow: "0",
      })
    }

    const cutoff = "2026-03-01"
    const filtered = await db
      .select({ snapshotDate: valueSnapshots.snapshotDate })
      .from(valueSnapshots)
      .where(and(eq(valueSnapshots.portfolioId, pf.id), gte(valueSnapshots.snapshotDate, cutoff)))
      .orderBy(valueSnapshots.snapshotDate)

    expect(filtered.map((r) => r.snapshotDate)).toEqual(["2026-03-01", "2026-09-01"])
  })
})
