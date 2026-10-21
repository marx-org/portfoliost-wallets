/**
 * stock-news.md N6 — portfolio news fan-out (module-boundary design).
 *
 * The wallets module owns positions; instruments owns the News domain. This
 * service loads a portfolio's distinct open symbols from `positions` (own
 * schema) and fans out to instruments `/api/news/articles?ticker={symbol}`
 * per ticker — the same cross-module HTTP pattern as `refreshQuotes`
 * (src/services/quotes.ts) — then merges, dedups by URL, sorts `published_at`
 * desc and caps the result.
 */
import { and, eq, inArray } from "drizzle-orm"
import type { DB } from "../db/index.js"
import { positions } from "../db/schema.js"
import { positionInPortfolio } from "../db/position-membership.js"
import { internalServiceUrl } from "./internal-url.js"

const DEFAULT_TICKER_LIMIT = 50
const DEFAULT_FETCH_LIMIT = 50

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

export const portfolioNewsTickerLimit = () => envInt("PORTFOLIO_NEWS_TICKER_LIMIT", DEFAULT_TICKER_LIMIT)
export const portfolioNewsFetchLimit = () => envInt("NEWS_FETCH_LIMIT", DEFAULT_FETCH_LIMIT)

/** Read instruments base URL at call time so tests can mutate env freely. */
export function instrumentsBase(): string {
  return internalServiceUrl(
    process.env.INSTRUMENTS_URL ?? process.env.API_INSTRUMENTS_URL,
    "",
    "instruments",
  )
}

export interface PortfolioNewsRow {
  url: string
  title: string
  summary: string | null
  source: string | null
  publishedAt: Date
  symbols: string[]
  /**
   * The ticker this article was fetched FOR, not one of the companies it
   * happens to mention. `news_articles.symbols` is a text[] because a single
   * article can cover several companies, so the array's first element is
   * whichever one the provider happened to list first — frequently a company
   * this portfolio does not own. §61.11: captioned with that, 37 of 50 news
   * cards rendered a bare ticker because the SPA enriched a name that was not
   * a holding. The requested ticker is by construction one of the article's
   * symbols (`arrayContains(symbols, [ticker])`), and it is the one the user
   * actually holds.
   */
  requestedTicker: string
}

/** Distinct open symbols of a portfolio (own schema only). */
export async function getPortfolioSymbols(
  db: DB,
  portfolioId: string,
  userId: string,
  limit = 50,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ symbol: positions.symbol })
    .from(positions)
    .where(
      and(
        positionInPortfolio(portfolioId),
        eq(positions.userId, userId),
        eq(positions.isOpen, true),
      ),
    )
    .limit(limit)
  return rows.map((r) => r.symbol)
}

/** One ticker fetch through instruments `/api/news/articles`. Never throws. */
async function fetchTickerNews(
  ticker: string,
  authToken: string,
  limit: number,
): Promise<PortfolioNewsRow[]> {
  const base = instrumentsBase()
  if (!base) return []
  try {
    const url = `${base}/api/news/articles?ticker=${encodeURIComponent(ticker)}&limit=${limit}`
    const res = await fetch(url, { headers: { Authorization: authToken } })
    if (!res.ok) return []
    const body = (await res.json()) as {
      data?: Array<Record<string, unknown>>
    }
    return (body.data ?? []).map((a): PortfolioNewsRow | null => {
      const article = (a.article ?? {}) as Record<string, unknown>
      const urlStr = typeof article.url === "string" ? article.url : undefined
      if (!urlStr) return null
      return {
        url: urlStr,
        title: typeof article.title === "string" ? article.title : "Untitled",
        summary: typeof article.description === "string" ? article.description : null,
        source: typeof article.source === "string" ? article.source : null,
        publishedAt: new Date(typeof a.published_at === "string" ? a.published_at : ""),
        // Keep what instruments actually reported, but never let it become the
        // caption — `requestedTicker` is the holding, and it is authoritative.
        symbols: Array.isArray(a.symbols)
          ? a.symbols.filter((x): x is string => typeof x === "string")
          : typeof a.ticker === "string"
            ? [a.ticker]
            : [],
        requestedTicker: ticker,
      }
    }).filter((r): r is PortfolioNewsRow => {
      if (!r) return false
      return !Number.isNaN(r.publishedAt.getTime())
    })
  } catch {
    return []
  }
}

/** Build the `NewsArticleList`-shaped payload for a portfolio's holdings. */
export async function getPortfolioNews(
  db: DB,
  portfolioId: string,
  userId: string,
  authToken: string,
  limit = 50,
): Promise<ReturnType<typeof mergePortfolioNews>> {
  const tickers = await getPortfolioSymbols(db, portfolioId, userId, portfolioNewsTickerLimit())
  if (tickers.length === 0) return { data: [], pagination: emptyPagination() }

  const results = await Promise.allSettled(
    tickers.map((t) => fetchTickerNews(t, authToken, portfolioNewsFetchLimit())),
  )
  const rows: PortfolioNewsRow[] = []
  for (const r of results) {
    if (r.status === "fulfilled") rows.push(...r.value)
  }
  return mergePortfolioNews(rows, limit)
}

/** Merge, dedup by URL, sort `published_at` desc, cap at the caller's limit. */
export function mergePortfolioNews(rows: PortfolioNewsRow[], limit = 50): {
  data: Array<Record<string, unknown>>
  pagination: {
    count: number
    total_count: number
    has_next_page: boolean
    has_previous_page: boolean
    next_cursor: string | null
    previous_cursor: string | null
  }
} {
  const seen = new Set<string>()
  const merged: PortfolioNewsRow[] = []
  for (const r of rows) {
    if (seen.has(r.url)) continue
    seen.add(r.url)
    merged.push(r)
  }
  merged.sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime())
  const page = merged.slice(0, limit)

  const data = page.map((r) => ({
    id: r.url,
    type: "article",
    ...(r.requestedTicker ? { ticker: r.requestedTicker } : {}),
    metadata: r.source ? { source: r.source } : undefined,
    article: {
      title: r.title,
      url: r.url,
      source: r.source ?? undefined,
      description: r.summary ?? undefined,
      published_at: r.publishedAt.toISOString(),
    },
    published_at: r.publishedAt.toISOString(),
  }))

  return {
    data,
    pagination: {
      count: data.length,
      total_count: data.length,
      has_next_page: false,
      has_previous_page: false,
      next_cursor: null,
      previous_cursor: null,
    },
  }
}

function emptyPagination() {
  return {
    count: 0,
    total_count: 0,
    has_next_page: false,
    has_previous_page: false,
    next_cursor: null,
    previous_cursor: null,
  }
}
