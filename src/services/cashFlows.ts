/**
 * Daily net cash-flow series for a portfolio, in the portfolio's base currency.
 *
 * Every BUY/SELL transaction moves cash between the (external) cash account
 * and the portfolio's positions:
 *   - BUY:  cash leaves the account  → +cash    (money deployed into the market)
 *   - SELL: cash returns to account  → −cash    (money released out of the market)
 *
 * Amounts are the wallet-debit/credit convention from createWalletLink —
 * BUY = −(qty×price + feesSettled), SELL = +(qty×price − feesSettled) — with the
 * sign flipped so the result is "net invested" per day (D50). All figures are
 * converted to the portfolio's base currency via instruments' fx_rates (plan
 * §48.3 — rate=1 fallback when instruments is down or a pair is missing).
 *
 * This is the single source of truth for both the portfolio's own return-type
 * columns (value_snapshots.netFlow) and the cash-flow-mirrored benchmark overlay.
 */
import { and, eq, sql } from "drizzle-orm"
import type { DB } from "../db/index.js"
import { portfolioTransactions } from "../db/schema.js"
import { fxTo } from "./instruments-fx.js"

/** Normalise a value that may be a Date, ISO string, or timestamptz string to YYYY-MM-DD. */
function toDateStr(v: unknown): string | null {
  if (!v) return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  const s = String(v)
  // ISO 8601 starts with YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  // fallback: try parsing as a date
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

/**
 * Aggregate BUY/SELL transactions of a portfolio into a per-day net-invested
 * series in base currency. The result is keyed by YYYY-MM-DD and includes every
 * day in [from, to] (missing days are simply absent — callers default to 0).
 *
 * DIVIDEND transactions are excluded: they neither deploy nor release capital
 * in this model (see benchmarks.md "cash flows" note).
 */
export async function dailyNetCashFlows(
  db: DB,
  authToken: string | null,
  portfolioId: string,
  from: string,
  to: string,
  baseCurrency: string,
): Promise<Map<string, number>> {
  const base = baseCurrency.toUpperCase()
  const rows = await db
    .select({
      type: portfolioTransactions.type,
      totalAmount: portfolioTransactions.totalAmount,
      feesSettled: portfolioTransactions.feesSettled,
      currency: portfolioTransactions.currency,
      executedAt: portfolioTransactions.executedAt,
    })
    .from(portfolioTransactions)
    .where(
      and(
        eq(portfolioTransactions.portfolioId, portfolioId),
        sql`${portfolioTransactions.type} in ('BUY','SELL')`,
      ),
    )
    .orderBy(portfolioTransactions.executedAt)

  if (rows.length === 0) return new Map()

  // plan §48.3 — pair rates resolved via instruments, memoized per currency.
  const toBase = await fxTo(authToken, base)

  const flows = new Map<string, number>()
  for (const r of rows) {
    const day = toDateStr(r.executedAt)
    if (!day || day < from || day > to) continue
    const notional = Number(r.totalAmount ?? 0)
    const fees = Number(r.feesSettled ?? 0)
    const cash = r.type === "BUY" ? notional + fees : -(notional - fees)
    const baseAmount = cash * (await toBase((r.currency ?? base).toUpperCase(), 1))
    flows.set(day, (flows.get(day) ?? 0) + baseAmount)
  }
  return flows
}