import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeHarness } from "../routes/test-utils.js"
import { portfolios, positions, valueSnapshots, portfolioTransactions, portfolioCashTransactions } from "../db/schema.js"
import { eq } from "drizzle-orm"
import { refreshQuotes, snapshotPortfolioValue, _clearQuoteCache, isIsoCurrency } from "./quotes.js"

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
            // instruments always tags how it resolved the currency
            // (toInstrumentDetail threads the §47.4 resolution through).
            currencySource: "provider",
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

describe("isIsoCurrency (§39)", () => {
  it("accepts ISO codes in upper and lower case", () => {
    expect(isIsoCurrency("GBP")).toBe(true)
    expect(isIsoCurrency("usd")).toBe(true)
    expect(isIsoCurrency("PLN")).toBe(true)
  })
  it("rejects the pence unit code in any casing", () => {
    expect(isIsoCurrency("GBp")).toBe(false)
    expect(isIsoCurrency("gbp")).toBe(false)
    expect(isIsoCurrency("gBP")).toBe(false)
  })
  it("rejects non-currency junk", () => {
    expect(isIsoCurrency("GB")).toBe(false)
    expect(isIsoCurrency("GBPx")).toBe(false)
    expect(isIsoCurrency(123)).toBe(false)
    expect(isIsoCurrency(null)).toBe(false)
  })
})

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

  // §63.2 (2026-09-30). The snapshot write used to be `void …`, and the
  // recompute syncs `current_value` from the latest snapshot on the next line —
  // so the stored card was written from the PREVIOUS (price-bar) snapshot and
  // disagreed with the live headline. 9 of 10 PROD portfolios could not see it
  // (cash-only or unpriced bonds make both paths agree); only a portfolio with
  // priced positions did, and there the gap survived a recompute.
  //
  // The test is about ORDERING, not arithmetic, so it makes the snapshot slow:
  // if refreshQuotes resolves before the row exists, the race is back.
  it("§76.4 — refreshQuotes writes NO snapshot; positions are priced and the row is left to the batch", async () => {
    const { db, user } = await makeHarness("q-race")
    const { pf, pos } = await seedPortfolioAndPosition(db, user.id, { qty: 10, avg: 150 })

    // Slow the FX resolution so a slow path would be visible if one existed.
    mockFetch(180, 3, 1.7)
    const realFetch = globalThis.fetch
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).includes("/api/internal/fx-rates")) {
          await new Promise((r) => setTimeout(r, 40))
        }
        return (realFetch as (a: unknown, b?: unknown) => Promise<Response>)(input, init)
      }),
    )

    await refreshQuotes(db, user.id, pf.id, "Bearer test-token")

    // This test used to assert the opposite — that today's row EXISTS by the time
    // refreshQuotes resolves, which is the §63.2 race fix (c195839). §76.4 removed
    // the precondition for that race: `computeSnapshotBatch` is now the only
    // writer of value_snapshots, so there is nothing for the live path to race.
    const snaps = await db
      .select()
      .from(valueSnapshots)
      .where(eq(valueSnapshots.portfolioId, pf.id))
    expect(snaps).toHaveLength(0)

    // What refreshQuotes IS still responsible for: pricing the position.
    const [updated] = await db.select().from(positions).where(eq(positions.id, pos.id))
    expect(Number(updated.marketValue)).toBeCloseTo(1800)
    expect(updated.priceSource).toBe("quote")
    expect(updated.priceAsOf).not.toBeNull()
  })

  // The second half of the §63.2 fix. Awaiting the snapshot write made a
  // latent hazard reachable: the no-quote fallback pushes the position's
  // STORED marketValue, which is 0 until a position has been quoted once. If we
  // hold positions and priced none, writing today's snapshot as 0 would set
  // `current_value` to 0 and wipe the headline — the old fire-and-forget hid
  // that by writing too late.
  it("does not write today's snapshot when it holds positions but priced none", async () => {
    const { db, user } = await makeHarness("q-noclobber")
    const { pf, pos } = await seedPortfolioAndPosition(db, user.id, { qty: 10, avg: 150 })
    // A good backfilled value that must survive.
    await db.insert(valueSnapshots).values({
      portfolioId: pf.id,
      snapshotDate: new Date().toISOString().slice(0, 10),
      value: "1600",
      invested: "1500",
    })

    // instruments is unreachable: no quote, no profile.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })))

    await refreshQuotes(db, user.id, pf.id, "Bearer test-token")

    const snaps = await db
      .select()
      .from(valueSnapshots)
      .where(eq(valueSnapshots.portfolioId, pf.id))
    expect(snaps).toHaveLength(1)
    expect(Number(snaps[0].value)).toBeCloseTo(1600) // NOT overwritten with 0
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

  it("§39: rejects a non-ISO quote/profile currency (GBp) and keeps the stored currency", async () => {
    const { db, user } = await makeHarness("q-user-gbp")
    // a real LSE position recorded in GBP — the live provider (biznesradar)
    // answers the quote/profile with the pence unit code "GBp".
    const { pf, pos } = await seedPortfolioAndPosition(db, user.id, { qty: 861, avg: 5 })
    await db.update(positions).set({ instrumentCurrency: "GBP" }).where(eq(positions.id, pos.id))
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const u = String(url)
        if (u.includes("/profile")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ ticker: "CSN.L", name: "Chesnara plc", country: "GB", currency: "GBp" }),
          })
        }
        return Promise.resolve({
          ok: true,
          // instruments §39.1 already normalizes this to GBP/3.575; this test
          // guards the wallets boundary against a regressed raw provider row.
          json: async () => ({ symbol: "CSN.L", currentPrice: 357.5, change: 0.5, percentChange: 0.14, currency: "GBp" }),
        })
      }),
    )

    await refreshQuotes(db, user.id, pf.id, "Bearer test-token")

    const [updated] = await db.select().from(positions).where(eq(positions.id, pos.id))
    // non-ISO code must NOT overwrite the canonical buy-time currency
    expect(updated.instrumentCurrency).toBe("GBP")
    expect(updated.companyName).toBe("Chesnara plc")
    expect(updated.country).toBe("GB")
  })

  it("§71: presents a SERVICE token in X-Service-Token, not Authorization", async () => {
    // instruments' serviceOrUserMiddleware reads the scheduled sweep's
    // credential from X-Service-Token and only falls back to a Bearer JWT in
    // Authorization. Both fetchers used to hardcode Authorization, so the sweep's
    // token went to the wrong header and every scheduled refresh 401'd — silently,
    // because refreshQuotes treats an instruments error as "keep stored values,
    // mark fallback". The job logged "priced" twice a day while writing nothing.
    const { db, user } = await makeHarness("q-user-hdr")
    const { pf } = await seedPortfolioAndPosition(db, user.id, { qty: 1, avg: 100 })
    const seen: Array<Record<string, string>> = []
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init: { headers?: Record<string, string> }) => {
        seen.push(init?.headers ?? {})
        return Promise.resolve({
          ok: true,
          json: async () => ({ symbol: "SRT.F", currentPrice: 208, change: 1, percentChange: 0.5, currency: "EUR" }),
        })
      }),
    )

    await refreshQuotes(db, user.id, pf.id, "svc-not-a-bearer-token")

    expect(seen.length).toBeGreaterThan(0)
    for (const h of seen) {
      expect(h["X-Service-Token"]).toBe("svc-not-a-bearer-token")
      expect(h["Authorization"]).toBeUndefined()
    }
  })

  it("§71: a user JWT still goes in Authorization", async () => {
    const { db, user } = await makeHarness("q-user-hdr2")
    const { pf } = await seedPortfolioAndPosition(db, user.id, { qty: 1, avg: 100 })
    const seen: Array<Record<string, string>> = []
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string, init: { headers?: Record<string, string> }) => {
        seen.push(init?.headers ?? {})
        return Promise.resolve({ ok: true, json: async () => ({ symbol: "ASML", currentPrice: 1743, change: 1, percentChange: 0.5, currency: "EUR" }) })
      }),
    )

    await refreshQuotes(db, user.id, pf.id, "Bearer user-jwt")

    for (const h of seen) {
      expect(h["Authorization"]).toBe("Bearer user-jwt")
      expect(h["X-Service-Token"]).toBeUndefined()
    }
  })

  it("§39: still overwrites instrumentCurrency when the quote carries an ISO code", async () => {
    const { db, user } = await makeHarness("q-user-gbp2")
    const { pf, pos } = await seedPortfolioAndPosition(db, user.id, { qty: 10, avg: 150 })
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const u = String(url)
        if (u.includes("/profile")) {
          return Promise.resolve({
            ok: true,
            // currencySource: "provider" — a real upstream declaration. This is
            // the case where overwriting IS correct: `market_value` is stored in
            // the QUOTE's currency, so a provider-confirmed currency that
            // disagrees with the position has to win or the value is misconverted.
            json: async () => ({ ticker: "CSN.L", name: "Chesnara plc", country: "GB", currency: "GBP", currencySource: "provider" }),
          })
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ symbol: "CSN.L", currentPrice: 3.575, change: 0.005, percentChange: 0.14, currency: "GBP" }),
        })
      }),
    )

    await refreshQuotes(db, user.id, pf.id, "Bearer test-token")

    const [updated] = await db.select().from(positions).where(eq(positions.id, pos.id))
    expect(updated.instrumentCurrency).toBe("GBP")
    expect(Number(updated.currentPrice)).toBeCloseTo(3.575)
  })

  // ── §71 — provenance decides whether a currency may overwrite a stored one ──

  it("§71: an ESTIMATED currency never overwrites a stored one (PROD CRI.WA)", async () => {
    // The incident: the import wrote the true currency (PLN — still on both of
    // CRI.WA's BUY transactions), then every quote refresh replaced it with the
    // locally-inferred CAD. `market_value` is multiplied by this label, so the
    // live headline overstated that position by 16,190 PLN — an 18% divergence
    // from the stored series that reconciled fine everywhere else.
    const { db, user } = await makeHarness("q-user-cri71")
    const { pf, pos } = await seedPortfolioAndPosition(db, user.id, { qty: 13, avg: 234.38 })
    await db.update(positions).set({ instrumentCurrency: "PLN" }).where(eq(positions.id, pos.id))
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const u = String(url)
        if (u.includes("/profile")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({
              ticker: "CRI.WA",
              name: "Creotech Instruments S.A.",
              country: "PL",
              currency: "CAD",
              currencySource: "estimated", // instruments guessed, from a TSXV listing
            }),
          })
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ symbol: "CRI.WA", currentPrice: 727, change: -17, percentChange: -2.28, currency: "CAD" }),
        })
      }),
    )

    await refreshQuotes(db, user.id, pf.id, "Bearer test-token")

    const [updated] = await db.select().from(positions).where(eq(positions.id, pos.id))
    expect(updated.instrumentCurrency).toBe("PLN")
    // the price is still refreshed — only the label is protected
    expect(Number(updated.currentPrice)).toBeCloseTo(727)
  })

  it("§71: an estimated currency still fills a position that has none", async () => {
    // Nothing to protect, so the estimate is better than nothing — it is tagged
    // `estimated` on the wire, which is what the SPA badge reads. (The column is
    // NOT NULL, so "unset" is the empty string, not null.)
    const { db, user } = await makeHarness("q-user-cri71b")
    const { pf, pos } = await seedPortfolioAndPosition(db, user.id, { qty: 5, avg: 100 })
    await db.update(positions).set({ instrumentCurrency: "" }).where(eq(positions.id, pos.id))
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const u = String(url)
        if (u.includes("/profile")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ ticker: "NEW.WA", name: "Newco", country: "PL", currency: "PLN", currencySource: "estimated" }),
          })
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ symbol: "NEW.WA", currentPrice: 50, change: 1, percentChange: 2, currency: "PLN" }),
        })
      }),
    )

    await refreshQuotes(db, user.id, pf.id, "Bearer test-token")

    const [updated] = await db.select().from(positions).where(eq(positions.id, pos.id))
    expect(updated.instrumentCurrency).toBe("PLN")
  })

  it("45.3: a null-currency profile keeps the stored instrumentCurrency (no USD clobber)", async () => {
    const { db, user } = await makeHarness("q-user-453")
    const { pf, pos } = await seedPortfolioAndPosition(db, user.id, { qty: 10, avg: 150 })
    // a sheet import set the true price currency; the provider profile/quote
    // now declares no currency (nullable since contracts 1.6.29) and must
    // NOT clobber the stored value.
    await db.update(positions).set({ instrumentCurrency: "PLN" }).where(eq(positions.id, pos.id))
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const u = String(url)
        if (u.includes("/profile")) {
          return Promise.resolve({
            ok: true,
            json: async () => ({ ticker: "INGAKC.TFI", name: "ING Akcji", currency: null }),
          })
        }
        return Promise.resolve({
          ok: true,
          json: async () => ({ symbol: "INGAKC.TFI", currentPrice: 812.36, change: 13.56, percentChange: 1.7, currency: null }),
        })
      }),
    )

    await refreshQuotes(db, user.id, pf.id, "Bearer test-token")

    const [updated] = await db.select().from(positions).where(eq(positions.id, pos.id))
    expect(updated.instrumentCurrency).toBe("PLN")
    expect(Number(updated.currentPrice)).toBeCloseTo(812.36)
  })

  it("heals the 'Other' sentinel + null values with the profile (plan §28.5)", async () => {
    const { db, user } = await makeHarness("q-user-7")
    const { pf, pos } = await seedPortfolioAndPosition(db, user.id, { qty: 5, avg: 200 })
    // an imported position from before the catalog existed — every field holds
    // the "Other" sentinel (or null); the next quotes pass must self-heal.
    await db
      .update(positions)
      .set({ sector: "Other", industry: "Other", country: "Other" })
      .where(eq(positions.id, pos.id))
    mockFetch(210)

    await refreshQuotes(db, user.id, pf.id, "Bearer test-token")

    const [updated] = await db.select().from(positions).where(eq(positions.id, pos.id))
    expect(updated.sector).toBe("Technology")
    expect(updated.industry).toBe("Technology")
    expect(updated.country).toBe("US")
  })

  it("keeps curated catalog values — a real sector/country is never overwritten (plan §28.5)", async () => {
    const { db, user } = await makeHarness("q-user-8")
    const { pf, pos } = await seedPortfolioAndPosition(db, user.id, { qty: 5, avg: 200 })
    // the Podsumowanie catalog resolved Synektik (SNT.WA) to Healthcare/PL;
    // the live profile (Technology/US) must not clobber the curated data.
    await db
      .update(positions)
      .set({ sector: "Healthcare", industry: "Medical Devices", country: "PL" })
      .where(eq(positions.id, pos.id))
    mockFetch(210)

    await refreshQuotes(db, user.id, pf.id, "Bearer test-token")

    const [updated] = await db.select().from(positions).where(eq(positions.id, pos.id))
    expect(updated.sector).toBe("Healthcare")
    expect(updated.industry).toBe("Medical Devices")
    expect(updated.country).toBe("PL")
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
      .values({ userId: user.id, name: "P", baseCurrency: "USD" })
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

  it("§76.4 — computes the right sums and writes NO value_snapshots row", async () => {
    const { db, user } = await makeHarness("snap-user-1")
    const [pf] = await db
      .insert(portfolios)
      .values({ userId: user.id, name: "Snap PF", baseCurrency: "USD" })
      .returning()

    // 2026-09-27 — invested = net external flow. Seed a 2100 deposit paired
    // with a 2100 BUY so the deposit is the invested basis and the cash
    // balance stays 0 (deposit − purchase) → value is just the positions.
    await db.insert(portfolioTransactions).values({
      userId: user.id, portfolioId: pf.id, type: "BUY", instrumentSymbol: "X",
      quantity: "1", price: "2100", currency: "USD", instrumentCurrency: "USD",
      totalAmount: "2100", executedAt: new Date("2026-09-03T09:00:00Z"),
    })
    await db.insert(portfolioCashTransactions).values({
      userId: user.id, portfolioId: pf.id, type: "DEPOSIT", amount: "2100",
      currency: "USD", transactionDate: "2026-09-03",
    })
    const posRows = [
      { marketValue: "1800", averageCostBasis: "150", quantity: "10", instrumentCurrency: "USD" },
      { marketValue: "500", averageCostBasis: "200", quantity: "3", instrumentCurrency: "USD" },
    ]
    const now = new Date("2026-09-03T10:00:00Z")
    const computed = await snapshotPortfolioValue(db, "Bearer t", pf.id, posRows, now)

    expect(computed.snapshotDate).toBe("2026-09-03")
    expect(Number(computed.value)).toBeCloseTo(2300)   // 1800 + 500
    expect(Number(computed.invested)).toBeCloseTo(2100) // = the deposit

    // §76.4 — the single-writer invariant. This is the assertion that replaced
    // "a row was upserted and current_value followed": `computeSnapshotBatch`
    // owns every (portfolioId, date), so a second writer here is the bug.
    expect(await db.select().from(valueSnapshots).where(eq(valueSnapshots.portfolioId, pf.id))).toHaveLength(0)
  })

  it("§76.4 — repeated calls recompute and never accumulate rows", async () => {
    const { db, user } = await makeHarness("snap-user-2")
    const [pf] = await db
      .insert(portfolios)
      .values({ userId: user.id, name: "Snap PF 2", baseCurrency: "USD" })
      .returning()

    const posRows = [
      { marketValue: "1000", averageCostBasis: "100", quantity: "10", instrumentCurrency: "USD" },
    ]
    const now = new Date("2026-09-03T10:00:00Z")
    const first = await snapshotPortfolioValue(db, "Bearer t", pf.id, posRows, now)
    expect(Number(first.value)).toBeCloseTo(1000)

    // second call with updated value
    const posRows2 = [
      { marketValue: "1100", averageCostBasis: "100", quantity: "10", instrumentCurrency: "USD" },
    ]
    const second = await snapshotPortfolioValue(db, "Bearer t", pf.id, posRows2, now)
    expect(Number(second.value)).toBeCloseTo(1100)

    // Still nothing written — and specifically not two rows for one date.
    const snaps = await db.select().from(valueSnapshots).where(eq(valueSnapshots.portfolioId, pf.id))
    expect(snaps).toHaveLength(0)
  })

  it("§76.4 — refreshQuotes prices positions but leaves the row to the batch", async () => {
    const { db, user } = await makeHarness("snap-user-3")
    process.env.INSTRUMENTS_URL = "http://instruments:3000"
    _clearQuoteCache()
    const [pf] = await db
      .insert(portfolios)
      .values({ userId: user.id, name: "Snap PF 3", baseCurrency: "USD" })
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
    // an extra tick: if a background write were still scheduled, it would land
    await new Promise((r) => setTimeout(r, 50))

    const snaps = await db.select().from(valueSnapshots).where(eq(valueSnapshots.portfolioId, pf.id))
    expect(snaps).toHaveLength(0)

    // …and the quote fields themselves WERE persisted (5 × 220 = 1100).
    const [posRow] = await db.select().from(positions).where(eq(positions.portfolioId, pf.id))
    expect(Number(posRow.marketValue)).toBeCloseTo(1100)
    expect(posRow.priceSource).toBe("quote")

    vi.unstubAllGlobals()
    delete process.env.INSTRUMENTS_URL
  })
})

/**
 * #37 — `portfolios.total_invested` must be reachable by the nightly job, not
 * only by an actual insert. The import is insert-only, so a re-import skips
 * every row as a duplicate and the column keeps its old value; a fix to the basis
 * therefore could not reach existing rows without a destructive wipe. This is
 * the assertion that makes the column self-healing.
 */
describe("#37: the nightly refresh persists the capital basis", () => {
  beforeEach(() => {
    process.env.INSTRUMENTS_URL = "http://instruments:3000"
    _clearQuoteCache()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.INSTRUMENTS_URL
  })

  it("writes total_invested, including the transfer term, on a plain refresh", async () => {
    const { db, user } = await makeHarness("q-user-37")
    const { pf } = await seedPortfolioAndPosition(db, user.id, { qty: 10, avg: 150 })
    mockFetch(180, 3, 1.7)

    // An in-kind transfer OUT of 2 shares, cost 150 each → basis must fall by 300.
    await db.insert(portfolioCashTransactions).values({
      userId: user.id, portfolioId: pf.id, type: "DEPOSIT", amount: "2100",
      currency: "USD", transactionDate: "2026-09-03",
    })
    await db.insert(portfolioTransactions).values({
      userId: user.id, portfolioId: pf.id, type: "TRANSFER_OUT", instrumentSymbol: "X",
      quantity: "2", price: "150", currency: "USD", instrumentCurrency: "USD",
      totalAmount: "300", executedAt: new Date("2026-09-03T09:00:00Z"),
      // ck_ptx_transfer_out_source requires it; no FK, so any id will do here.
      sourceTransactionId: crypto.randomUUID(),
    })

    await refreshQuotes(db, user.id, pf.id, "Bearer test-token")

    const [after] = await db.select().from(portfolios).where(eq(portfolios.id, pf.id))
    // 2100 deposit − 300 transferred out. Before this was persisted at all the
    // column stayed 0 until an import or an interactive edit happened to run.
    expect(Number(after.totalInvested)).toBeCloseTo(1800, 2)
  })
})
