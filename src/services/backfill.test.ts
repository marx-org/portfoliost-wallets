import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { crossRate } from "@marx2/contracts/fx"
import { makeHarness } from "../routes/test-utils.js"
import { portfolios, portfolioTransactions, positions, valueSnapshots, portfolioCashTransactions, portfolioBackfillMetadata } from "../db/schema.js"
import { eq, and } from "drizzle-orm"
import {
  buildPriceMap,
  calendarDays,
  computeSnapshotBatch,
  getBackfillStatus,
  runBackfill,
  recalcPortfolioHistory,
  recalcPortfolioSeries,
} from "./backfill.js"
import { snapshotPortfolioValue, __resetQuoteCachesForTests } from "./quotes.js"
import { __resetBackfillRunnerForTests } from "./backfill-runner.js"

// ── mock fetch for instruments price-bars ──────────────────────────────

function mockPriceBars(
  series: Record<string, { dates: string[]; closes: number[]; currency?: string; rateToBase?: number }>,
) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      const sym = decodeURIComponent(String(url).match(/\/instruments\/([^/]+)\/price-bars/)?.[1] ?? "")
      const data = series[sym]
      // §63.10 — 404 is the documented "no data for this key" answer, so a symbol
      // with no series is a *gap*, not an aborted pass. Any other non-2xx aborts.
      if (!data) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) })
      // §72.15 — `?currency=<X>` is how the grid asks for a conversion, and the
      // response states the currency of the closes it hands back.
      const wants = new URL(String(url), "http://x").searchParams.get("currency")
      const converted = wants && data.currency && data.currency !== wants
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          symbol: sym,
          dates: data.dates,
          closes: converted
            ? data.closes.map((c) => c * (data.rateToBase ?? 1))
            : data.closes,
          stale: false,
          currency: converted ? wants : (data.currency ?? null),
        }),
      })
    }),
  )
}

// ── helpers ────────────────────────────────────────────────────────────

async function seedPortfolio(
  db: Awaited<ReturnType<typeof makeHarness>>["db"],
  userId: string,
  baseCurrency = "USD",
) {
  const [pf] = await db
    .insert(portfolios)
    .values({ userId, name: "BF Test PF", baseCurrency })
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
    executedAt: new Date(`${date}T12:00:00Z`),
  })
  // §62.4 — fund the BUY with a same-day DEPOSIT so the position's cash nets
  // to 0 (real imports pair a deposit with the buy); value = position value.
  await db.insert(portfolioCashTransactions).values({
    userId,
    portfolioId,
    type: "DEPOSIT",
    amount: String(qty * price),
    currency: ccy,
    transactionDate: date,
  })
}

/** Mirror of {@link seedBuy} for a SELL, so a position can be fully closed. */
async function seedSell(
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
    type: "SELL",
    instrumentSymbol: symbol,
    quantity: String(qty),
    price: String(price),
    currency: ccy,
    instrumentCurrency: ccy,
    totalAmount: String(qty * price),
    executedAt: new Date(`${date}T12:00:00Z`),
  })
}

/** A cash-only portfolio: a DEPOSIT and no positions at all. */async function seedCash(
  db: Awaited<ReturnType<typeof makeHarness>>["db"],
  userId: string,
  portfolioId: string,
  amount: number,
  currency: string,
  date: string,
) {
  await db.insert(portfolioCashTransactions).values({
    userId,
    portfolioId,
    type: "DEPOSIT",
    amount: String(amount),
    currency,
    transactionDate: date,
  })
}

async function seedPosition(
  db: Awaited<ReturnType<typeof makeHarness>>["db"],
  userId: string,
  portfolioId: string,
  symbol: string,
  qty: number,  avg: number,
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

// ── unit tests ─────────────────────────────────────────────────────────

describe("calendarDays", () => {
  it("enumerates inclusive range", () => {
    expect(calendarDays("2026-07-01", "2026-07-03")).toEqual([
      "2026-07-01",
      "2026-07-02",
      "2026-07-03",
    ])
  })
  it("returns single day when from === to", () => {
    expect(calendarDays("2026-07-01", "2026-07-01")).toEqual(["2026-07-01"])
  })
  it("returns empty when from > to", () => {
    expect(calendarDays("2026-07-03", "2026-07-01")).toEqual([])
  })
})

describe("buildPriceMap", () => {
  it("carries forward last known close on gaps", () => {
    const days = ["2026-07-07", "2026-07-08", "2026-07-09", "2026-07-10"]
    // price only on Mon + Thu
    const map = buildPriceMap(
      ["2026-07-07", "2026-07-10"],
      [100, 105],
      days,
    )
    expect(map.get("2026-07-07")).toBe(100)
    expect(map.get("2026-07-08")).toBe(100) // carry
    expect(map.get("2026-07-09")).toBe(100) // carry
    expect(map.get("2026-07-10")).toBe(105)
  })
  it("returns no entry for days before first known price", () => {
    const map = buildPriceMap(["2026-07-10"], [100], ["2026-07-08", "2026-07-09", "2026-07-10"])
    expect(map.has("2026-07-08")).toBe(false)
    expect(map.has("2026-07-09")).toBe(false)
    expect(map.get("2026-07-10")).toBe(100)
  })
})

describe("runBackfill (H6)", () => {
  beforeEach(() => {
    process.env.INSTRUMENTS_URL = "http://instruments:3000"
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.INSTRUMENTS_URL
    __resetBackfillRunnerForTests()
  })

  it("upserts daily value snapshots for a simple single-symbol portfolio", async () => {
    const { db, user } = await makeHarness("bf-user-1")
    const pf = await seedPortfolio(db, user.id)
    await seedBuy(db, user.id, pf.id, "AAPL", 10, 150, "2026-07-01")
    await seedPosition(db, user.id, pf.id, "AAPL", 10, 150)

    // instruments returns price for Jul 1-3
    mockPriceBars({
      AAPL: {
        dates: ["2026-07-01", "2026-07-02", "2026-07-03"],
        closes: [150, 155, 160],
      },
    })

    const now = new Date("2026-07-04T00:00:00Z") // yesterday = 2026-07-03
    await runBackfill(db, pf.id, "Bearer test", now)

    const snaps = await db
      .select()
      .from(valueSnapshots)
      .where(eq(valueSnapshots.portfolioId, pf.id))
      .orderBy(valueSnapshots.snapshotDate)

    expect(snaps.length).toBeGreaterThanOrEqual(3)
    const byDate = new Map(snaps.map((s) => [s.snapshotDate, Number(s.value)]))
    expect(byDate.get("2026-07-01")).toBeCloseTo(1500) // 10 × 150
    expect(byDate.get("2026-07-02")).toBeCloseTo(1550) // 10 × 155
    expect(byDate.get("2026-07-03")).toBeCloseTo(1600) // 10 × 160

    // Mark #1 (D50): BUY day carries the deployed cash as netFlow
    const netFlowByDate = new Map(snaps.map((s) => [s.snapshotDate, Number(s.netFlow)]))
    expect(netFlowByDate.get("2026-07-01")).toBeCloseTo(1500)
    expect(netFlowByDate.get("2026-07-02")).toBe(0)
  })

  it("carries forward price on weekend gaps", async () => {
    const { db, user } = await makeHarness("bf-user-2")
    const pf = await seedPortfolio(db, user.id)
    await seedBuy(db, user.id, pf.id, "MSFT", 5, 300, "2026-07-06") // Monday
    await seedPosition(db, user.id, pf.id, "MSFT", 5, 300)

    // price only on Mon and following Mon — 4 day gap (Tue-Sun carry)
    mockPriceBars({
      MSFT: {
        dates: ["2026-07-06", "2026-07-13"],
        closes: [300, 310],
      },
    })

    const now = new Date("2026-07-14T00:00:00Z")
    await runBackfill(db, pf.id, "Bearer test", now)

    const snaps = await db
      .select()
      .from(valueSnapshots)
      .where(eq(valueSnapshots.portfolioId, pf.id))
      .orderBy(valueSnapshots.snapshotDate)

    const byDate = new Map(snaps.map((s) => [s.snapshotDate, Number(s.value)]))
    // Tue–Sun should carry 300 × 5 = 1500
    expect(byDate.get("2026-07-07")).toBeCloseTo(1500)
    expect(byDate.get("2026-07-12")).toBeCloseTo(1500)
    expect(byDate.get("2026-07-13")).toBeCloseTo(1550) // 5 × 310
  })

  it("is idempotent — second run does not duplicate rows", async () => {
    const { db, user } = await makeHarness("bf-user-3")
    const pf = await seedPortfolio(db, user.id)
    await seedBuy(db, user.id, pf.id, "GOOG", 2, 200, "2026-07-01")
    await seedPosition(db, user.id, pf.id, "GOOG", 2, 200)

    mockPriceBars({ GOOG: { dates: ["2026-07-01", "2026-07-02"], closes: [200, 205] } })

    const now = new Date("2026-07-03T00:00:00Z")
    await runBackfill(db, pf.id, "Bearer test", now)
    await runBackfill(db, pf.id, "Bearer test", now)

    const snaps = await db
      .select()
      .from(valueSnapshots)
      .where(eq(valueSnapshots.portfolioId, pf.id))

    expect(snaps.length).toBe(2)
  })

  it("marks status complete after successful run", async () => {
    const { db, user } = await makeHarness("bf-user-4")
    const pf = await seedPortfolio(db, user.id)
    await seedBuy(db, user.id, pf.id, "TSLA", 1, 250, "2026-07-01")
    await seedPosition(db, user.id, pf.id, "TSLA", 1, 250)

    mockPriceBars({ TSLA: { dates: ["2026-07-01"], closes: [250] } })

    const now = new Date("2026-07-02T00:00:00Z")
    await runBackfill(db, pf.id, "Bearer test", now)

    expect(await getBackfillStatus(db, pf.id)).toBe("complete")
  })

  it("marks status failed when instruments unreachable", async () => {
    const { db, user } = await makeHarness("bf-user-5")
    const pf = await seedPortfolio(db, user.id)
    await seedBuy(db, user.id, pf.id, "NFLX", 1, 600, "2026-07-01")
    await seedPosition(db, user.id, pf.id, "NFLX", 1, 600)

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")))
    const now = new Date("2026-07-02T00:00:00Z")
    await runBackfill(db, pf.id, "Bearer test", now)
    // §63.10 — an unreachable price source used to look like "no prices" and the
    // pass still reported 'complete', which is how the fleet ended up with
    // cash-only snapshots. It must now be a failure.
    expect(await getBackfillStatus(db, pf.id)).toBe("failed")
  })

  it("§63.10 — leaves the previous snapshots untouched when the pass cannot price", async () => {
    const { db, user } = await makeHarness("keep-old-user-1")
    const pf = await seedPortfolio(db, user.id)
    await seedBuy(db, user.id, pf.id, "NFLX", 1, 600, "2026-07-01")
    await seedPosition(db, user.id, pf.id, "NFLX", 1, 600)

    // A good pass first, so there is a correct stored value to protect.
    mockPriceBars({ NFLX: { dates: ["2026-07-01", "2026-07-02"], closes: [600, 610] } })
    await runBackfill(db, pf.id, "Bearer t", new Date("2026-07-03T00:00:00Z"))
    const before = await db
      .select()
      .from(valueSnapshots)
      .where(eq(valueSnapshots.portfolioId, pf.id))
      .orderBy(valueSnapshots.snapshotDate)
    expect(before.length).toBeGreaterThan(0)

    // Now the price source rejects us the way a 401 does.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }),
    )
    await runBackfill(db, pf.id, "Bearer t", new Date("2026-07-04T00:00:00Z"))

    const after = await db
      .select()
      .from(valueSnapshots)
      .where(eq(valueSnapshots.portfolioId, pf.id))
      .orderBy(valueSnapshots.snapshotDate)
    expect(after).toEqual(before)
    expect(await getBackfillStatus(db, pf.id)).toBe("failed")
    const [meta] = await db
      .select()
      .from(portfolioBackfillMetadata)
      .where(eq(portfolioBackfillMetadata.portfolioId, pf.id))
    expect(meta?.errorMessage ?? "").toMatch(/401/)
  })

  it("§63.10 — refuses a pass that priced 0 of N held symbols, but allows a partial one", async () => {
    const { db, user } = await makeHarness("unpriceable-user-1")
    const pf = await seedPortfolio(db, user.id)
    await seedBuy(db, user.id, pf.id, "AAA", 10, 100, "2026-07-01")
    await seedBuy(db, user.id, pf.id, "BBB", 5, 200, "2026-07-01")
    await seedPosition(db, user.id, pf.id, "AAA", 10, 100)
    await seedPosition(db, user.id, pf.id, "BBB", 5, 200)

    // A 200-with-no-dates for every symbol is what a collapsed price source
    // looks like once it stops throwing: priced 0 of 2.
    mockPriceBars({})
    await runBackfill(db, pf.id, "Bearer t", new Date("2026-07-03T00:00:00Z"))
    expect(await getBackfillStatus(db, pf.id)).toBe("failed")
    expect(
      (await db.select().from(valueSnapshots).where(eq(valueSnapshots.portfolioId, pf.id))).length,
    ).toBe(0)

    // One symbol priced is a legitimate partial sum: written, and flagged.
    mockPriceBars({ AAA: { dates: ["2026-07-01", "2026-07-02"], closes: [100, 110] } })
    await runBackfill(db, pf.id, "Bearer t", new Date("2026-07-03T00:00:00Z"))
    expect(await getBackfillStatus(db, pf.id)).toBe("complete")
    expect(
      (await db.select().from(valueSnapshots).where(eq(valueSnapshots.portfolioId, pf.id))).length,
    ).toBeGreaterThan(0)
  })

  it("§63.10 — an all-cash portfolio (0 held symbols) is not 'unpriceable'", async () => {
    const { db, user } = await makeHarness("cash-only-user-1")
    const pf = await seedPortfolio(db, user.id)
    await seedCash(db, user.id, pf.id, 1000, "USD", "2026-07-01")
    mockPriceBars({})
    await runBackfill(db, pf.id, "Bearer t", new Date("2026-07-03T00:00:00Z"))
    expect(await getBackfillStatus(db, pf.id)).toBe("complete")
  })

  it("§63.10.5 — declares the known base currency so an ambiguous listing can convert", async () => {
    // AFL-style: instruments cannot resolve whether AFL is NYSE(USD) or ASX(AUD),
    // so `?currency=PLN` alone 400s and — pre-§63.10.5 — took the whole portfolio
    // with it. The position's own instrumentCurrency is the authority the import
    // recorded, so the backfill sends it as `baseCurrency`.
    const { db, user } = await makeHarness("declared-base-user-1")
    const pf = await seedPortfolio(db, user.id, "PLN")
    await seedBuy(db, user.id, pf.id, "AFL", 10, 100, "2026-07-01", "USD")
    await seedPosition(db, user.id, pf.id, "AFL", 10, 100)

    const seen: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        seen.push(String(url))
        if (String(url).includes("/api/instruments/")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              symbol: "AFL",
              dates: ["2026-07-01", "2026-07-02"],
              closes: [420, 431],
              currency: "PLN",
              baseCurrency: "USD",
              stale: false,
            }),
          })
        }
        // the FX pair leg
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ rate: 1, asOf: "2026-07-02" }),
        })
      }),
    )

    await runBackfill(db, pf.id, "Bearer t", new Date("2026-07-03T00:00:00Z"))

    const priceCall = seen.find((u) => u.includes("/price-bars"))!
    expect(priceCall).toContain("currency=PLN")
    expect(priceCall).toContain("baseCurrency=USD")
    expect(await getBackfillStatus(db, pf.id)).toBe("complete")
  })

  it("§63.10.5 — does not price a symbol the portfolio no longer holds", async () => {
    // A long-closed position (bought and sold inside the window, so qty is 0 on
    // every day) must not be fetched: it contributes nothing, and in PROD one of
    // them (AFL, sold 2024-03, currency unresolvable -> 400) aborted the entire
    // portfolio and left its stored value stale.
    const { db, user } = await makeHarness("closed-symbol-user-1")
    const pf = await seedPortfolio(db, user.id)
    await seedBuy(db, user.id, pf.id, "AAA", 10, 100, "2026-07-01")
    await seedSell(db, user.id, pf.id, "OLD", 5, 200, "2026-07-02")
    await seedPosition(db, user.id, pf.id, "AAA", 10, 100)

    const asked: string[] = []
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const sym = decodeURIComponent(String(url).match(/\/instruments\/([^/]+)\/price-bars/)?.[1] ?? "")
        asked.push(sym)
        if (sym !== "AAA") {
          return Promise.resolve({ ok: false, status: 400, json: async () => ({ error: "BadRequest" }) })
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ symbol: "AAA", dates: ["2026-07-01", "2026-07-02"], closes: [100, 110], stale: false }),
        })
      }),
    )

    await runBackfill(db, pf.id, "Bearer t", new Date("2026-07-03T00:00:00Z"))

    expect(asked).toContain("AAA")
    expect(asked).not.toContain("OLD")
    expect(await getBackfillStatus(db, pf.id)).toBe("complete")
    expect(
      (await db.select().from(valueSnapshots).where(eq(valueSnapshots.portfolioId, pf.id))).length,
    ).toBeGreaterThan(0)
  })

})

describe("§63.8 — backfill records held-but-unpriced symbols (no silent under-report)", () => {
  beforeEach(() => {
    process.env.INSTRUMENTS_URL = "http://instruments:3000"
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.INSTRUMENTS_URL
    __resetBackfillRunnerForTests()
  })

  it("flags a held symbol with no price bar as a gap (value is a partial sum)", async () => {
    const { db, user } = await makeHarness("gap-user-1")
    const pf = await seedPortfolio(db, user.id)
    // Two held symbols; only AAA has price bars — BBB is dropped from every day.
    await seedBuy(db, user.id, pf.id, "AAA", 10, 100, "2026-07-01")
    await seedBuy(db, user.id, pf.id, "BBB", 5, 200, "2026-07-01")
    mockPriceBars({
      AAA: { dates: ["2026-07-01", "2026-07-02"], closes: [100, 110] },
      // BBB intentionally absent → 404 → dropped
    })

    await runBackfill(db, pf.id, "Bearer t", new Date("2026-07-03T00:00:00Z"))

    const [meta] = await db
      .select({ gapSymbols: portfolioBackfillMetadata.gapSymbols })
      .from(portfolioBackfillMetadata)
      .where(eq(portfolioBackfillMetadata.portfolioId, pf.id))
    expect(meta?.gapSymbols).toEqual(["BBB"])

    // And the stored value is the partial sum (AAA only) — the under-report the
    // flag exists to surface.
    const day2 = await db
      .select({ value: valueSnapshots.value })
      .from(valueSnapshots)
      .where(and(eq(valueSnapshots.portfolioId, pf.id), eq(valueSnapshots.snapshotDate, "2026-07-02")))
    expect(Number(day2[0]?.value ?? 0)).toBeCloseTo(1100) // 10 × 110, BBB missing
  })

  it("clears the gap once the missing symbol is priced", async () => {
    const { db, user } = await makeHarness("gap-user-2")
    const pf = await seedPortfolio(db, user.id)
    await seedBuy(db, user.id, pf.id, "AAA", 10, 100, "2026-07-01")
    await seedBuy(db, user.id, pf.id, "BBB", 5, 200, "2026-07-01")

    // First pass: BBB unpriced → gap recorded.
    mockPriceBars({ AAA: { dates: ["2026-07-01", "2026-07-02"], closes: [100, 110] } })
    await runBackfill(db, pf.id, "Bearer t", new Date("2026-07-03T00:00:00Z"))
    expect(
      (await db.select().from(portfolioBackfillMetadata).where(eq(portfolioBackfillMetadata.portfolioId, pf.id)))[0]
        ?.gapSymbols,
    ).toEqual(["BBB"])

    // Second pass: BBB now has bars → gap cleared (null), value complete.
    mockPriceBars({
      AAA: { dates: ["2026-07-01", "2026-07-02"], closes: [100, 110] },
      BBB: { dates: ["2026-07-01", "2026-07-02"], closes: [200, 210] },
    })
    await runBackfill(db, pf.id, "Bearer t", new Date("2026-07-03T00:00:00Z"))
    expect(
      (await db.select().from(portfolioBackfillMetadata).where(eq(portfolioBackfillMetadata.portfolioId, pf.id)))[0]
        ?.gapSymbols,
    ).toBeNull()
  })
})

describe("§72.30 — a gap anywhere in the window is reported, not just on the last day", () => {
  beforeEach(() => {
    process.env.INSTRUMENTS_URL = "http://instruments:3000"
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.INSTRUMENTS_URL
    __resetBackfillRunnerForTests()
  })

  it("flags a symbol that was held and unpriced EARLIER in the window, then sold", async () => {
    const { db, user } = await makeHarness("early-gap-user-1")
    const pf = await seedPortfolio(db, user.id)
    // ILLIQ is bought and sold inside the window and never has a bar (PROD: the
    // four IKE Marek bonds whose upstream returns a permanent 404). It contributes
    // nothing while held, so every day of the hold is under-reported.
    await seedBuy(db, user.id, pf.id, "ILLIQ", 10, 100, "2026-07-01")
    await seedSell(db, user.id, pf.id, "ILLIQ", 10, 120, "2026-07-02")
    // AAA is still held on the last day, so the pass is valuable and must not abort.
    await seedBuy(db, user.id, pf.id, "AAA", 10, 100, "2026-07-01")

    mockPriceBars({ AAA: { dates: ["2026-07-01", "2026-07-02"], closes: [100, 110] } })

    await runBackfill(db, pf.id, "Bearer t", new Date("2026-07-03T00:00:00Z"))

    // Before this fix ILLIQ was closed by the last day, so the last-day-only scan
    // saw nothing and the backfill recorded status=complete over an under-reported
    // history — the IKE Marek 2022-06-13 +152% chart spike.
    const [meta] = await db
      .select({ gapSymbols: portfolioBackfillMetadata.gapSymbols, status: portfolioBackfillMetadata.status })
      .from(portfolioBackfillMetadata)
      .where(eq(portfolioBackfillMetadata.portfolioId, pf.id))
    expect(meta?.gapSymbols).toEqual(["ILLIQ"])
    // Still completes: a permanently unpriceable symbol must not strand the portfolio.
    expect(meta?.status).toBe("complete")
  })

  it("does not flag a symbol that was never held inside the window", async () => {
    const { db, user } = await makeHarness("early-gap-user-2")
    const pf = await seedPortfolio(db, user.id)
    await seedBuy(db, user.id, pf.id, "AAA", 10, 100, "2026-07-01")
    await seedBuy(db, user.id, pf.id, "AAA", 10, 100, "2026-07-01")
    await seedSell(db, user.id, pf.id, "CLOSED", 5, 200, "2026-07-01")
    await seedBuy(db, user.id, pf.id, "AAA", 5, 100, "2026-07-02")

    mockPriceBars({ AAA: { dates: ["2026-07-01", "2026-07-02"], closes: [100, 110] } })

    await runBackfill(db, pf.id, "Bearer t", new Date("2026-07-03T00:00:00Z"))

    const [meta] = await db
      .select({ gapSymbols: portfolioBackfillMetadata.gapSymbols })
      .from(portfolioBackfillMetadata)
      .where(eq(portfolioBackfillMetadata.portfolioId, pf.id))
    // CLOSED is net zero across the window, so it is never held and never a gap.
    expect(meta?.gapSymbols ?? null).toBeNull()
  })
})

describe("§76.4 — one writer per (portfolioId, snapshotDate)", () => {
  beforeEach(() => {
    process.env.INSTRUMENTS_URL = "http://instruments:3000"
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.INSTRUMENTS_URL
    __resetBackfillRunnerForTests()
    __resetQuoteCachesForTests()
  })

  /**
   * The invariant itself. Before §76.4 two paths wrote today's row — the live
   * `snapshotPortfolioValue` and the batch window — and whichever finished last
   * won. Now only the batch writes, so a date has exactly one row and the live
   * path's presence must not change that.
   */
  it("holds one row per date across the live path and a batch pass", async () => {
    const { db, user } = await makeHarness("one-writer-1")
    const pf = await seedPortfolio(db, user.id)
    await seedBuy(db, user.id, pf.id, "AAPL", 10, 150, "2026-07-01")
    await seedPosition(db, user.id, pf.id, "AAPL", 10, 150)

    mockPriceBars({
      AAPL: { dates: ["2026-07-01", "2026-07-02", "2026-07-03"], closes: [150, 155, 160] },
    })

    const now = new Date("2026-07-04T00:00:00Z")

    // The batch pass writes the window.
    await recalcPortfolioSeries(db, pf.id, "Bearer test", now)
    const afterBatch = await db
      .select()
      .from(valueSnapshots)
      .where(eq(valueSnapshots.portfolioId, pf.id))
      .orderBy(valueSnapshots.snapshotDate)
    expect(afterBatch.length).toBeGreaterThan(0)

    // The live path runs afterwards and must NOT add or duplicate a row.
    await snapshotPortfolioValue(
      db,
      "Bearer test",
      pf.id,
      [{ symbol: "AAPL", marketValue: "1600", averageCostBasis: "150", quantity: "10", instrumentCurrency: "USD" }],
      new Date("2026-07-04T00:00:00Z"),
    )
    const afterLive = await db
      .select()
      .from(valueSnapshots)
      .where(eq(valueSnapshots.portfolioId, pf.id))
      .orderBy(valueSnapshots.snapshotDate)

    expect(afterLive).toHaveLength(afterBatch.length)
    // No date appears twice — the ownership claim, checked as data.
    const dates = afterLive.map((r) => r.snapshotDate)
    expect(new Set(dates).size).toBe(dates.length)
  })

  /**
   * "Two concurrent writers for the same date cannot both succeed" is enforced
   * by the primary key rather than by application logic — which is the honest
   * thing to assert. A second writer cannot create a duplicate row; it can only
   * overwrite. So the property under test is that concurrent passes converge to
   * ONE coherent series rather than interleaving into a torn one.
   */
  it("concurrent passes for the same portfolio converge to one coherent series", async () => {
    const { db, user } = await makeHarness("one-writer-2")
    const pf = await seedPortfolio(db, user.id)
    await seedBuy(db, user.id, pf.id, "AAPL", 10, 150, "2026-07-01")
    await seedPosition(db, user.id, pf.id, "AAPL", 10, 150)

    mockPriceBars({
      AAPL: { dates: ["2026-07-01", "2026-07-02", "2026-07-03"], closes: [150, 155, 160] },
    })

    const now = new Date("2026-07-04T00:00:00Z")
    await Promise.all([
      recalcPortfolioSeries(db, pf.id, "Bearer test", now),
      recalcPortfolioSeries(db, pf.id, "Bearer test", now),
    ])

    const rows = await db
      .select()
      .from(valueSnapshots)
      .where(eq(valueSnapshots.portfolioId, pf.id))
      .orderBy(valueSnapshots.snapshotDate)

    const dates = rows.map((r) => r.snapshotDate)
    expect(new Set(dates).size).toBe(dates.length)

    // Every row must be a complete value for its date, not a blend: 10 × the
    // close for that date. A torn write would show a value belonging to neither
    // pass, or a missing/zero one.
    // Each row must carry 10 × the close for ITS OWN date. A torn or half-applied
    // write shows as a value belonging to a different date (or a zero), so the
    // expectation is derived per row from the mocked series rather than pinned
    // to a fixed set of dates — the window's extent is not what is under test.
    const closes: Record<string, number> = {
      "2026-07-01": 150,
      "2026-07-02": 155,
      "2026-07-03": 160,
      // `recalcPortfolioSeries` passes today as the window end, so 07-04 is in
      // the series. There is no bar for it yet, so it carries the last close —
      // which is the point of asserting per-row: a torn write would give 07-04
      // some other day's close.
      "2026-07-04": 160,
    }
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(closes[r.snapshotDate]).toBeDefined()
      expect(Number(r.value)).toBeCloseTo(10 * closes[r.snapshotDate], 0)
    }
  })
})

describe("§76.3 — recalcPortfolioSeries (additive re-value behind the mutation queue)", () => {
  beforeEach(() => {
    process.env.INSTRUMENTS_URL = "http://instruments:3000"
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.INSTRUMENTS_URL
    __resetBackfillRunnerForTests()
    // §76.3 — these two tests make a live quote SUCCEED, which populates the
    // process-wide quote cache. Without this, the later `recalcPortfolioHistory`
    // suites in this file run against a warm cache, price from it, and write a
    // today's-snapshot row that their assertions say must not exist.
    __resetQuoteCachesForTests()
  })

  /**
   * `mockPriceBars` alone is not enough to prove the pricing tail: it 404s
   * anything that is not a /price-bars request, so the QUOTE lookup the tail
   * depends on fails and the position is legitimately left unpriced. That is
   * correct behaviour, but it would make this test pass for the wrong reason —
   * so this mock answers bars, quotes and profiles.
   */
  function mockBarsAndQuotes(
    series: Record<string, { dates: string[]; closes: number[]; currency?: string; rateToBase?: number }>,
    quotePrice: number,
  ) {
    const inner = vi.mocked(globalThis.fetch).getMockImplementation()!
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init?: RequestInit) => {
        const u = String(url)
        if (u.includes("/price-bars")) return inner(u, init)
        if (u.includes("/profile")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              ticker: "AAPL",
              name: "Apple Inc.",
              country: "US",
              finnhubIndustry: "Technology",
              currency: "USD",
              currencySource: "provider",
            }),
          })
        }
        if (u.includes("/quote")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({
              symbol: "AAPL",
              currentPrice: quotePrice,
              change: 0,
              percentChange: 0,
              currency: "USD",
            }),
          })
        }
        return inner(u, init)
      }),
    )
  }

  /**
   * The contract that matters, stated once: the additive pass rewrites values in
   * place but never deletes a row, so a day outside the recomputed window (before
   * the earliest trade) SURVIVES where force would drop it. That is the one
   * behaviour the mutation queue gave up, and it is asserted rather than implied.
   */
  it("re-values the window in place and leaves an out-of-window orphan row", async () => {
    const { db, user } = await makeHarness("series-user-1")
    const pf = await seedPortfolio(db, user.id)
    await seedBuy(db, user.id, pf.id, "AAPL", 10, 150, "2026-07-01")
    await seedPosition(db, user.id, pf.id, "AAPL", 10, 150)

    await db.insert(valueSnapshots).values([
      { portfolioId: pf.id, snapshotDate: "2026-06-20", value: "555", invested: "555" },
      { portfolioId: pf.id, snapshotDate: "2026-07-01", value: "1", invested: "1" },
    ])

    mockPriceBars({
      AAPL: {
        dates: ["2026-07-01", "2026-07-02", "2026-07-03"],
        closes: [150, 155, 160],
      },
    })

    await recalcPortfolioSeries(db, pf.id, "Bearer test", new Date("2026-07-04T00:00:00Z"))

    const snaps = await db
      .select()
      .from(valueSnapshots)
      .where(eq(valueSnapshots.portfolioId, pf.id))
      .orderBy(valueSnapshots.snapshotDate)

    // The stale value ON 07-01 is corrected — upsert recomputes current data.
    const first = snaps.find((r) => r.snapshotDate === "2026-07-01")!
    expect(Number(first.value)).toBeCloseTo(1500, 0)

    // The whole window is present.
    expect(snaps.map((r) => r.snapshotDate)).toContain("2026-07-03")

    // …and the pre-window orphan is STILL THERE. force would have deleted it.
    expect(snaps.map((r) => r.snapshotDate)).toContain("2026-06-20")
    expect(Number(snaps.find((r) => r.snapshotDate === "2026-06-20")!.value)).toBe(555)
  })

  it("prices positions and syncs current_value — the §70 import requirement", async () => {
    const { db, user } = await makeHarness("series-user-2")
    const pf = await seedPortfolio(db, user.id)
    await seedBuy(db, user.id, pf.id, "AAPL", 10, 150, "2026-07-01")
    await seedPosition(db, user.id, pf.id, "AAPL", 10, 150)

    mockPriceBars({
      AAPL: {
        dates: ["2026-07-01", "2026-07-02", "2026-07-03"],
        closes: [150, 155, 160],
      },
    })
    mockBarsAndQuotes(
      {
        AAPL: {
          dates: ["2026-07-01", "2026-07-02", "2026-07-03"],
          closes: [150, 155, 160],
        },
      },
      160,
    )

    await recalcPortfolioSeries(db, pf.id, "Bearer test", new Date("2026-07-04T00:00:00Z"))

    // An import fires neither refreshQuotes nor portfolio-open, so if this pass
    // did not price, every open position would keep a NULL market_value — §70's
    // failure, where a full history sat beside 99 unpriced positions.
    const [pos] = await db
      .select({ mv: positions.marketValue, src: positions.priceSource })
      .from(positions)
      .where(eq(positions.portfolioId, pf.id))
    expect(pos.mv).not.toBeNull()
    expect(Number(pos.mv)).toBeGreaterThan(0)

    // current_value tracks the newest snapshot (§53.5).
    const [row] = await db
      .select({ cv: portfolios.currentValue })
      .from(portfolios)
      .where(eq(portfolios.id, pf.id))
    expect(Number(row.cv)).toBeGreaterThan(0)
  })
})

describe("recalcPortfolioHistory (background recalc on transaction changes)", () => {
  beforeEach(() => {
    process.env.INSTRUMENTS_URL = "http://instruments:3000"
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.INSTRUMENTS_URL
    __resetBackfillRunnerForTests()
  })

  it("replaces stale history (including superseded days) with a fresh series", async () => {
    const { db, user } = await makeHarness("recalc-user-1")
    const pf = await seedPortfolio(db, user.id)
    await seedBuy(db, user.id, pf.id, "AAPL", 10, 150, "2026-07-01")
    await seedPosition(db, user.id, pf.id, "AAPL", 10, 150)

    // Stale rows: an outdated day (before the first tx) and an outdated value on 07-01.
    await db.insert(valueSnapshots).values([
      { portfolioId: pf.id, snapshotDate: "2026-06-20", value: "555", invested: "555" },
      { portfolioId: pf.id, snapshotDate: "2026-07-01", value: "1", invested: "1" },
    ])

    mockPriceBars({
      AAPL: {
        dates: ["2026-07-01", "2026-07-02", "2026-07-03"],
        closes: [150, 155, 160],
      },
    })

    const now = new Date("2026-07-04T00:00:00Z")
    await recalcPortfolioHistory(db, pf.id, "Bearer test", now)

    const snaps = await db
      .select()
      .from(valueSnapshots)
      .where(eq(valueSnapshots.portfolioId, pf.id))
      .orderBy(valueSnapshots.snapshotDate)

    const dates = snaps.map((s) => s.snapshotDate)
    expect(dates).not.toContain("2026-06-20") // superseded day removed
    const byDate = new Map(snaps.map((s) => [s.snapshotDate, Number(s.value)]))
    expect(byDate.get("2026-07-01")).toBeCloseTo(1500) // not the stale 1
    expect(byDate.get("2026-07-03")).toBeCloseTo(1600)
    expect(await getBackfillStatus(db, pf.id)).toBe("complete")
  })

  it("syncs portfolios.current_value with the newest snapshot (§53.5)", async () => {
    const { db, user } = await makeHarness("recalc-cv-1")
    const pf = await seedPortfolio(db, user.id)
    await seedBuy(db, user.id, pf.id, "AAPL", 10, 150, "2026-07-01")
    await seedPosition(db, user.id, pf.id, "AAPL", 10, 150)

    mockPriceBars({
      AAPL: {
        dates: ["2026-07-01", "2026-07-02", "2026-07-03"],
        closes: [150, 155, 160],
      },
    })

    const now = new Date("2026-07-04T00:00:00Z")
    await recalcPortfolioHistory(db, pf.id, "Bearer test", now)

    const [row] = await db.select().from(portfolios).where(eq(portfolios.id, pf.id))
    expect(Number(row.currentValue)).toBeCloseTo(1600) // last snapshot: 10 × 160
  })

  it("clears the history entirely when all BUY/SELL transactions are deleted", async () => {
    const { db, user } = await makeHarness("recalc-user-2")
    const pf = await seedPortfolio(db, user.id)
    await seedBuy(db, user.id, pf.id, "AAPL", 10, 150, "2026-07-01")
    await seedPosition(db, user.id, pf.id, "AAPL", 10, 150)

    mockPriceBars({ AAPL: { dates: ["2026-07-01", "2026-07-02"], closes: [150, 155] } })

    const now = new Date("2026-07-03T00:00:00Z")
    await runBackfill(db, pf.id, "Bearer test", now)
    expect((await db.select().from(valueSnapshots).where(eq(valueSnapshots.portfolioId, pf.id))).length).toBeGreaterThan(0)

    // The user deleted every transaction → the old series must disappear.
    // (§62.4 — a leftover funding deposit would be real cash value, so a full
    // clear removes the cash rows too.)
    await db.delete(portfolioTransactions).where(eq(portfolioTransactions.portfolioId, pf.id))
    await db.delete(portfolioCashTransactions).where(eq(portfolioCashTransactions.portfolioId, pf.id))
    await recalcPortfolioHistory(db, pf.id, "Bearer test", now)

    const snaps = await db.select().from(valueSnapshots).where(eq(valueSnapshots.portfolioId, pf.id))
    expect(snaps.length).toBe(0)
    expect(await getBackfillStatus(db, pf.id)).toBe("complete")
    // §53.5 — a cleared history resets current_value to 0
    const [row] = await db.select().from(portfolios).where(eq(portfolios.id, pf.id))
    expect(Number(row.currentValue)).toBe(0)
  })

  it("aborted pass never writes a partial series (swap-in is all-or-nothing)", async () => {
    const { db, user } = await makeHarness("recalc-user-3")
    const pf = await seedPortfolio(db, user.id)
    await seedBuy(db, user.id, pf.id, "AAPL", 10, 150, "2026-07-01")
    await seedPosition(db, user.id, pf.id, "AAPL", 10, 150)

    mockPriceBars({ AAPL: { dates: ["2026-07-01", "2026-07-02"], closes: [150, 155] } })

    const controller = new AbortController()
    controller.abort() // killed before any work (new mutation arrived earlier)
    await expect(
      recalcPortfolioHistory(db, pf.id, "Bearer test", new Date("2026-07-03T00:00:00Z"), controller.signal),
    ).resolves.toBeUndefined() // swallowed, no error surfaced

    const snaps = await db.select().from(valueSnapshots).where(eq(valueSnapshots.portfolioId, pf.id))
    expect(snaps.length).toBe(0) // nothing written
  })
})

describe("golden value — mixed-currency portfolio (plan §48.3)", () => {
  // EUR-quoted table (D27): PLN→USD = 1.08/4.3 ≈ 0.2511627907, EUR→USD = 1.08.
  // Dev-mode correctness proof: hand-computed expected values over a seeded
  // USD portfolio holding USD/PLN/EUR instruments — no prod diff needed.
  const TABLE = { USD: 1.08, PLN: 4.3 }
  const asOf = "2026-07-02"

  beforeEach(() => {
    process.env.INSTRUMENTS_URL = "http://instruments.test"
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.INSTRUMENTS_URL
    __resetBackfillRunnerForTests()
  })

  it("converts server-side (?currency=<base>) and multiplies qty × converted close only", async () => {
    const { db, user } = await makeHarness("golden-483")
    const pf = await seedPortfolio(db, user.id, "USD")

    // Day 1 buys: 10 AAA @ 100 USD, 5 BBB @ 200 PLN, 2 CCC @ 500 EUR.
    await seedBuy(db, user.id, pf.id, "AAA", 10, 100, "2026-07-01", "USD")
    await seedBuy(db, user.id, pf.id, "BBB", 5, 200, "2026-07-01", "PLN")
    await seedBuy(db, user.id, pf.id, "CCC", 2, 500, "2026-07-01", "EUR")
    await seedPosition(db, user.id, pf.id, "AAA", 10, 100)
    await seedPosition(db, user.id, pf.id, "BBB", 5, 200, "PLN")
    await seedPosition(db, user.id, pf.id, "CCC", 2, 500, "EUR")

    // One stub stands in for the whole instruments service: price-bars honors
    // ?currency= by converting closes server-side (as the real join does), and
    // the internal fx-rates route serves the pair rate for cost-basis conversion.
    const requestedCurrency = new Map<string, string | null>()
    const series: Record<string, { dates: string[]; closes: number[]; ccy: string }> = {
      AAA: { dates: ["2026-07-01", "2026-07-02"], closes: [100, 110], ccy: "USD" },
      BBB: { dates: ["2026-07-01", "2026-07-02"], closes: [200, 205], ccy: "PLN" },
      CCC: { dates: ["2026-07-01", "2026-07-02"], closes: [500, 510], ccy: "EUR" },
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes("/api/internal/fx-rates")) {
          const q = new URL(url).searchParams
          const from = (q.get("from") ?? "").toUpperCase()
          const to = (q.get("to") ?? "EUR").toUpperCase()
          if (from === to) return new Response(JSON.stringify({ rate: 1, asOf }), { status: 200 })
          const rate = crossRate(from, to, { EUR: 1, ...TABLE })
          return rate === undefined
            ? new Response(JSON.stringify({ error: "NotFound" }), { status: 404 })
            : new Response(JSON.stringify({ rate, asOf }), { status: 200 })
        }
        const sym = decodeURIComponent(url.match(/\/instruments\/([^/]+)\/price-bars/)?.[1] ?? "")
        const data = series[sym]
        if (!data) return new Response("nope", { status: 404 })
        const target = new URL(url).searchParams.get("currency")?.toUpperCase() ?? null
        requestedCurrency.set(sym, target)
        const factor =
          target && target !== data.ccy ? crossRate(data.ccy, target, { EUR: 1, ...TABLE }) ?? 1 : 1
        return new Response(
          JSON.stringify({
            symbol: sym,
            dates: data.dates,
            closes: data.closes.map((c) => c * factor),
            currency: target ?? data.ccy,
            stale: false,
          }),
          { status: 200 },
        )
      }),
    )

    const now = new Date("2026-07-03T00:00:00Z") // yesterday = 2026-07-02
    await runBackfill(db, pf.id, "Bearer t", now)

    // Non-base symbols requested converted into the base; base symbol as-is.
    expect(requestedCurrency.get("AAA")).toBeNull()
    expect(requestedCurrency.get("BBB")).toBe("USD")
    expect(requestedCurrency.get("CCC")).toBe("USD")

    const snaps = await db
      .select()
      .from(valueSnapshots)
      .where(eq(valueSnapshots.portfolioId, pf.id))
      .orderBy(valueSnapshots.snapshotDate)

    expect(snaps).toHaveLength(2)
    const plnToUsd = 1.08 / 4.3 // 0.25116279069767...

    // Day 1 — value = 10×100 + 5×(200×p) + 2×(500×1.08) = 1000 + 251.162791 + 1080
    expect(Number(snaps[0].value)).toBeCloseTo(1000 + 1000 * plnToUsd + 1080, 6)
    // Day 1 — invested: cost basis converted at the same rates (1000 + 251.162791 + 1080)
    expect(Number(snaps[0].invested)).toBeCloseTo(1000 + 1000 * plnToUsd + 1080, 6)
    // Day 1 — netFlow: all three buys deployed, in base currency
    expect(Number(snaps[0].netFlow)).toBeCloseTo(1000 + 1000 * plnToUsd + 1080, 6)

    // Day 2 — value at day-2 closes: 10×110 + 5×(205×p) + 2×(510×1.08)
    expect(Number(snaps[1].value)).toBeCloseTo(1100 + 1025 * plnToUsd + 1101.6, 6)
    // invested is static (current position cost basis), netFlow zero
    expect(Number(snaps[1].invested)).toBeCloseTo(1000 + 1000 * plnToUsd + 1080, 6)
    expect(Number(snaps[1].netFlow)).toBeCloseTo(0, 8)
  })
})

describe("§53.6 — snapshot-on-read agrees with the backfill pipeline", () => {
  const TABLE = { USD: 1.08, PLN: 4.3 }
  const asOf = "2026-07-02"

  beforeEach(() => {
    process.env.INSTRUMENTS_URL = "http://instruments.test"
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.INSTRUMENTS_URL
  })

  it("snapshotPortfolioValue equals computeSnapshotBatch for the same day (USD lot + PLN lot, base PLN)", async () => {
    const { db, user } = await makeHarness("agree-536")
    const pf = await seedPortfolio(db, user.id, "PLN")

    // Day-1 buys: 10 AAA @ 100 USD, 5 BBB @ 200 PLN.
    await seedBuy(db, user.id, pf.id, "AAA", 10, 100, "2026-07-01", "USD")
    await seedBuy(db, user.id, pf.id, "BBB", 5, 200, "2026-07-01", "PLN")
    // AAA's STORED instrumentCurrency is a legacy "EUR" — both pipelines must
    // ignore it: backfill reads the transaction currency, snapshot-on-read
    // reads the quote currency (the regression the PROD TSM lot exposed).
    await seedPosition(db, user.id, pf.id, "AAA", 10, 100, "EUR")
    await seedPosition(db, user.id, pf.id, "BBB", 5, 200, "PLN")

    const series: Record<string, { dates: string[]; closes: number[]; ccy: string }> = {
      AAA: { dates: ["2026-07-01", "2026-07-02"], closes: [100, 110], ccy: "USD" },
      BBB: { dates: ["2026-07-01", "2026-07-02"], closes: [200, 205], ccy: "PLN" },
    }
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes("/api/internal/fx-rates")) {
          const q = new URL(url).searchParams
          const from = (q.get("from") ?? "").toUpperCase()
          const to = (q.get("to") ?? "PLN").toUpperCase()
          if (from === to) return new Response(JSON.stringify({ rate: 1, asOf }), { status: 200 })
          const rate = crossRate(from, to, { EUR: 1, ...TABLE })
          return rate === undefined
            ? new Response(JSON.stringify({ error: "NotFound" }), { status: 404 })
            : new Response(JSON.stringify({ rate, asOf }), { status: 200 })
        }
        const sym = decodeURIComponent(url.match(/\/instruments\/([^/]+)\/price-bars/)?.[1] ?? "")
        const data = series[sym]
        if (!data) return new Response("nope", { status: 404 })
        const target = new URL(url).searchParams.get("currency")?.toUpperCase() ?? null
        const factor =
          target && target !== data.ccy ? crossRate(data.ccy, target, { EUR: 1, ...TABLE }) ?? 1 : 1
        return new Response(
          JSON.stringify({
            symbol: sym,
            dates: data.dates,
            closes: data.closes.map((c) => c * factor),
            currency: target ?? data.ccy,
            stale: false,
          }),
          { status: 200 },
        )
      }),
    )

    // Backfill as of 07-03 → the series covers through 07-02 ("yesterday").
    const batch = await computeSnapshotBatch(db, pf.id, "Bearer t", new Date("2026-07-03T00:00:00Z"))
    const backfillDay2 = batch.rows.find((r) => r.snapshotDate === "2026-07-02")
    expect(backfillDay2).toBeDefined()

    // Snapshot-on-read on 07-02 from live quotes at the day-2 closes:
    // mv is denominated in the QUOTE currency (USD / PLN), not the stored one.
    //
    // §76.4 — this used to PERSIST the row and read it back; the function no
    // longer writes (computeSnapshotBatch is the single writer), so the
    // arithmetic guard is now stated on its RETURN value. The regression this
    // guards is unchanged: the two valuation paths must agree to 6dp, and the
    // legacy "EUR" instrumentCurrency must be ignored in favour of the quote's.
    const live = await snapshotPortfolioValue(
      db,
      "Bearer t",
      pf.id,
      [
        { marketValue: "1100", averageCostBasis: "100", quantity: "10", instrumentCurrency: "EUR", quoteCurrency: "USD" },
        { marketValue: "1025", averageCostBasis: "200", quantity: "5", instrumentCurrency: "PLN", quoteCurrency: "PLN" },
      ],
      new Date("2026-07-02T12:00:00Z"),
    )

    expect(Number(live.value)).toBeCloseTo(Number(backfillDay2!.value), 6)
    expect(live.snapshotDate).toBe("2026-07-02")

    // …and the invariance itself: only the batch writes rows.
    expect(
      await db
        .select()
        .from(valueSnapshots)
        .where(and(eq(valueSnapshots.portfolioId, pf.id), eq(valueSnapshots.snapshotDate, "2026-07-02"))),
    ).toHaveLength(0)
  })
})

/**
 * §72.21 — the FX coverage boundary, counted before carry-forward erases it.
 *
 * The load-bearing assertion in this block is the NEGATIVE one: a **scattered**
 * mid-window hole is invisible to `gapSymbols`, and always has been. The gap scan
 * tests `prices.has(day)`, and `buildPriceMap` has already filled every day from
 * the first surviving bar, so the day looks priced. §72.17's damage was exactly
 * that shape, and nothing ever reported it.
 */
describe("§72.21: fxCoverageHoles reports holes that gapSymbols structurally cannot", () => {
  beforeEach(() => {
    process.env.INSTRUMENTS_URL = "http://instruments:3000"
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.INSTRUMENTS_URL
    __resetBackfillRunnerForTests()
  })

  /** Serves FX at 1:1 for everything and prices `series` per symbol. */
  function stubInstruments(series: Record<string, { dates: string[]; closes: number[]; ccy: string }>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes("/api/internal/fx-rates")) {
          const q = new URL(url).searchParams
          const from = (q.get("from") ?? "").toUpperCase()
          const to = (q.get("to") ?? "PLN").toUpperCase()
          return new Response(JSON.stringify({ rate: from === to ? 1 : 1, asOf: "2026-07-02" }), { status: 200 })
        }
        const sym = decodeURIComponent(url.match(/\/instruments\/([^/]+)\/price-bars/)?.[1] ?? "")
        const data = series[sym]
        if (!data) return new Response("nope", { status: 404 })
        const target = new URL(url).searchParams.get("currency")?.toUpperCase() ?? null
        return new Response(
          JSON.stringify({ symbol: sym, dates: data.dates, closes: data.closes, currency: target ?? data.ccy, stale: false }),
          { status: 200 },
        )
      }),
    )
  }

  it("a SCATTERED mid-window hole is counted, and gapSymbols does not see it", async () => {
    const { db, user } = await makeHarness("7221-scatter")
    const pf = await seedPortfolio(db, user.id, "PLN")
    await seedBuy(db, user.id, pf.id, "AAA", 10, 100, "2026-07-01", "PLN")
    await seedPosition(db, user.id, pf.id, "AAA", 10, 100, "PLN")
    // The middle day is simply ABSENT from the response — the shape an FX hole
    // produces, and the shape that used to vanish.
    stubInstruments({ AAA: { dates: ["2026-07-01", "2026-07-03"], closes: [100, 102], ccy: "PLN" } })

    const batch = await computeSnapshotBatch(db, pf.id, "Bearer t", new Date("2026-07-04T00:00:00Z"))

    expect(batch.fxCoverageHoles.get("AAA")).toEqual(["2026-07-02"])
    // …and the value carried forward rather than being absent, which is exactly
    // why nothing downstream could have reported it.
    const mid = batch.rows.find((r) => r.snapshotDate === "2026-07-02")
    expect(mid).toBeDefined()
    expect(Number(mid!.value)).toBe(1000)
    // The point of the whole block: gapSymbols is blind to this case.
    expect(batch.gapSymbols).toEqual([])
  })

  it("a PREFIX hole is counted too, and is also a gapSymbol", async () => {
    const { db, user } = await makeHarness("7221-prefix")
    const pf = await seedPortfolio(db, user.id, "PLN")
    await seedBuy(db, user.id, pf.id, "AAA", 10, 100, "2026-07-01", "PLN")
    await seedPosition(db, user.id, pf.id, "AAA", 10, 100, "PLN")
    // Nothing before 07-03 — FX coverage that begins mid-window.
    stubInstruments({ AAA: { dates: ["2026-07-03"], closes: [102], ccy: "PLN" } })

    const batch = await computeSnapshotBatch(db, pf.id, "Bearer t", new Date("2026-07-04T00:00:00Z"))

    expect(batch.fxCoverageHoles.get("AAA")).toEqual(["2026-07-01", "2026-07-02"])
    // The prefix case was already visible — this asserts it still is, and that
    // the two reports are allowed to overlap rather than being deduped away.
    expect(batch.gapSymbols).toContain("AAA")
  })

  it("a day the symbol is NOT held on is not a hole", async () => {
    // Bought on 07-03, so 07-01/07-02 predate the position entirely. Counting
    // them would report FX coverage problems on days with no exposure.
    const { db, user } = await makeHarness("7221-notheld")
    const pf = await seedPortfolio(db, user.id, "PLN")
    await seedBuy(db, user.id, pf.id, "AAA", 10, 100, "2026-07-03", "PLN")
    await seedPosition(db, user.id, pf.id, "AAA", 10, 100, "PLN")
    stubInstruments({ AAA: { dates: ["2026-07-03"], closes: [100], ccy: "PLN" } })

    const batch = await computeSnapshotBatch(db, pf.id, "Bearer t", new Date("2026-07-04T00:00:00Z"))
    expect(batch.fxCoverageHoles.has("AAA")).toBe(false)
  })

  it("a fully-priced series reports no holes", async () => {
    const { db, user } = await makeHarness("7221-clean")
    const pf = await seedPortfolio(db, user.id, "PLN")
    await seedBuy(db, user.id, pf.id, "AAA", 10, 100, "2026-07-01", "PLN")
    await seedPosition(db, user.id, pf.id, "AAA", 10, 100, "PLN")
    stubInstruments({
      AAA: { dates: ["2026-07-01", "2026-07-02", "2026-07-03"], closes: [100, 101, 102], ccy: "PLN" },
    })

    const batch = await computeSnapshotBatch(db, pf.id, "Bearer t", new Date("2026-07-04T00:00:00Z"))
    expect(batch.fxCoverageHoles.size).toBe(0)
  })
})

describe("§62.4 — snapshots include cash; netFlow is external-only", () => {
  beforeEach(() => {
    process.env.INSTRUMENTS_URL = "http://instruments:3000"
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.INSTRUMENTS_URL
    __resetBackfillRunnerForTests()
  })

  it("a BUY/SELL day with no deposit/withdraw has netFlow 0, but the cash balance carries in value", async () => {
    const { db, user } = await makeHarness("624-a")
    const pf = await seedPortfolio(db, user.id)
    // Fund 1500, buy 10×150 same day (nets to 0), then a SELL on day 2.
    await seedBuy(db, user.id, pf.id, "AAPL", 10, 150, "2026-07-01") // +1500 dep, -1500 buy
    await seedPosition(db, user.id, pf.id, "AAPL", 10, 150)
    await db.insert(portfolioTransactions).values({
      userId: user.id,
      portfolioId: pf.id,
      type: "SELL",
      instrumentSymbol: "AAPL",
      quantity: "10",
      price: "160",
      currency: "USD",
      instrumentCurrency: "USD",
      totalAmount: "1600",
      executedAt: new Date("2026-07-02T12:00:00Z"),
    })
    mockPriceBars({ AAPL: { dates: ["2026-07-01", "2026-07-02"], closes: [150, 160] } })

    const now = new Date("2026-07-03T00:00:00Z")
    await runBackfill(db, pf.id, "Bearer test", now)

    const snaps = await db
      .select()
      .from(valueSnapshots)
      .where(eq(valueSnapshots.portfolioId, pf.id))
      .orderBy(valueSnapshots.snapshotDate)
    const byDate = new Map(snaps.map((s) => [s.snapshotDate, s]))

    // Day 1: fully funded + bought → cash 0, position 1500 → value 1500.
    // The funding deposit IS an external flow → netFlow 1500 (D50 external-only).
    expect(Number(byDate.get("2026-07-01")?.value)).toBeCloseTo(1500)
    expect(Number(byDate.get("2026-07-01")?.netFlow)).toBeCloseTo(1500)

    // Day 2: SELL (internal move) → cash +1600, position 0 → value 1600, but
    // netFlow is 0 (no deposit/withdraw that day).
    expect(Number(byDate.get("2026-07-02")?.value)).toBeCloseTo(1600)
    expect(Number(byDate.get("2026-07-02")?.netFlow)).toBe(0)
  })

  it("a portfolio that only holds cash shows the cash value (no positions)", async () => {
    const { db, user } = await makeHarness("624-b")
    const pf = await seedPortfolio(db, user.id)
    await db.insert(portfolioCashTransactions).values({
      userId: user.id,
      portfolioId: pf.id,
      type: "DEPOSIT",
      amount: "1000",
      currency: "USD",
      transactionDate: "2026-07-01",
    })
    mockPriceBars({})

    const now = new Date("2026-07-04T00:00:00Z")
    await runBackfill(db, pf.id, "Bearer test", now)

    const snaps = await db
      .select()
      .from(valueSnapshots)
      .where(eq(valueSnapshots.portfolioId, pf.id))
      .orderBy(valueSnapshots.snapshotDate)
    expect(snaps.length).toBeGreaterThanOrEqual(1)
    const last = snaps[snaps.length - 1]
    expect(Number(last.value)).toBeCloseTo(1000)
    // 2026-09-27 — invested = net external flow (the 1000 deposit), not 0.
    expect(Number(last.invested)).toBeCloseTo(1000)
  })

  it("snapshot value = positions + foreign-currency cash converted into base", async () => {
    const { mockInstrumentsFx, unmockInstrumentsFx } = await import("../test-fx-mock.js")
    mockInstrumentsFx({ table: { USD: 1.08, EUR: 1.08, PLN: 4.3 }, asOf: "2026-07-05" })
    try {
      const { db, user } = await makeHarness("624-c")
      const pf = await seedPortfolio(db, user.id, "PLN")
      // A USD deposit in a PLN-based portfolio.
      await db.insert(portfolioCashTransactions).values({
        userId: user.id,
        portfolioId: pf.id,
        type: "DEPOSIT",
        amount: "100",
        currency: "USD",
        transactionDate: "2026-07-01",
      })
      // cash-only portfolio — no symbols, so no price fetch; the FX stub above
      // (mockInstrumentsFx) must stay the active fetch stub.
      const now = new Date("2026-07-04T00:00:00Z")
      await runBackfill(db, pf.id, "Bearer test", now)

      const snaps = await db
        .select()
        .from(valueSnapshots)
        .where(eq(valueSnapshots.portfolioId, pf.id))
        .orderBy(valueSnapshots.snapshotDate)
      const last = snaps[snaps.length - 1]
      // 100 USD × (4.3 / 1.08) = 398.148... in PLN
      expect(Number(last.value)).toBeCloseTo(100 * (4.3 / 1.08), 2)
    } finally {
      unmockInstrumentsFx()
    }
  })
})

/**
 * §69.4 — a cash row dated BEFORE the window's first trade must still count
 * towards `invested` on every historical day.
 *
 * The backfill window starts at the first BUY/SELL date, and the cumulative flow
 * used to accumulate from ZERO at that edge. Anything deposited earlier was
 * therefore dropped from the whole series, while `snapshotPortfolioValue` — the
 * live path, and the LAST point of the series — kept it. PROD: IKE Marek read
 * `invested` 38,771 for every day and 54,548 on the final row, a 15,777 step from
 * a deposit dated 2021-10-18. Return derives from this pair, so it drew a
 * vertical spike on the chart's last day.
 */
describe("§69.4: invested includes capital deposited before the window", () => {
  beforeEach(() => { process.env.INSTRUMENTS_URL = "http://instruments:3000" })
  afterEach(() => { delete process.env.INSTRUMENTS_URL })

  it("a pre-window DEPOSIT is in the first historical row, not only the last", async () => {
    const { db, user } = await makeHarness("preseed-694")
    const pf = await seedPortfolio(db, user.id, "PLN")

    // 15,777 deposited long before the first trade — the PROD shape
    await db.insert(portfolioCashTransactions).values({
      userId: user.id, portfolioId: pf.id, type: "DEPOSIT",
      amount: "15777", currency: "PLN", transactionDate: "2021-10-18",
    })
    // first (and only) trade is much later; seedBuy also deposits for the buy
    await seedBuy(db, user.id, pf.id, "AAA", 10, 100, "2026-07-01", "PLN")
    await seedPosition(db, user.id, pf.id, "AAA", 10, 100, "PLN")

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/api/internal/fx-rates")) return new Response(JSON.stringify({ rate: 1, asOf: "2026-09-21" }), { status: 200 })
      if (url.includes("/price-bars")) {
        return new Response(JSON.stringify({ dates: ["2026-07-01", "2026-07-02"], closes: [100, 100], currency: "PLN" }), { status: 200 })
      }
      return new Response("not found", { status: 404 })
    }))

    const batch = await computeSnapshotBatch(db, pf.id, "Bearer t", new Date("2026-07-03T00:00:00Z"))
    expect(batch.rows.length).toBeGreaterThan(1)
    const first = batch.rows[0]
    // 15,777 pre-window + 1,000 funded by the buy — on the VERY FIRST row
    expect(Number(first.invested)).toBeCloseTo(16777, 2)
    // and it must not grow day to day (no new flows), i.e. no step at the end
    const last = batch.rows[batch.rows.length - 1]
    expect(Number(last.invested)).toBeCloseTo(Number(first.invested), 2)
  })
})


describe("§72.14 — option-premium legs do not reduce the share count", () => {
  beforeEach(() => {
    process.env.INSTRUMENTS_URL = "http://instruments:3000"
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.INSTRUMENTS_URL
    __resetBackfillRunnerForTests()
  })

  // Equate+ / SAP.DE: 481.77 shares bought against 976 sold once option legs are
  // counted — a net of -494.23, which `Math.max(0, cum)` clamps to ZERO for the
  // rest of history. Every snapshot then valued the position at nothing and the
  // whole series was cash-only.
  async function seedOptionPair(
    db: Awaited<ReturnType<typeof makeHarness>>["db"],
    userId: string,
    portfolioId: string,
    date: string,
  ) {
    const base = `opt-${date}`
    await db.insert(portfolioTransactions).values([
      {
        userId, portfolioId, type: "SELL", instrumentSymbol: "AAPL",
        quantity: "100", price: "1.25", currency: "USD", instrumentCurrency: "USD",
        totalAmount: "125", externalId: base, executedAt: new Date(`${date}T12:00:00Z`),
      },
      {
        userId, portfolioId, type: "EXPIRATION", instrumentSymbol: "AAPL",
        quantity: "100", price: "0", currency: "USD", instrumentCurrency: "USD",
        totalAmount: "0", externalId: `${base}#e`, executedAt: new Date(`${date}T12:00:00Z`),
      },
    ])
  }

  it("keeps the position valued across an option leg", async () => {
    const { db, user } = await makeHarness("opt-user-1")
    const pf = await seedPortfolio(db, user.id)
    __resetBackfillRunnerForTests()

    await seedBuy(db, user.id, pf.id, "AAPL", 100, 150, "2026-07-01")
    await seedPosition(db, user.id, pf.id, "AAPL", 100, 150)
    // 100 "shares" sold as an option premium — the lot ledger closes this
    // against a SHORT option lot, so the equity lot is untouched.
    await seedOptionPair(db, user.id, pf.id, "2026-07-02")

    mockPriceBars({ AAPL: { dates: ["2026-07-01", "2026-07-02", "2026-07-03"], closes: [150, 151, 152] } })

    await runBackfill(db, pf.id, "Bearer test", new Date("2026-07-04T00:00:00Z"))

    const rows = await db
      .select()
      .from(valueSnapshots)
      .where(eq(valueSnapshots.portfolioId, pf.id))
      .orderBy(valueSnapshots.snapshotDate)
    const v = rows.map((r) => Number(r.value))

    // 100 × 152 position + the 125 premium the option leg paid out as cash.
    // Before the fix the SELL drove the running quantity to 0 and the value
    // collapsed to that 125 of cash alone — the position vanished from history
    // on the day the option was traded.
    expect(rows).toHaveLength(3)
    expect(v[0]).toBeCloseTo(15000, 0)
    expect(v[2]).toBeCloseTo(15325, 0)
  })

  it("a SELL with no EXPIRATION sibling still closes the position", async () => {
    const { db, user } = await makeHarness("opt-user-2")
    const pf = await seedPortfolio(db, user.id)
    __resetBackfillRunnerForTests()

    await seedBuy(db, user.id, pf.id, "AAPL", 100, 150, "2026-07-01")
    await seedPosition(db, user.id, pf.id, "AAPL", 100, 150)
    await seedSell(db, user.id, pf.id, "AAPL", 100, 160, "2026-07-02")

    mockPriceBars({ AAPL: { dates: ["2026-07-01", "2026-07-02", "2026-07-03"], closes: [150, 160, 165] } })

    await runBackfill(db, pf.id, "Bearer test", new Date("2026-07-04T00:00:00Z"))

    const rows = await db
      .select()
      .from(valueSnapshots)
      .where(eq(valueSnapshots.portfolioId, pf.id))
      .orderBy(valueSnapshots.snapshotDate)
    // The lot is closed from 07-02, so those days carry only the 16,000 of sale
    // proceeds and no position value. Had §72.14 wrongly exempted this SELL the
    // day would read 16,000 + 100×160 = 32,000.
    const byDate = new Map(rows.map((r) => [r.snapshotDate, Number(r.value)]))
    expect(byDate.get("2026-07-01")).toBeCloseTo(15000, 0)
    expect(byDate.get("2026-07-02")).toBeCloseTo(16000, 0)
    expect(byDate.get("2026-07-03")).toBeCloseTo(16000, 0)
  })
})

describe("§72.15 — a bar's own currency beats the stored instrument_currency", () => {
  beforeEach(() => {
    process.env.INSTRUMENTS_URL = "http://instruments:3000"
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.INSTRUMENTS_URL
    __resetBackfillRunnerForTests()
  })

  it("re-asks with a conversion when the closes come back in a foreign currency", async () => {
    // The Crypto portfolio: 0.004 BTC-USD bought for 690.64 PLN, so the import
    // stored instrument_currency=PLN — the PAYMENT currency, not the listing one.
    // The grid asked for no conversion, got a USD close, and multiplied it as if
    // it were PLN: ~172 instead of ~688.
    const { db, user } = await makeHarness("ccy-user-1")
    const pf = await seedPortfolio(db, user.id, "PLN")
    __resetBackfillRunnerForTests()

    await db.insert(portfolioTransactions).values({
      userId: user.id, portfolioId: pf.id, type: "BUY", instrumentSymbol: "BTC-USD",
      quantity: "0.004", price: "172660", currency: "PLN", instrumentCurrency: "PLN",
      totalAmount: "690.64", executedAt: new Date("2022-02-13T12:00:00Z"),
    })
    await db.insert(portfolioCashTransactions).values({
      userId: user.id, portfolioId: pf.id, type: "DEPOSIT",
      amount: "690.64", currency: "PLN", transactionDate: "2022-02-13",
    })
    await seedPosition(db, user.id, pf.id, "BTC-USD", 0.004, 172660)

    mockPriceBars({
      "BTC-USD": { dates: ["2022-02-13", "2022-02-14"], closes: [42197.5156, 42586.918], currency: "USD", rateToBase: 4 },
    })

    await runBackfill(db, pf.id, "Bearer test", new Date("2022-02-15T00:00:00Z"))

    const rows = await db
      .select()
      .from(valueSnapshots)
      .where(eq(valueSnapshots.portfolioId, pf.id))
      .orderBy(valueSnapshots.snapshotDate)
    // 0.004 × 42,197.5156 × 4 = 675.16 PLN. Unconverted it would be 168.79 —
    // the USD close multiplied straight into a PLN total.
    expect(Number(rows[0].value)).toBeCloseTo(675.16, 1)
  })

  it("leaves a series that already arrives in the portfolio base alone", async () => {
    const { db, user } = await makeHarness("ccy-user-2")
    const pf = await seedPortfolio(db, user.id, "PLN")
    __resetBackfillRunnerForTests()

    await seedBuy(db, user.id, pf.id, "AAPL", 10, 150, "2026-07-01")
    await seedPosition(db, user.id, pf.id, "AAPL", 10, 150)
    mockPriceBars({ AAPL: { dates: ["2026-07-01", "2026-07-02"], closes: [150, 155], currency: "PLN" } })

    const fetchMock = vi.mocked(globalThis.fetch)
    await runBackfill(db, pf.id, "Bearer test", new Date("2026-07-03T00:00:00Z"))
    // one fetch per symbol, no corrective re-ask
    const bars = fetchMock.mock.calls.filter((c) => String(c[0]).includes("/price-bars"))
    expect(bars).toHaveLength(1)
  })
})

describe("§72.16 — bars instruments could not convert are not valued", () => {
  beforeEach(() => {
    process.env.INSTRUMENTS_URL = "http://instruments:3000"
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.INSTRUMENTS_URL
    __resetBackfillRunnerForTests()
  })

  it("drops the unconverted prefix instead of adding a USD close to a PLN total", async () => {
    // The real BTC-USD response, verbatim shape: fxFrom 02-14, and 02-13 left at
    // the raw USD close while every later day is converted.
    const { db, user } = await makeHarness("fx-user-1")
    const pf = await seedPortfolio(db, user.id, "PLN")
    __resetBackfillRunnerForTests()

    await db.insert(portfolioTransactions).values({
      userId: user.id, portfolioId: pf.id, type: "BUY", instrumentSymbol: "BTC-USD",
      quantity: "0.004", price: "172660", currency: "PLN", instrumentCurrency: "PLN",
      totalAmount: "690.64", executedAt: new Date("2022-02-13T12:00:00Z"),
    })
    await db.insert(portfolioCashTransactions).values({
      userId: user.id, portfolioId: pf.id, type: "DEPOSIT",
      amount: "690.64", currency: "PLN", transactionDate: "2022-02-13",
    })
    await seedPosition(db, user.id, pf.id, "BTC-USD", 0.004, 172660)

    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const u = String(url)
        const wants = new URL(u, "http://x").searchParams.get("currency")
        const json = wants
          ? {
              symbol: "BTC-USD", stale: false, currency: "PLN", fxFrom: "2022-02-14",
              dates: ["2022-02-13", "2022-02-14", "2022-02-15"],
              // 02-13 left raw by convertSeries; the rest converted at ~4.01
              closes: [42197.5156, 170859.4978, 176949.2152],
            }
          : {
              symbol: "BTC-USD", stale: false, currency: "USD", fxFrom: null,
              dates: ["2022-02-13", "2022-02-14", "2022-02-15"],
              closes: [42197.5156, 42586.918, 44575.2031],
            }
        return Promise.resolve({ ok: true, status: 200, json: async () => json })
      }),
    )

    await runBackfill(db, pf.id, "Bearer test", new Date("2022-02-16T00:00:00Z"))

    const rows = await db
      .select()
      .from(valueSnapshots)
      .where(eq(valueSnapshots.portfolioId, pf.id))
      .orderBy(valueSnapshots.snapshotDate)
    // 02-13 carries forward the first CONVERTED close: 0.004 × 170,859.50 = 683.44.
    // The raw USD close would have read 168.79 and the day would have looked
    // like a -75% crash.
    expect(Number(rows[0].value)).toBeCloseTo(683.44, 1)
  })
})
