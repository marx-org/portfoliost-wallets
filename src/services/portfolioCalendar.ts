/**
 * plan §54.2 — portfolio calendar fan-out (module-boundary design).
 *
 * The wallets module owns positions; instruments owns the per-instrument
 * calendar (§49.9). This service loads a portfolio's distinct open symbols
 * from `positions` (own schema) and fans out to instruments
 * `/api/instruments/:symbol/calendar` per symbol — the same cross-module
 * HTTP pattern as `portfolioNews.ts` — and merges the result into the
 * `CalendarData.holdings` shape. A per-symbol fetch failure omits that
 * symbol (never 500); `INSTRUMENTS_URL` unset degrades to `holdings: []`
 * (1:1, same rule as `instruments-fx.ts`).
 */
import { and, eq } from "drizzle-orm"
import type { DB } from "../db/index.js"
import { positions } from "../db/schema.js"
import type { components } from "../generated/api-types.js"

export type CalendarHolding = components["schemas"]["CalendarHolding"]

const DEFAULT_SYMBOL_LIMIT = 50

function envInt(name: string, fallback: number): number {
  const v = Number(process.env[name])
  return Number.isFinite(v) && v > 0 ? v : fallback
}

export const portfolioCalendarSymbolLimit = () =>
  envInt("PORTFOLIO_CALENDAR_SYMBOL_LIMIT", DEFAULT_SYMBOL_LIMIT)

/** Read instruments base URL at call time so tests can mutate env freely. */
export function instrumentsBase(): string {
  return (
    process.env.INSTRUMENTS_URL ??
    process.env.API_INSTRUMENTS_URL ??
    ""
  ).replace(/\/$/, "")
}

export interface PortfolioSymbol {
  symbol: string
  companyName?: string
}

/** Distinct open symbols of a portfolio (own schema only). */
export async function getPortfolioSymbols(
  db: DB,
  portfolioId: string,
  userId: string,
  limit = DEFAULT_SYMBOL_LIMIT,
): Promise<PortfolioSymbol[]> {
  const rows = await db
    .selectDistinct({ symbol: positions.symbol, companyName: positions.companyName })
    .from(positions)
    .where(
      and(
        eq(positions.portfolioId, portfolioId),
        eq(positions.userId, userId),
        eq(positions.isOpen, true),
      ),
    )
    .limit(limit)
  return rows.map((r) => ({
    symbol: r.symbol,
    ...(r.companyName ? { companyName: r.companyName } : {}),
  }))
}

/** One symbol's calendar as returned by instruments (no `symbol` field). */
interface SymbolCalendar {
  currency?: string
  earnings?: CalendarHolding["earnings"]
  exDividend?: CalendarHolding["exDividend"]
  dividend?: CalendarHolding["dividend"]
}

/** Keep only items carrying a `date` (the contract requires it). */
function itemList<T>(rows: unknown): T[] | undefined {
  if (!Array.isArray(rows)) return undefined
  const kept = rows.filter(
    (r) => r !== null && typeof r === "object" && typeof (r as { date?: unknown }).date === "string",
  ) as T[]
  return kept.length > 0 ? kept : undefined
}

type EarningsItem = NonNullable<CalendarHolding["earnings"]>[number]
type ExDividendItem = NonNullable<CalendarHolding["exDividend"]>[number]
type DividendItem = NonNullable<CalendarHolding["dividend"]>[number]

/** One symbol calendar through instruments. Never throws; null on failure. */
async function fetchSymbolCalendar(symbol: string, authToken: string): Promise<SymbolCalendar | null> {
  const base = instrumentsBase()
  if (!base) return null
  try {
    const url = `${base}/api/instruments/${encodeURIComponent(symbol)}/calendar`
    const res = await fetch(url, { headers: { Authorization: authToken } })
    if (!res.ok) return null
    const body = (await res.json()) as Record<string, unknown>
    const currency = typeof body.currency === "string" && body.currency ? body.currency : undefined
    return {
      currency,
      earnings: itemList<EarningsItem>(body.earnings),
      exDividend: itemList<ExDividendItem>(body.exDividend),
      dividend: itemList<DividendItem>(body.dividend),
    }
  } catch {
    return null
  }
}

/** Build the `CalendarData.holdings` payload for a portfolio's open positions. */
export async function getPortfolioCalendar(
  db: DB,
  portfolioId: string,
  userId: string,
  authToken: string,
  limit = DEFAULT_SYMBOL_LIMIT,
): Promise<CalendarHolding[]> {
  if (!instrumentsBase()) return []
  const symbols = await getPortfolioSymbols(db, portfolioId, userId, limit)
  if (symbols.length === 0) return []

  const results = await Promise.allSettled(
    symbols.map((s) => fetchSymbolCalendar(s.symbol, authToken)),
  )
  const holdings: CalendarHolding[] = []
  symbols.forEach((s, i) => {
    const r = results[i]
    if (r.status !== "fulfilled" || r.value === null) return
    holdings.push({
      symbol: s.symbol,
      ...(s.companyName ? { companyName: s.companyName } : {}),
      ...(r.value.currency ? { currency: r.value.currency } : {}),
      ...(r.value.earnings ? { earnings: r.value.earnings } : {}),
      ...(r.value.exDividend ? { exDividend: r.value.exDividend } : {}),
      ...(r.value.dividend ? { dividend: r.value.dividend } : {}),
    })
  })
  return holdings
}
