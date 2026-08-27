/**
 * D58 — Valuation via the provider tier.
 *
 * Fetches live quotes from the instruments module for open positions in a
 * portfolio, persists the snapshot columns (currentPrice, marketValue,
 * unrealizedGainLoss, dayChange, dayChangePercent, priceSource, priceAsOf),
 * and never throws — instruments unreachable → priceSource 'fallback'.
 */

import { and, eq } from "drizzle-orm"
import type { DB } from "../db/index.js"
import { positions } from "../db/schema.js"

/** In-process per-symbol quote cache.  Keyed by UPPER symbol. */
interface CachedQuote {
  currentPrice: number
  change: number
  percentChange: number
  currency: string
  fetchedAt: number // Date.now()
}

const quoteCache = new Map<string, CachedQuote>()

/** How long a cached quote is considered fresh (ms).  Override via env. */
const CACHE_TTL_MS = Number(process.env.QUOTE_CACHE_TTL_MS ?? 60_000)

/** How old the stored priceAsOf may be before we attempt a re-fetch (ms). */
const STALE_MS = Number(process.env.QUOTE_STALE_MS ?? 15 * 60_000)

/** Read instruments base URL at call time so tests can set env before calling. */
function instrumentsBase(): string {
  return (
    process.env.INSTRUMENTS_URL ??
    process.env.API_INSTRUMENTS_URL ??
    ""
  ).replace(/\/$/, "")
}

async function fetchQuote(symbol: string): Promise<CachedQuote | null> {
  const base = instrumentsBase()
  if (!base) return null
  try {
    const res = await fetch(`${base}/api/instruments/${symbol}/quote`)
    if (!res.ok) return null
    const data = (await res.json()) as Record<string, unknown>
    const price = Number(data.currentPrice ?? 0)
    if (!price) return null
    const entry: CachedQuote = {
      currentPrice: price,
      change: Number(data.change ?? 0),
      percentChange: Number(data.percentChange ?? 0),
      currency: String(data.currency ?? "USD"),
      fetchedAt: Date.now(),
    }
    quoteCache.set(symbol, entry)
    return entry
  } catch {
    return null
  }
}

function needsRefresh(pos: { priceAsOf: Date | null }): boolean {
  if (!pos.priceAsOf) return true
  return Date.now() - pos.priceAsOf.getTime() > STALE_MS
}

/**
 * Refresh quote snapshot columns for all open positions in a portfolio.
 *
 * - Fetches distinct symbols (cache-aware, short-TTL).
 * - Persists currentPrice, marketValue, unrealizedGainLoss, dayChange,
 *   dayChangePercent, priceSource ('quote' | 'fallback'), priceAsOf.
 * - Never throws; instruments errors → priceSource 'fallback' (stored price
 *   kept as-is, no overwrite if already null).
 */
export async function refreshQuotes(
  db: DB,
  userId: string,
  portfolioId: string,
): Promise<void> {
  if (!instrumentsBase()) return

  const rows = await db
    .select()
    .from(positions)
    .where(
      and(
        eq(positions.userId, userId),
        eq(positions.portfolioId, portfolioId),
        eq(positions.isOpen, true),
      ),
    )

  if (rows.length === 0) return

  // Determine which symbols need fetching (cache miss or stale stored price)
  const toFetch = new Set<string>()
  for (const p of rows) {
    const cached = quoteCache.get(p.symbol)
    const cacheHit = cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS
    if (!cacheHit && needsRefresh(p)) toFetch.add(p.symbol)
  }

  // Fetch in parallel
  await Promise.all([...toFetch].map((sym) => fetchQuote(sym)))

  // Persist snapshot for each position
  const now = new Date()
  await Promise.all(
    rows.map(async (p) => {
      const quote = quoteCache.get(p.symbol)
      if (!quote) {
        // No live quote available — mark as fallback if we have a stored price
        if (p.currentPrice != null) {
          await db
            .update(positions)
            .set({ priceSource: "fallback", updatedAt: now })
            .where(eq(positions.id, p.id))
        }
        return
      }

      const qty = Number(p.quantity)
      const avg = Number(p.averageCostBasis)
      const price = quote.currentPrice
      const mv = price * qty
      const ugl = (price - avg) * qty
      const dayChange = quote.change * qty
      const dayChangePct = quote.percentChange

      await db
        .update(positions)
        .set({
          currentPrice: String(price),
          priceSource: "quote",
          priceAsOf: now,
          marketValue: String(mv),
          unrealizedGainLoss: String(ugl),
          dayChange: String(dayChange),
          dayChangePercent: String(dayChangePct),
          updatedAt: now,
        })
        .where(eq(positions.id, p.id))
    }),
  )
}

/** Exposed for testing: flush the in-process quote cache. */
export function _clearQuoteCache() {
  quoteCache.clear()
}
