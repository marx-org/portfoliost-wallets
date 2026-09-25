/**
 * Plan §62 — portfolio-native cash ledger, derived by replay.
 *
 * A portfolio owns its cash as a per-currency ledger; nothing is stored. The
 * per-currency balance is a pure function of:
 *   (a) portfolio trade rows — BUY −(notional+fees), SELL +(notional−fees),
 *       DIVIDEND +net (the §49 convention: totalAmount is net of tax) −
 *       fees; principal leg in `tx.currency`, fee leg in
 *       `tx.feeCurrency ?? tx.currency`; and
 *   (b) external rows (portfolio_cash_transactions: DEPOSIT +, WITHDRAWAL −,
 *       TRANSFER as sent — the stored amount is already the row's signed
 *       own-currency effect).
 *
 * Splits/ADJUSTMENT have no cash effect. Negative balances are allowed
 * (replay fidelity — real ledgers dip negative before a deposit lands).
 */
import { and, eq, inArray, sql } from "drizzle-orm"
import type { DB } from "../db/index.js"
import { portfolioCashTransactions, portfolioTransactions } from "../db/schema.js"
import { fxToOnDay, resolvedFxRate } from "./instruments-fx.js"
const TRADE_CASH_TYPES = ["BUY", "SELL", "DIVIDEND"] as const

/**
 * Normalise a value that may be a Date, ISO string, or timestamptz string to
 * YYYY-MM-DD (local-day of the UTC instant).
 */
export function toDateStr(v: unknown): string | null {
  if (!v) return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  const s = String(v)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

/**
 * Signed per-currency cash effects of one portfolio trade row.
 *
 *   principal leg (tx.currency):      BUY −|totalAmount|, SELL +|totalAmount|,
 *                                     DIVIDEND +|totalAmount| (net, §49)
 *   fee leg (feeCurrency ?? currency): −|fee| for every type (a fee is always
 *       a cost the account pays)
 *
 * `feesSettled` is already materialized in the fee currency at write time
 * (D28/D29 `pct` → |notional| resolution), so replay uses it directly. A BUY
 * thus draws |notional| + |fee| from the account — matching the old wallet
 * debit — so a position funded by an equal deposit nets its currency to 0.
 * Non-trade types (SPLIT/ADJUSTMENT markers) → empty map.
 */
export function tradeCashEffects(tx: {
  type: string
  totalAmount: string | number | null
  feesSettled: string | number | null
  currency: string | null
  feeCurrency?: string | null
}): Map<string, number> {
  const out = new Map<string, number>()
  const notional = Number(tx.totalAmount ?? 0)
  const fee = Number(tx.feesSettled ?? 0)
  const principalSign = tx.type === "BUY" ? -1 : 1 // SELL / DIVIDEND credit
  if (notional !== 0 && tx.currency) {
    out.set(tx.currency.toUpperCase(), (out.get(tx.currency.toUpperCase()) ?? 0) + principalSign * Math.abs(notional))
  }
  if (fee !== 0) {
    const feeCcy = (tx.feeCurrency ?? tx.currency ?? "").toUpperCase()
    if (feeCcy) out.set(feeCcy, (out.get(feeCcy) ?? 0) - Math.abs(fee))
  }
  return out
}

/**
 * Per-currency cash balances of a portfolio as of `asOf` (YYYY-MM-DD; trades
 * with `executedAt ≤ asOf end-of-day`, external rows with
 * `transaction_date ≤ asOf` — no asOf = latest). Summed per currency, in each
 * currency's own units.
 */
export async function cashBalances(
  db: DB,
  authToken: string | null,
  portfolioId: string,
  asOf?: string,
): Promise<Map<string, number>> {
  const balances = new Map<string, number>()

  const tradeWhere = and(
    eq(portfolioTransactions.portfolioId, portfolioId),
    inArray(portfolioTransactions.type, [...TRADE_CASH_TYPES]),
    asOf ? sql`date(${portfolioTransactions.executedAt}) <= ${asOf}` : undefined,
  )
  const trades = await db
    .select({
      type: portfolioTransactions.type,
      totalAmount: portfolioTransactions.totalAmount,
      feesSettled: portfolioTransactions.feesSettled,
      currency: portfolioTransactions.currency,
      feeCurrency: portfolioTransactions.feeCurrency,
    })
    .from(portfolioTransactions)
    .where(tradeWhere)

  for (const tx of trades) {
    for (const [ccy, delta] of tradeCashEffects(tx)) {
      balances.set(ccy, (balances.get(ccy) ?? 0) + delta)
    }
  }

  const extWhere = and(
    eq(portfolioCashTransactions.portfolioId, portfolioId),
    asOf ? sql`${portfolioCashTransactions.transactionDate} <= ${asOf}` : undefined,
  )
  const ext = await db
    .select({ amount: portfolioCashTransactions.amount, currency: portfolioCashTransactions.currency })
    .from(portfolioCashTransactions)
    .where(extWhere)

  for (const r of ext) {
    const ccy = (r.currency ?? "").toUpperCase()
    balances.set(ccy, (balances.get(ccy) ?? 0) + Number(r.amount ?? 0))
  }

  return balances
}

/** Enumerate every calendar date in [from, to] inclusive (YYYY-MM-DD). */
function enumerateDays(from: string, to: string): string[] {
  const days: string[] = []
  const start = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10))
  }
  return days
}

/**
 * Daily base-currency cash totals across [from, to]: for each day, the
 * running per-currency balances (trade + external effects at that day's
 * close) × fx(currency → base, day). Days are carried forward, so the series
 * is contiguous within the window; FX uses the instruments' date-resolved
 * rate (weekend/holiday carry-forward, 1:1 degrade) — the same memoized
 * machinery as the old `dailyNetCashFlows`.
 */
export async function cashBalanceSeries(
  db: DB,
  authToken: string | null,
  portfolioId: string,
  from: string,
  to: string,
  baseCurrency: string,
): Promise<Map<string, number>> {
  const base = baseCurrency.toUpperCase()
  const days = enumerateDays(from, to)
  if (days.length === 0) return new Map()

  interface Event {
    day: string
    ccy: string
    delta: number
  }
  const events: Event[] = []

  const trades = await db
    .select({
      type: portfolioTransactions.type,
      totalAmount: portfolioTransactions.totalAmount,
      feesSettled: portfolioTransactions.feesSettled,
      currency: portfolioTransactions.currency,
      feeCurrency: portfolioTransactions.feeCurrency,
      executedAt: portfolioTransactions.executedAt,
    })
    .from(portfolioTransactions)
    .where(and(eq(portfolioTransactions.portfolioId, portfolioId), inArray(portfolioTransactions.type, [...TRADE_CASH_TYPES])))
    .orderBy(portfolioTransactions.executedAt)

  for (const tx of trades) {
    const day = toDateStr(tx.executedAt)
    if (!day) continue
    for (const [ccy, delta] of tradeCashEffects(tx)) events.push({ day, ccy, delta })
  }

  const ext = await db
    .select({
      amount: portfolioCashTransactions.amount,
      currency: portfolioCashTransactions.currency,
      transactionDate: portfolioCashTransactions.transactionDate,
    })
    .from(portfolioCashTransactions)
    .where(eq(portfolioCashTransactions.portfolioId, portfolioId))
    .orderBy(portfolioCashTransactions.transactionDate)

  for (const r of ext) {
    const day = toDateStr(r.transactionDate)
    if (!day || !(r.currency ?? "")) continue
    events.push({ day, ccy: (r.currency ?? "").toUpperCase(), delta: Number(r.amount ?? 0) })
  }

  // the running-balance sweep assumes events are ordered by day
  events.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))

  // running per-currency balances at each day's close
  const running = new Map<string, number>()
  const perDayBal = new Map<string, Map<string, number>>()
  let ei = 0
  for (const day of days) {
    while (ei < events.length && events[ei].day <= day) {
      const e = events[ei]
      running.set(e.ccy, (running.get(e.ccy) ?? 0) + e.delta)
      ei += 1
    }
    perDayBal.set(day, new Map(running))
  }

  const series = new Map<string, number>()
  for (const day of days) {
    const toBase = await fxToOnDay(authToken, base, day)
    let total = 0
    for (const [ccy, bal] of perDayBal.get(day) ?? new Map()) {
      total += await toBase(ccy, bal)
    }
    series.set(day, total)
  }
  return series
}

/**
 * Daily net EXTERNAL flow in base currency across [from, to] (DEPOSIT +,
 * WITHDRAWAL −, TRANSFER ± its own stored leg) at that day's rate — the D50
 * replacement for the old BUY/SELL `dailyNetCashFlows` series (trades are
 * internal cash ↔ position moves, not flows).
 */
export async function dailyExternalFlows(
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
      amount: portfolioCashTransactions.amount,
      currency: portfolioCashTransactions.currency,
      transactionDate: portfolioCashTransactions.transactionDate,
    })
    .from(portfolioCashTransactions)
    .where(eq(portfolioCashTransactions.portfolioId, portfolioId))
    .orderBy(portfolioCashTransactions.transactionDate)

  if (rows.length === 0) return new Map()

  const flows = new Map<string, number>()
  for (const r of rows) {
    const day = toDateStr(r.transactionDate)
    if (!day || day < from || day > to) continue
    const ccy = (r.currency ?? base).toUpperCase()
    const toBase = ccy === base ? 1 : ((await resolvedFxRate(authToken, ccy, base, day))?.rate ?? 1)
    flows.set(day, (flows.get(day) ?? 0) + Number(r.amount ?? 0) * toBase)
  }
  return flows
}
