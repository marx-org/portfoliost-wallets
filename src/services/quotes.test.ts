import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeHarness } from "../routes/test-utils.js"
import { portfolios, positions, valueSnapshots } from "../db/schema.js"
import { eq } from "drizzle-orm"
import { refreshQuotes, snapshotPortfolioValue, _clearQuoteCache } from "./quotes.js"

// ── helpers ──────────────────────────────────────────────────────────────

/** Mock fetch: returns appropriate shape based on the URL path. */
function mockFetch(price: number, change = 2, percentChange = 1.5) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      const u = String(url)
      if (u.includes("/profile")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            ticker: "AAPL",
            name: "Apple Inc.",
            country: "US",
            finnhubIndustry: "Technology",
            currency: "USD",
          }),
        })
      }
      // quote endpoint
      return Promise.resolve({
        ok: true,
        json: async () => ({
          symbol: "AAPL",
          currentPrice: price,
          change,
          percentChange,
          currency: "USD",
        }),
      })
    }),
  )
}

function mockFetchFail() {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }),
  )
}

async function seedPortfolioAndPosition(
  db: Awaited<ReturnType<typeof makeHarness>>["db"],
  userId: string,
  opts: { qty?: number; avg?: number; currentPrice?: string | null } = {},
) {
  const [pf] = await db
    .insert(portfolios)
    .values({
      userId,
      name: "Test Portfolio",
      currency: "USD",
      baseCurrency: "USD",
    })
    .returning()

  const [pos] = await db
    .insert(positions)
    .values({
      userId,
      portfolioId: pf.id,
      symbol: "AAPL",
      quantity: String(opts.qty ?? 10),
      averageCostBasis: String(opts.avg ?? 150),
      instrumentCurrency: "USD",
      isOpen: true,
      currentPrice: opts.currentPrice !== undefined ? opts.currentPrice : null,
      priceSource: "manual",
    })
    .returning()

  return { pf, pos }
}

// ── tests ─────────────────────────────────────────────────────────────────

describe("refreshQuotes (D58)", () => {
  beforeEach(() => {
    process.env.INSTRUMENTS_URL = "http://instruments:3000"
    _clearQuoteCache()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.INSTRUMENTS_URL
    delete process.env.QUOTE_CACHE_TTL_MS
    delete process.env.QUOTE_STALE_MS
  })

  it("populates currentPrice, marketValue, unrealizedGainLoss from live quote", async () => {
    const { db, user } = await makeHarness("q-user-1")
    const { pf, pos } = await seedPortfolioAndPosition(db, user.id, { qty: 10, avg: 150 })
    mockFetch(180, 3, 1.7)

    await refreshQuotes(db, user.id, pf.id, "Bearer test-token")

    const [updated] = await db.select().from(positions).where(eq(positions.id, pos.id))
    expect(Number(updated.currentPrice)).toBeCloseTo(180)
    expect(Number(updated.marketValue)).toBeCloseTo(1800) // 10 × 180
    expect(Number(updated.unrealizedGainLoss)).toBeCloseTo(300) // 10 × (180 - 150)
    expect(Number(updated.dayChange)).toBeCloseTo(30) // 3 × 10
    expect(Number(updated.dayChangePercent)).toBeCloseTo(1.7)
    expect(updated.priceSource).toBe("quote")
    expect(updated.priceAsOf).toBeTruthy()
  })

  it("populates companyName, sector, country from instrument profile", async () => {
    const { db, user } = await makeHarness("q-user-5")
    const { pf, pos } = await seedPortfolioAndPosition(db, user.id, { qty: 5, avg: 200 })
    mockFetch(210)

    await refreshQuotes(db, user.id, pf.id, "Bearer test-token")

    const [updated] = await db.select().from(positions).where(eq(positions.id, pos.id))
    expect(updated.companyName).toBe("Apple Inc.")
    expect(updated.sector).toBe("Technology")
    expect(updated.country).toBe("US")
  })

  it("keeps the canonical buy-time country instead of overwriting it with the profile country", async () => {
    const { db, user } = await makeHarness("q-user-6")
    const { pf, pos } = await seedPortfolioAndPosition(db, user.id, { qty: 5, avg: 200 })
    await db.update(positions).set({ country: "US" }).where(eq(positions.id, pos.id))
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const u = String(url)
        if (u.includes("/profile")) {
          // the live instruments module resolves META to the provider display
          // name + a colliding listing's countryCode — neither may clobber the
          // 2-letter code the position was recorded with at buy time
          return Promise.resolve({
            ok: true,
            json: async () => ({
              ticker: "META",
              name: "Meta Platforms, Inc.",
              country: "United States",
              countryCode: "IE",
              finnhubIndustry: "Internet Content & Information",
              currency: "USD",
            }),
          })
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ symbol: "AAPL", currentPrice: 211, change: 1, percentChange: 0.5, currency: "USD" }),
        })
      }),
    )

    await refreshQuotes(db, user.id, pf.id, "Bearer test-token")

    const [updated] = await db.select().from(positions).where(eq(positions.id, pos.id))
    expect(updated.country).toBe("US")
    expect(updated.companyName).toBe("Meta Platforms, Inc.")
  })

  it("marks priceSource fallback when instruments is unreachable", async () => {
    const { db, user } = await makeHarness("q-user-2")
    const { pf, pos } = await seedPortfolioAndPosition(db, user.id, {
      qty: 5,
      avg: 100,
      currentPrice: "95",
    })
    mockFetchFail()

    await refreshQuotes(db, user.id, pf.id, "Bearer test-token")

    const [updated] = await db.select().from(positions).where(eq(positions.id, pos.id))
    expect(updated.priceSource).toBe("fallback")
    // original stored price must not be overwritten
    expect(Number(updated.currentPrice)).toBeCloseTo(95)
  })

  it("does not throw when INSTRUMENTS_URL is not set", async () => {
    delete process.env.INSTRUMENTS_URL
    const { db, user } = await makeHarness("q-user-3")
    const { pf } = await seedPortfolioAndPosition(db, user.id)
    const spy = vi.fn()
    vi.stubGlobal("fetch", spy)

    await expect(refreshQuotes(db, user.id, pf.id, "")).resolves.toBeUndefined()
    expect(spy).not.toHaveBeenCalled()
  })

  it("skips closed positions", async () => {
    const { db, user } = await makeHarness("q-user-4")
    const [pf] = await db
      .insert(portfolios)
      .values({ userId: user.id, name: "P", currency: "USD", baseCurrency: "USD" })
      .returning()
    await db.insert(positions).values({
      userId: user.id,
      portfolioId: pf.id,
      symbol: "TSLA",
      quantity: "10",
      averageCostBasis: "200",
      instrumentCurrency: "USD",
      isOpen: false,
    })
    const spy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ currentPrice: 300 }) })
    vi.stubGlobal("fetch", spy)

    await refreshQuotes(db, user.id, pf.id, "Bearer test-token")
    expect(spy).not.toHaveBeenCalled()
  })
})

describe("snapshotPortfolioValue (H5)", () => {
  afterEach(() => vi.unstubAllGlobals())

  it("upserts a value_snapshots row with correct sums", async () => {
    const { db, user } = await makeHarness("snap-user-1")
    const [pf] = await db
      .insert(portfolios)
      .values({ userId: user.id, name: "Snap PF", currency: "USD", baseCurrency: "USD" })
      .returning()

    const posRows = [
      { marketValue: "1800", averageCostBasis: "150", quantity: "10", instrumentCurrency: "USD" },
      { marketValue: "500", averageCostBasis: "200", quantity: "3", instrumentCurrency: "USD" },
    ]
    const now = new Date("2026-09-03T10:00:00Z")
    await snapshotPortfolioValue(db, pf.id, posRows, now)

    const snaps = await db.select().from(valueSnapshots).where(eq(valueSnapshots.portfolioId, pf.id))
    expect(snaps).toHaveLength(1)
    expect(snaps[0].snapshotDate).toBe("2026-09-03")
    expect(Number(snaps[0].value)).toBeCloseTo(2300)   // 1800 + 500
    expect(Number(snaps[0].invested)).toBeCloseTo(2100) // 150×10 + 200×3
  })

  it("is idempotent — second call updates value in place", async () => {
    const { db, user } = await makeHarness("snap-user-2")
    const [pf] = await db
      .insert(portfolios)
      .values({ userId: user.id, name: "Snap PF 2", currency: "USD", baseCurrency: "USD" })
      .returning()

    const posRows = [
      { marketValue: "1000", averageCostBasis: "100", quantity: "10", instrumentCurrency: "USD" },
    ]
    const now = new Date("2026-09-03T10:00:00Z")
    await snapshotPortfolioValue(db, pf.id, posRows, now)
    // second call with updated value
    const posRows2 = [
      { marketValue: "1100", averageCostBasis: "100", quantity: "10", instrumentCurrency: "USD" },
    ]
    await snapshotPortfolioValue(db, pf.id, posRows2, now)

    const snaps = await db.select().from(valueSnapshots).where(eq(valueSnapshots.portfolioId, pf.id))
    expect(snaps).toHaveLength(1)
    expect(Number(snaps[0].value)).toBeCloseTo(1100)
  })

  it("refreshQuotes writes a snapshot row after persisting quote fields", async () => {
    const { db, user } = await makeHarness("snap-user-3")
    process.env.INSTRUMENTS_URL = "http://instruments:3000"
    _clearQuoteCache()
    const [pf] = await db
      .insert(portfolios)
      .values({ userId: user.id, name: "Snap PF 3", currency: "USD", baseCurrency: "USD" })
      .returning()
    await db.insert(positions).values({
      userId: user.id,
      portfolioId: pf.id,
      symbol: "AAPL",
      quantity: "5",
      averageCostBasis: "200",
      instrumentCurrency: "USD",
      isOpen: true,
      currentPrice: null,
      priceSource: "manual",
    })

    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ symbol: "AAPL", currentPrice: 220, change: 2, percentChange: 1, currency: "USD" }),
    }))

    await refreshQuotes(db, user.id, pf.id, "Bearer test-token")
    // give the background void a tick
    await new Promise((r) => setTimeout(r, 50))

    const snaps = await db.select().from(valueSnapshots).where(eq(valueSnapshots.portfolioId, pf.id))
    expect(snaps.length).toBeGreaterThanOrEqual(1)
    // value = 5 × 220 = 1100
    expect(Number(snaps[0].value)).toBeCloseTo(1100)

    vi.unstubAllGlobals()
    delete process.env.INSTRUMENTS_URL
  })
})
