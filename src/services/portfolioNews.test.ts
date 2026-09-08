import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeHarness } from "../routes/test-utils.js"
import { portfolios, positions } from "../db/schema.js"
import { uuid } from "drizzle-orm/pg-core"

import {
  getPortfolioNews,
  getPortfolioSymbols,
  mergePortfolioNews,
  instrumentsBase,
} from "./portfolioNews.js"

function fakeArticle(url: string, ticker = "AAPL", publishedAt = "2026-09-08T08:00:00Z") {
  return {
    id: url,
    type: "article",
    ticker,
    article: { url, title: `Headline ${url}`, source: "polygon", published_at: publishedAt },
    published_at: publishedAt,
  }
}

function stubFetch(body: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => body }))
}

beforeEach(() => {
  vi.stubGlobal("process", { ...process, env: { ...process.env, API_INSTRUMENTS_URL: "http://instruments:3000" } })
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
  it("returns distinct open symbols of the owned portfolio only", async () => {
    const h = await makeHarness()
    const [p] = await h.db
      .insert(portfolios)
      .values({ name: "Growth", currency: "USD", userId: h.user.id })
      .returning()
    await h.db.insert(positions).values([
      { portfolioId: p.id, userId: h.user.id, symbol: "AAPL", isOpen: true },
      { portfolioId: p.id, userId: h.user.id, symbol: "MSFT", isOpen: true },
      { portfolioId: p.id, userId: h.user.id, symbol: "TSLA", isOpen: true },
      { portfolioId: p.id, userId: h.user.id, symbol: "CLOSED", isOpen: false },
    ])
    // another user's positions must not leak
    await h.db.insert(positions).values({ portfolioId: p.id, userId: "user-2", symbol: "NVDA", isOpen: true })
    const syms = await getPortfolioSymbols(h.db, p.id, h.user.id)
    expect(syms).toEqual(["AAPL", "MSFT", "TSLA"])
  })
})

describe("getPortfolioNews", () => {
  it("returns empty list for a portfolio with no positions", async () => {
    const h = await makeHarness()
    const [p] = await h.db
      .insert(portfolios)
      .values({ name: "Growth", currency: "USD", userId: h.user.id })
      .returning()
    const out = await getPortfolioNews(h.db, p.id, h.user.id, "Bearer x")
    expect(out.data).toEqual([])
    expect(out.pagination).toMatchObject({ count: 0, total_count: 0 })
  })

  it("fans out per ticker, merges, dedups by url and sorts desc", async () => {
    const h = await makeHarness()
    const [p] = await h.db
      .insert(portfolios)
      .values({ name: "Growth", currency: "USD", userId: h.user.id })
      .returning()
    await h.db.insert(positions).values([
      { portfolioId: p.id, userId: h.user.id, symbol: "AAPL", isOpen: true },
      { portfolioId: p.id, userId: h.user.id, symbol: "MSFT", isOpen: true },
    ])

    const fetchFn = vi.fn((url: string) => {
      if (url.includes("AAPL")) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            data: [
              fakeArticle("https://a.com/1", "AAPL", "2026-09-08T10:00:00Z"),
              fakeArticle("https://a.com/shared", "AAPL", "2026-09-08T09:00:00Z"),
            ],
          }),
        })
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({
          data: [fakeArticle("https://a.com/shared", "MSFT", "2026-09-08T09:00:00Z")],
        }),
      })
    })
    vi.stubGlobal("fetch", fetchFn)

    const out = await getPortfolioNews(h.db, p.id, h.user.id, "Bearer x")
    // dedup drops the shared MSFT copy; desc sort puts 10:00 first
    expect(out.data.map((d) => d.id)).toEqual(["https://a.com/1", "https://a.com/shared"])
    expect(fetchFn).toHaveBeenCalledTimes(2)
    const calls = fetchFn.mock.calls as unknown as Array<[string, { headers?: { Authorization?: string } }]>
    expect(calls[0][0]).toContain("/api/news/articles?ticker=AAPL&limit=50")
    expect(calls[0][1].headers?.Authorization).toBe("Bearer x")
    expect(out.pagination.total_count).toBe(2)
  })

  it("never throws when instruments is down — returns what merge yields", async () => {
    const h = await makeHarness()
    const [p] = await h.db
      .insert(portfolios)
      .values({ name: "Growth", currency: "USD", userId: h.user.id })
      .returning()
    await h.db.insert(positions).values({ portfolioId: p.id, userId: h.user.id, symbol: "AAPL", isOpen: true })
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")))
    const out = await getPortfolioNews(h.db, p.id, h.user.id, "Bearer x")
    expect(out.data).toEqual([])
    expect(out.pagination.count).toBe(0)
  })
})

describe("mergePortfolioNews", () => {
  it("sorts desc and caps at limit", () => {
    const rows = [
      { url: "https://a.com/2", title: "t2", summary: null, source: null, publishedAt: new Date("2026-01-01T00:00:00Z"), symbols: [] },
      { url: "https://a.com/1", title: "t1", summary: null, source: null, publishedAt: new Date("2026-06-01T00:00:00Z"), symbols: [] },
      { url: "https://a.com/3", title: "t3", summary: null, source: null, publishedAt: new Date("2026-12-01T00:00:00Z"), symbols: [] },
    ]
    const out = mergePortfolioNews(rows, 2)
    expect(out.data.map((d) => d.id)).toEqual(["https://a.com/3", "https://a.com/1"])
    expect(out.pagination.count).toBe(2)
    expect(out.pagination.has_next_page).toBe(false)
  })
})