/** analytics.test.ts (D48/D50) — benchmark overlay on GET /:id/analytics */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Hono } from "hono"
import { createPortfolioRoutes, timeframeCutoff } from "./portfolios.js"
import { makeHarness } from "./test-utils.js"
import { portfolios, portfolioTransactions, valueSnapshots, portfolioCashTransactions, portfolioBackfillMetadata } from "../db/schema.js"
import { calendarDays } from "../services/backfill.js"

function app(db: Parameters<typeof createPortfolioRoutes>[0]) {
  const a = new Hono()
  a.route("/api/portfolios", createPortfolioRoutes(db))
  return a
}

async function seedPortfolio(db: Awaited<ReturnType<typeof makeHarness>>["db"], userId: string) {
  const [pf] = await db
    .insert(portfolios)
    .values({ userId, name: "Analytics PF", baseCurrency: "USD" })
    .returning()
  return pf
}

async function seedSnapshots(
  db: Awaited<ReturnType<typeof makeHarness>>["db"],
  portfolioId: string,
  dates: string[],
) {
  for (const d of dates) {
    await db.insert(valueSnapshots).values({
      portfolioId,
      snapshotDate: d,
      value: "1000",
      invested: "900",
      netFlow: "0",
    })
  }
}

async function seedBuy(
  db: Awaited<ReturnType<typeof makeHarness>>["db"],
  userId: string,
  portfolioId: string,
  qty: number,
  price: number,
  date: string,
  totalAmount?: number,
) {
  await db.insert(portfolioTransactions).values({
    userId,
    portfolioId,
    type: "BUY",
    instrumentSymbol: "SPY",
    quantity: String(qty),
    price: String(price),
    currency: "USD",
    instrumentCurrency: "USD",
    totalAmount: String(totalAmount ?? qty * price),
    executedAt: new Date(`${date}T12:00:00Z`),
  })
  // §62.4 — pair a funding DEPOSIT (same magnitude/date) so the position's
  // cash nets to 0 and the benchmark overlay mirrors the capital deployment
  // as an external flow (D50 now mirrors dailyExternalFlows, not trades).
  await db.insert(portfolioCashTransactions).values({
    userId,
    portfolioId,
    type: "DEPOSIT",
    amount: String(totalAmount ?? qty * price),
    currency: "USD",
    transactionDate: date,
  })
}

function mockPriceBars(series: Record<string, { dates: string[]; closes: number[] }>) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string, init?: { headers?: Record<string, string> }) => {
      const sym = decodeURIComponent(String(url).match(/\/instruments\/([^/]+)\/price-bars/)?.[1] ?? "")
      void init
      const data = series[sym]
      // §63.10 — 404 is the documented "no data for this key" answer, so an
      // unresolvable benchmark ticker is dropped rather than aborting the request.
      if (!data) return Promise.resolve({ ok: false, status: 404, json: async () => ({}) })
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ symbol: sym, dates: data.dates, closes: data.closes, stale: false }),
      })
    }),
  )
}

describe("GET /:id/analytics — benchmarks (D46/D48)", () => {
  beforeEach(() => { process.env.INSTRUMENTS_URL = "http://instruments:3000" })
  afterEach(() => { vi.unstubAllGlobals(); delete process.env.INSTRUMENTS_URL })

  it("returns benchmarks: [] when no benchmarks param", async () => {
    const { db, user, headers } = await makeHarness("abe-no-param")
    const a = app(db)
    const pf = await seedPortfolio(db, user.id)
    await seedSnapshots(db, pf.id, calendarDays("2026-07-01", "2026-07-03"))

    const res = await a.request(`/api/portfolios/${pf.id}/analytics?timeframe=1Y`, { headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.benchmarks).toEqual([])
  })

  it("normalizes a requested benchmark to an indexed line starting at 100", async () => {
    const { db, user, headers } = await makeHarness("abe-spy")
    const a = app(db)
    const pf = await seedPortfolio(db, user.id)
    const days = calendarDays("2026-07-01", "2026-07-05")
    await seedSnapshots(db, pf.id, days)
    mockPriceBars({ SPY: { dates: days, closes: days.map((_, i) => 100 + i * 10) } }) // 100..140

    const res = await a.request(`/api/portfolios/${pf.id}/analytics?timeframe=1Y&benchmarks=SPY`, { headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.benchmarks).toHaveLength(1)
    const b = body.benchmarks[0]
    expect(b.symbol).toBe("SPY")
    expect(b.timeSeries[0].value).toBe(100)               // normalized start
    expect(b.timeSeries[b.timeSeries.length - 1].value).toBe(140) // 140/100×100
    expect(b.returnPercent).toBe(40)                       // (140/100−1)×100
    expect(b.timeSeries).toHaveLength(5)
  })

  it("drops unknown tickers and still returns portfolio series", async () => {
    const { db, user, headers } = await makeHarness("abe-unknown")
    const a = app(db)
    const pf = await seedPortfolio(db, user.id)
    const days = calendarDays("2026-07-01", "2026-07-02")
    await seedSnapshots(db, pf.id, days)
    mockPriceBars({}) // no ticker resolvable

    const res = await a.request(`/api/portfolios/${pf.id}/analytics?benchmarks=NOPE`, { headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.benchmarks).toEqual([])
    expect(body.performance.timeSeries.length).toBe(2)
    // the "invested" line (cumulative net money-in) rides along per point
    expect(body.performance.timeSeries[0].invested).toBe(900)
  })

  it("surfaces gapSymbols when a held symbol had no price bar (§63.8)", async () => {
    const { db, user, headers } = await makeHarness("gap-api")
    const a = app(db)
    const pf = await seedPortfolio(db, user.id)
    const days = calendarDays("2026-07-01", "2026-07-03")
    await seedSnapshots(db, pf.id, days)
    // a held symbol the last backfill pass couldn't price → the value is partial
    await db.insert(portfolioBackfillMetadata).values({
      portfolioId: pf.id,
      status: "complete",
      gapSymbols: ["BBB"],
    })

    const res = await a.request(`/api/portfolios/${pf.id}/analytics?timeframe=1Y`, { headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.gapSymbols).toEqual(["BBB"])
  })

  it("omits gapSymbols (null) when every held symbol is priced", async () => {
    const { db, user, headers } = await makeHarness("gap-api-clean")
    const a = app(db)
    const pf = await seedPortfolio(db, user.id)
    const days = calendarDays("2026-07-01", "2026-07-03")
    await seedSnapshots(db, pf.id, days)
    await db.insert(portfolioBackfillMetadata).values({ portfolioId: pf.id, status: "complete", gapSymbols: null })

    const res = await a.request(`/api/portfolios/${pf.id}/analytics?timeframe=1Y`, { headers })
    const body = await res.json()
    expect(body.gapSymbols).toBeNull()
    expect(body.heldGapSymbols).toBeNull()
  })

  /**
   * §72.30 — the API must return BOTH claims, because they are different. This is
   * the shape PROD was in on 2026-10-01 and the reason a UI built on
   * `gapSymbols` alone told the user their value was short when it was complete:
   * a window-wide list of symbols that had all been sold by the last day.
   */
  it("separates the window-wide history gap from the still-held current gap (§72.30)", async () => {
    const { db, user, headers } = await makeHarness("gap-api-split")
    const a = app(db)
    const pf = await seedPortfolio(db, user.id)
    const days = calendarDays("2026-07-01", "2026-07-03")
    await seedSnapshots(db, pf.id, days)
    await db.insert(portfolioBackfillMetadata).values({
      portfolioId: pf.id,
      status: "complete",
      // SOLD was held earlier and closed; HELD is still held. Only HELD makes
      // the CURRENT value a partial sum.
      gapSymbols: ["SOLD", "HELD"],
      heldGapSymbols: ["HELD"],
    })

    const res = await a.request(`/api/portfolios/${pf.id}/analytics?timeframe=1Y`, { headers })
    const body = await res.json()
    expect(body.gapSymbols).toEqual(["SOLD", "HELD"])
    expect(body.heldGapSymbols).toEqual(["HELD"])
  })

  it("does not report a current gap for a row written before the split existed", async () => {
    // A pre-migration row has gapSymbols and no heldGapSymbols. Falling back to
    // the full list would re-introduce exactly the false warning the split
    // removed, so an unknown subset must read as "no confirmed current gap".
    const { db, user, headers } = await makeHarness("gap-api-legacy")
    const a = app(db)
    const pf = await seedPortfolio(db, user.id)
    const days = calendarDays("2026-07-01", "2026-07-03")
    await seedSnapshots(db, pf.id, days)
    await db
      .insert(portfolioBackfillMetadata)
      .values({ portfolioId: pf.id, status: "complete", gapSymbols: ["OLD"], heldGapSymbols: null })

    const res = await a.request(`/api/portfolios/${pf.id}/analytics?timeframe=1Y`, { headers })
    const body = await res.json()
    expect(body.gapSymbols).toEqual(["OLD"])
    expect(body.heldGapSymbols).toBeNull()
  })

  /**
   * §72.21 — the THIRD coverage claim, and the only one about steps in the middle
   * of a series. `gapSymbols` catches a prefix hole and reads as "no history";
   * `heldGapSymbols` catches "today is short". A symbol priced every day but a
   * few is neither, is not flagged by either, and renders as a fake return —
   * which is the shape §72.17's damage took.
   */
  it("surfaces fxCoverageHoles alongside the other two, as counts (§72.21)", async () => {
    const { db, user, headers } = await makeHarness("fxholes-api")
    const a = app(db)
    const pf = await seedPortfolio(db, user.id)
    const days = calendarDays("2026-07-01", "2026-07-03")
    await seedSnapshots(db, pf.id, days)
    // AAA: a prefix hole, so it is BOTH a gapSymbol and an FX hole — the overlap
    // is allowed and the two mean different things by each. BBB: scattered only.
    await db.insert(portfolioBackfillMetadata).values({
      portfolioId: pf.id,
      status: "complete",
      gapSymbols: ["AAA"],
      heldGapSymbols: ["AAA"],
      fxCoverageHoles: { AAA: 12, BBB: 2 },
    })

    const res = await a.request(`/api/portfolios/${pf.id}/analytics?timeframe=1Y`, { headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.fxCoverageHoles).toEqual({ AAA: 12, BBB: 2 })
    expect(body.gapSymbols).toEqual(["AAA"])
    expect(body.heldGapSymbols).toEqual(["AAA"])
  })

  it("reports fxCoverageHoles null for a portfolio with no holes, and for a legacy row", async () => {
    // Two different absences that must not look alike to a consumer: "measured,
    // clean" and "not measured". Both null here, which is why the contract says
    // absent rather than {} — a UI cannot claim clean history on an unmeasured row.
    const { db, user, headers } = await makeHarness("fxholes-api-null")
    const a = app(db)
    const pf = await seedPortfolio(db, user.id)
    const days = calendarDays("2026-07-01", "2026-07-03")
    await seedSnapshots(db, pf.id, days)
    await db
      .insert(portfolioBackfillMetadata)
      .values({ portfolioId: pf.id, status: "complete", gapSymbols: null, fxCoverageHoles: null })

    const res = await a.request(`/api/portfolios/${pf.id}/analytics?timeframe=1Y`, { headers })
    const body = await res.json()
    expect(body.fxCoverageHoles).toBeNull()
  })

  it("accepts benchmarkCalcType param without error", async () => {
    const { db, user, headers } = await makeHarness("abe-calc")
    const a = app(db)
    const pf = await seedPortfolio(db, user.id)
    const days = calendarDays("2026-07-01", "2026-07-03")
    await seedSnapshots(db, pf.id, days)
    mockPriceBars({ QQQ: { dates: days, closes: days.map((_, i) => 200 - i * 10) } })

    const res = await a.request(
      `/api/portfolios/${pf.id}/analytics?benchmarks=QQQ&benchmarkCalcType=moneyWeighted`,
      { headers },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.benchmarks).toHaveLength(1)
    expect(body.benchmarks[0].symbol).toBe("QQQ")
  })

  it("mirrors a mid-window BUY into the benchmark (D50)", async () => {
    const { db, user, headers } = await makeHarness("abe-mirror")
    const a = app(db)
    const pf = await seedPortfolio(db, user.id)
    const days = calendarDays("2026-07-01", "2026-07-05")
    await seedSnapshots(db, pf.id, days)
    // A $1500 BUY on 2026-07-04 (SPY close 130) — seeded with invested=900.
    await seedBuy(db, user.id, pf.id, 10, 150, "2026-07-04", 1500)
    mockPriceBars({ SPY: { dates: days, closes: days.map((_, i) => 100 + i * 10) } }) // 100..140

    const res = await a.request(`/api/portfolios/${pf.id}/analytics?timeframe=1Y&benchmarks=SPY`, { headers })
    expect(res.status).toBe(200)
    const body = await res.json()

    // Pure price index would be 140; mirroring the $1500 BUY dilutes the
    // indexed TWR line because capital was deployed at 130, not at 100.
    const b = body.benchmarks[0]
    expect(b.timeSeries[0].value).toBe(100)
    expect(b.timeSeries[b.timeSeries.length - 1].value).toBeCloseTo(133.74, 1)
    expect(b.returnPercent).toBeCloseTo(33.74, 1)
  })

  it("returns portfolio series unaffected by benchmark mirroring", async () => {
    const { db, user, headers } = await makeHarness("abe-mirror2")
    const a = app(db)
    const pf = await seedPortfolio(db, user.id)
    const days = calendarDays("2026-07-01", "2026-07-04")
    await seedSnapshots(db, pf.id, days)
    await seedBuy(db, user.id, pf.id, 5, 100, "2026-07-02", 500)
    mockPriceBars({ GOOGL: { dates: days, closes: days.map((_, i) => 100 + i * 5) } })

    const res = await a.request(`/api/portfolios/${pf.id}/analytics?timeframe=1Y&benchmarks=GOOGL&benchmarkCalcType=simple`, { headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.performance.timeSeries).toHaveLength(4)
    expect(body.benchmarks).toHaveLength(1)
  })

  it("computes monthly returns as flow-adjusted TWR month-over-month (D50)", async () => {
    const { db, user, headers } = await makeHarness("abe-monthly-twrs")
    const a = app(db)
    const pf = await seedPortfolio(db, user.id)
    // July: 100 -> 102 (+2%). August starts flat (twr 102) while a $50k
    // deposit balloons the raw value to 52000; the twr stays flat (102) and
    // only the final move (+2%) shows in August.
    const rows = [
      { d: "2026-07-01", value: "1000", twr: "100" },
      { d: "2026-07-31", value: "1020", twr: "102" },
      { d: "2026-08-15", value: "52000", twr: "102" },
      { d: "2026-08-31", value: "53040", twr: "104.04" },
    ]
    for (const r of rows) {
      await db.insert(valueSnapshots).values({
        portfolioId: pf.id,
        snapshotDate: r.d,
        value: r.value,
        invested: "1000",
        netFlow: "0",
        cumulativeTwr: r.twr,
      })
    }
    await seedBuy(db, user.id, pf.id, 1, 50000, "2026-08-02", 50000)

    const res = await a.request(`/api/portfolios/${pf.id}/analytics?timeframe=1Y`, { headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.performance.monthlyReturns).toEqual([
      { month: "2026-07", returnPercent: 2 },
      { month: "2026-08", returnPercent: 2 },
    ])
  })
})

/**
 * §82.1 — the flow-neutral TWR p.a. on `performance.annualizedReturn`, the
 * number the Performance tab's "TWR p.a." tile reads. Declared in the contract
 * since D86 and computed by `/risk-metrics`, but never returned here.
 */
describe("GET /:id/analytics — performance.annualizedReturn (§82.1)", () => {
  /** n consecutive calendar days from `from`, so elapsed days = n − 1. */
  function daysFrom(from: string, n: number): string[] {
    return calendarDays(from, new Date(Date.parse(`${from}T00:00:00Z`) + (n - 1) * 86400000).toISOString().slice(0, 10))
  }

  /** A TWR index rising linearly from `from` to `to`, one point per day. */
  async function seedTwr(
    db: Awaited<ReturnType<typeof makeHarness>>["db"],
    portfolioId: string,
    dates: string[],
    from: number,
    to: number,
  ) {
    for (let i = 0; i < dates.length; i++) {
      await db.insert(valueSnapshots).values({
        portfolioId,
        snapshotDate: dates[i],
        value: "1000",
        invested: "900",
        netFlow: "0",
        cumulativeTwr: String(from + ((to - from) * i) / (dates.length - 1)),
      })
    }
  }

  async function annualizedFor(dates: string[], from: number, to: number) {
    const { db, user, headers } = await makeHarness(`ann-${dates.length}-${from}-${to}`)
    const pf = await seedPortfolio(db, user.id)
    await seedTwr(db, pf.id, dates, from, to)
    const res = await app(db).request(`/api/portfolios/${pf.id}/analytics?timeframe=ALL`, { headers })
    expect(res.status).toBe(200)
    const body = await res.json()
    return body.performance as {
      annualizedReturn: number | null
      annualizedReturnWithheldReason: string | null
    }
  }

  it("annualises the flow-neutral index over ELAPSED CALENDAR DAYS", async () => {
    // 366 points = 365 elapsed days, index 100 → 110. Exponent 365/365 = 1, so
    // the answer is the period return itself: exactly 10%. This is the §81.2
    // exponent pinned through the route rather than through riskMetrics.test.ts.
    const p = await annualizedFor(daysFrom("2025-01-01", 366), 100, 110)
    expect(p.annualizedReturn).toBe(10)
    expect(p.annualizedReturnWithheldReason).toBeNull()
  })

  it("reports a percent, not a fraction (unit split with /risk-metrics is deliberate)", async () => {
    const p = await annualizedFor(daysFrom("2025-01-01", 366), 100, 110)
    // A fraction would read 0.1 here; the siblings in `performance.*` are percents.
    expect(p.annualizedReturn).not.toBeCloseTo(0.1, 3)
    expect(p.annualizedReturn).toBe(10)
  })

  it("compounds the 365/364 exponent for a 365-POINT (364-day) span", async () => {
    // The plan's original fixture said "365 points → 10". A point count is not a
    // day count: 365 daily points span 364 days, so the exponent is 365/364 and
    // the answer is slightly ABOVE the period return. Pinning it stops anyone
    // "simplifying" the exponent back to 1.
    const p = await annualizedFor(daysFrom("2025-01-01", 365), 100, 110)
    expect(p.annualizedReturn).toBeCloseTo((1.1 ** (365 / 364) - 1) * 100, 2)
    expect(p.annualizedReturn).toBe(10.03)
  })

  it("withholds below 60 points, returning null and the reason rather than a bigger number", async () => {
    const p = await annualizedFor(daysFrom("2025-01-01", 59), 100, 110)
    expect(p.annualizedReturn).toBeNull()
    expect(p.annualizedReturnWithheldReason).toBe("insufficient_history")
  })

  it("withholds a ≥60-point series that spans under 90 calendar days", async () => {
    const p = await annualizedFor(daysFrom("2025-01-01", 80), 100, 110) // 79 days
    expect(p.annualizedReturn).toBeNull()
    expect(p.annualizedReturnWithheldReason).toBe("insufficient_history")
  })

  /**
   * A deliberate deviation from the plan's original wording, which wanted a
   * 91-point (one quarter) series withheld as "under a full year". §82.1 also
   * required reusing `annualizedReturnWithheldReason` verbatim so this tile and
   * the Risk tab can never disagree about the same window — and that predicate's
   * floor is 60 points AND 90 days, which a quarter clears. One source of truth
   * won: the tile annualises a quarter exactly as the Risk tab already does.
   */
  it("annualises a quarter (91 points, 90 days) — the shared predicate, not a full-year gate", async () => {
    const p = await annualizedFor(daysFrom("2025-01-01", 91), 100, 110)
    expect(p.annualizedReturnWithheldReason).toBeNull()
    expect(p.annualizedReturn).toBeCloseTo((1.1 ** (365 / 90) - 1) * 100, 2)
    expect(p.annualizedReturn).toBeGreaterThan(10) // annualising a quarter exceeds it
  })

  it("withholds a series whose cumulative_twr is absent (a null is a gap, not a −100% day)", async () => {
    const { db, user, headers } = await makeHarness("ann-null-twr")
    const pf = await seedPortfolio(db, user.id)
    await seedSnapshots(db, pf.id, daysFrom("2025-01-01", 200)) // no cumulative_twr at all
    const res = await app(db).request(`/api/portfolios/${pf.id}/analytics?timeframe=ALL`, { headers })
    const body = await res.json()
    expect(body.performance.annualizedReturn).toBeNull()
    expect(body.performance.annualizedReturnWithheldReason).toBe("insufficient_history")
  })

  it("leaves timeWeightedReturn untouched — the two read different columns", async () => {
    // `timeWeightedReturn` is the WHOLE window's period return (index − 100);
    // `annualizedReturn` rescales that same window to a year. They are equal
    // only when the window is exactly a year, so collapsing them would be a
    // silent 4x error on a 3M view.
    const p = await (async () => {
      const { db, user, headers } = await makeHarness("ann-vs-twr")
      const pf = await seedPortfolio(db, user.id)
      await seedTwr(db, pf.id, daysFrom("2025-01-01", 366), 100, 110)
      const res = await app(db).request(`/api/portfolios/${pf.id}/analytics?timeframe=ALL`, { headers })
      return (await res.json()).performance as { timeWeightedReturn: number; annualizedReturn: number }
    })()
    expect(p.timeWeightedReturn).toBe(10)
    expect(p.annualizedReturn).toBe(10) // equal only because the span IS a year
  })
})

describe("timeframeCutoff (1W/1M/3M windowing)", () => {
  const now = new Date("2026-09-05T12:00:00Z")

  it("maps 1W to 7 calendar days back", () => {
    expect(timeframeCutoff("1W", now)).toBe("2026-08-29")
  })

  it("maps 1M/3M/6M/1Y/2Y by calendar month", () => {
    expect(timeframeCutoff("1M", now)).toBe("2026-08-05")
    expect(timeframeCutoff("3M", now)).toBe("2026-06-05")
    expect(timeframeCutoff("6M", now)).toBe("2026-03-05")
    expect(timeframeCutoff("1Y", now)).toBe("2025-09-05")
    expect(timeframeCutoff("2Y", now)).toBe("2024-09-05")
  })

  it("accepts lower-case and falls back to ALL for unknown/ALL", () => {
    expect(timeframeCutoff("1w", now)).toBe("2026-08-29")
    expect(timeframeCutoff("ALL", now)).toBeNull()
    expect(timeframeCutoff("YTD", now)).toBeNull()
    expect(timeframeCutoff("", now)).toBeNull()
  })
})
