import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeHarness, insertPosition, insertPositions } from "../routes/test-utils.js"
import { portfolios } from "../db/schema.js"

import { getPortfolioCalendar, getPortfolioSymbols, instrumentsBase } from "./portfolioCalendar.js"

function instrumentCalendar(payload: Record<string, unknown>) {
  return {
    earnings: [],
    exDividend: [],
    dividend: [],
    currency: "USD",
    ...payload,
  }
}

function stubFetch(handler: (url: string) => Promise<{ ok: boolean; json?: () => Promise<unknown> }>) {
  const fn = vi.fn(handler)
  vi.stubGlobal("fetch", fn)
  return fn
}

beforeEach(() => {
  vi.stubGlobal("process", {
    ...process,
    env: { ...process.env, API_INSTRUMENTS_URL: "http://instruments:3000" },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("instrumentsBase", () => {
  it("reads API_INSTRUMENTS_URL at call time and strips trailing slash", () => {
    expect(instrumentsBase()).toBe("http://instruments:3000")
  })
})

describe("getPortfolioSymbols", () => {
  it("returns distinct open symbols with company names, own portfolio only", async () => {
    const h = await makeHarness()
    const [p] = await h.db.insert(portfolios).values({ name: "Growth", userId: h.user.id }).returning()
    await insertPositions(h.db, [
      { portfolioId: p.id, userId: h.user.id, symbol: "AAPL", companyName: "Apple Inc.", isOpen: true },
      { portfolioId: p.id, userId: h.user.id, symbol: "MSFT", isOpen: true },
      { portfolioId: p.id, userId: h.user.id, symbol: "CLOSED", isOpen: false },
      { portfolioId: p.id, userId: "user-2", symbol: "NVDA", isOpen: true },
    ])
    const syms = await getPortfolioSymbols(h.db, p.id, h.user.id)
    expect(syms).toEqual([
      { symbol: "AAPL", companyName: "Apple Inc." },
      { symbol: "MSFT" },
    ])
  })
})

describe("getPortfolioCalendar", () => {
  it("fans out per symbol and returns holdings with arrays and instruments currency", async () => {
    const h = await makeHarness()
    const [p] = await h.db.insert(portfolios).values({ name: "Growth", userId: h.user.id }).returning()
    await insertPositions(h.db, [
      { portfolioId: p.id, userId: h.user.id, symbol: "AAPL", companyName: "Apple Inc.", isOpen: true },
      { portfolioId: p.id, userId: h.user.id, symbol: "MSFT", isOpen: true },
    ])

    const fetchFn = stubFetch((url) => {
      if (url.includes("AAPL")) {
        return Promise.resolve({
          ok: true,
          json: async () =>
            instrumentCalendar({
              currency: "USD",
              earnings: [{ date: "2026-11-04", title: "Earnings Report", year: 2026, quarter: 4 }],
              exDividend: [{ date: "2026-10-10", title: "Ex-Dividend", year: 2026, amount: 0.26 }],
            }),
        })
      }
      return Promise.resolve({
        ok: true,
        json: async () =>
          instrumentCalendar({
            currency: "USD",
            dividend: [{ date: "2026-12-15", title: "Dividend", year: 2026, amount: 3.32 }],
          }),
      })
    })

    const holdings = await getPortfolioCalendar(h.db, p.id, h.user.id, "Bearer x")
    expect(holdings).toHaveLength(2)
    const aapl = holdings.find((r) => r.symbol === "AAPL")
    expect(aapl).toEqual({
      symbol: "AAPL",
      companyName: "Apple Inc.",
      currency: "USD",
      earnings: [{ date: "2026-11-04", title: "Earnings Report", year: 2026, quarter: 4 }],
      exDividend: [{ date: "2026-10-10", title: "Ex-Dividend", year: 2026, amount: 0.26 }],
    })
    const msft = holdings.find((r) => r.symbol === "MSFT")
    expect(msft?.currency).toBe("USD")
    expect(msft?.dividend).toEqual([{ date: "2026-12-15", title: "Dividend", year: 2026, amount: 3.32 }])
    expect(msft?.earnings).toBeUndefined()

    expect(fetchFn).toHaveBeenCalledTimes(2)
    const calls = fetchFn.mock.calls as unknown as Array<[string, { headers?: { Authorization?: string } }]>
    expect(calls[0][0]).toContain("/api/instruments/AAPL/calendar")
    expect(calls[0][1].headers?.Authorization).toBe("Bearer x")
  })

  it("omits a symbol whose calendar fetch fails, keeps the others", async () => {
    const h = await makeHarness()
    const [p] = await h.db.insert(portfolios).values({ name: "Growth", userId: h.user.id }).returning()
    await insertPositions(h.db, [
      { portfolioId: p.id, userId: h.user.id, symbol: "AAPL", isOpen: true },
      { portfolioId: p.id, userId: h.user.id, symbol: "MSFT", isOpen: true },
    ])

    stubFetch((url) => {
      if (url.includes("AAPL")) return Promise.resolve({ ok: false })
      return Promise.resolve({
        ok: true,
        json: async () => instrumentCalendar({ currency: "USD" }),
      })
    })

    const holdings = await getPortfolioCalendar(h.db, p.id, h.user.id, "Bearer x")
    expect(holdings).toEqual([{ symbol: "MSFT", currency: "USD" }])
  })

  it("returns no holdings and zero fetches for a portfolio with no open positions", async () => {
    const h = await makeHarness()
    const [p] = await h.db.insert(portfolios).values({ name: "Growth", userId: h.user.id }).returning()
    const fetchFn = stubFetch(() => Promise.resolve({ ok: true, json: async () => instrumentCalendar({}) }))
    const holdings = await getPortfolioCalendar(h.db, p.id, h.user.id, "Bearer x")
    expect(holdings).toEqual([])
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it("degrades to empty holdings when no instruments URL is configured", async () => {
    vi.stubGlobal("process", {
      ...process,
      env: { ...process.env, INSTRUMENTS_URL: "", API_INSTRUMENTS_URL: "" },
    })
    const h = await makeHarness()
    const [p] = await h.db.insert(portfolios).values({ name: "Growth", userId: h.user.id }).returning()
    await insertPosition(h.db, { portfolioId: p.id, userId: h.user.id, symbol: "AAPL", isOpen: true })
    const fetchFn = stubFetch(() => Promise.resolve({ ok: true, json: async () => instrumentCalendar({}) }))
    const holdings = await getPortfolioCalendar(h.db, p.id, h.user.id, "Bearer x")
    expect(holdings).toEqual([])
    expect(fetchFn).not.toHaveBeenCalled()
  })
})
