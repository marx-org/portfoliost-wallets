import type { DB } from "../../db/index.js"
import { and, eq, gte, inArray, lte, or, sql } from "drizzle-orm"
import {
  chartEventFacts,
  portfolioCashTransactionLabels,
  portfolioTransactions,
  portfolios,
  positionLabels,
} from "../../db/schema.js"
import type { PublishedGeneration } from "./queries.js"
import { publishedFactsCondition } from "./queries.js"
import { cashBalanceSeries } from "../cashLedger.js"

/**
 * Cash balance history for the scoped accounts (feature #253, sub-issue #276).
 *
 * One line per selected real broker account from the canonical `cashLedger`
 * replay, plus a combined total (each real account counted once, so internal
 * transfers cancel). Balances are converted into the display currency. The
 * series includes the opening balance before a selected window, because the
 * ledger replay accumulates all prior events and only reports [from, to].
 * Negative cash is retained.
 *
 * This reads the ledger, not a provider; it is the same cashLedger semantics the
 * rest of wallets uses, with no sheet snapshot import.
 */

export interface CashBalancePoint {
  date: string
  balance: number
}

export interface CashBalanceSeries {
  /** Account id, or the combined-total key. */
  key: string
  label: string
  points: CashBalancePoint[]
}

export interface ScopedCashHistory {
  series: CashBalanceSeries[]
  /** Combined total across the selected real accounts. */
  total: CashBalancePoint[]
  currency: string
}

const TOTAL_KEY = "__total__"

function yearsAgo(n: number, now = new Date()): string {
  const d = new Date(now)
  d.setUTCFullYear(d.getUTCFullYear() - n)
  return d.toISOString().slice(0, 10)
}

export async function cashBalanceSeriesForScope(
  db: DB,
  published: PublishedGeneration[],
  opts: {
    from?: string | null
    to?: string | null
    displayCurrency: string
    authToken: string | null
  },
): Promise<ScopedCashHistory> {
  const currency = opts.displayCurrency
  if (published.length === 0) return { series: [], total: [], currency }

  const now = new Date()
  // One year by default: the ledger series is daily, and a 5-year All-scope
  // fan-out (10 accounts × ~1800 days × per-day FX) is too slow for a chart
  // read. Callers widen it with from/to.
  const from = opts.from ?? yearsAgo(1, now)
  const to = opts.to ?? now.toISOString().slice(0, 10)

  const names = await db
    .select({ id: portfolios.id, name: portfolios.name })
    .from(portfolios)
    .where(inArray(portfolios.id, published.map((p) => p.portfolioId)))
  const nameById = new Map(names.map((n) => [n.id, n.name]))

  const series: CashBalanceSeries[] = []
  const totalByDate = new Map<string, number>()

  for (const p of published) {
    const balances = await cashBalanceSeries(db, opts.authToken, p.portfolioId, from, to, currency)
    const points = [...balances.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([date, balance]) => ({ date, balance }))
    series.push({ key: p.portfolioId, label: nameById.get(p.portfolioId) ?? p.portfolioId, points })
    for (const [date, balance] of balances) {
      totalByDate.set(date, (totalByDate.get(date) ?? 0) + balance)
    }
  }

  const total = [...totalByDate.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, balance]) => ({ date, balance }))

  // Append the combined total as the last line (each account once; internal
    // transfers cancel).
  series.push({ key: TOTAL_KEY, label: "Total", points: total })

  return { series, total, currency }
}
/**
 * One calendar year of signed external owner funding for the scoped accounts
 * (feature #253, sub-issue #277).
 *
 * `contributions` are owner deposits and `withdrawals` their positive
 * magnitude; `net` is deposits minus withdrawals. Ordinary BUY/SELL turnover is
 * absent because the projection emits trade cash effects as `trade`, not as
 * funding. `transfers` carries signed cash/in-kind transfer legs separately:
 * internal pairs cancel across a whole-scope selection, while a transfer that
 * crosses the selected account boundary remains visible here rather than being
 * presented as an owner deposit or withdrawal.
 */
export interface AnnualContributionPoint {
  year: number
  contributions: number
  withdrawals: number
  net: number
  transfers: number
  /** The calendar year is still in progress, so its total is not a full year. */
  partial: boolean
  /** A source amount could not be converted; the totals are a partial sum. */
  unknown: boolean
}

export interface AnnualContributionsOptions {
  /** Convert an account-base amount into the display currency, or null if unknown. */
  convert: (from: string, amount: number) => Promise<number | null>
  /** Selected position/cash labels. Empty = All. */
  labelIds?: string[]
  /** Inclusive fact window; omitted = all published facts. */
  from?: string | null
  to?: string | null
  /** Injectable clock for deterministic partial-year tests. */
  now?: Date
}

function roundAmount(n: number): number {
  return Math.round(n * 1e8) / 1e8
}

/**
 * Aggregate published funding facts into calendar years. This is a bounded read
 * of `chart_event_facts`; it never replays trades, rebuilds prices or calls a
 * provider. Each amount is converted from its own portfolio base currency into
 * the requested display currency before it is summed.
 */
export async function annualContributions(
  db: DB,
  published: PublishedGeneration[],
  opts: AnnualContributionsOptions,
): Promise<AnnualContributionPoint[]> {
  if (published.length === 0) return []

  const labelIds = opts.labelIds ?? []
  const conds = [
    publishedFactsCondition(chartEventFacts.portfolioId, chartEventFacts.generation, published),
    inArray(chartEventFacts.receiptKind, ["contribution", "withdrawal", "transfer"]),
  ]
  if (opts.from) conds.push(gte(chartEventFacts.eventDate, opts.from))
  if (opts.to) conds.push(lte(chartEventFacts.eventDate, opts.to))
  if (labelIds.length > 0) {
    // Standalone cash events use their own cash-transaction labels. Linked cash
    // effects follow the selected investment. A subquery (not a join) keeps an
    // event with two selected labels counted once.
    const labelledPositions = db
      .select({ id: positionLabels.positionId })
      .from(positionLabels)
      .where(inArray(positionLabels.labelId, labelIds))
    const labelledCash = db
      .select({ id: portfolioCashTransactionLabels.cashTransactionId })
      .from(portfolioCashTransactionLabels)
      .where(inArray(portfolioCashTransactionLabels.labelId, labelIds))
    conds.push(
      or(
        inArray(chartEventFacts.positionId, labelledPositions),
        inArray(chartEventFacts.linkedPositionId, labelledPositions),
        inArray(chartEventFacts.sourceCashTransactionId, labelledCash),
      ),
    )
  }

  const rows = await db
    .select({
      year: sql<string>`extract(year from ${chartEventFacts.eventDate})`,
      kind: chartEventFacts.receiptKind,
      amount: chartEventFacts.amountBase,
      baseCurrency: portfolios.baseCurrency,
      sourceTransactionId: chartEventFacts.sourceTransactionId,
      sourceCashTransactionId: chartEventFacts.sourceCashTransactionId,
      sourceTransactionType: portfolioTransactions.type,
    })
    .from(chartEventFacts)
    .innerJoin(portfolios, eq(portfolios.id, chartEventFacts.portfolioId))
    .leftJoin(portfolioTransactions, eq(portfolioTransactions.id, chartEventFacts.sourceTransactionId))
    .where(and(...conds))

  const annual = new Map<number, { contributions: number; withdrawals: number; transfers: number; unknown: boolean }>()
  for (const r of rows) {
    const amount = Number(r.amount)
    if (!Number.isFinite(amount)) continue
    const converted = await opts.convert(r.baseCurrency || "", Math.abs(amount))
    if (converted == null || !Number.isFinite(converted)) {
      const y = Number(r.year)
      const cur = annual.get(y) ?? { contributions: 0, withdrawals: 0, transfers: 0, unknown: false }
      cur.unknown = true
      annual.set(y, cur)
      continue
    }
    const y = Number(r.year)
    const cur = annual.get(y) ?? { contributions: 0, withdrawals: 0, transfers: 0, unknown: false }
    if (r.kind === "contribution") cur.contributions += converted
    else if (r.kind === "withdrawal") cur.withdrawals += converted
    else if (r.kind === "transfer") {
      // Cash transfer legs carry their own sign. In-kind legs are stored as
      // positive cost-basis amounts, so the source transaction type supplies
      // the direction: TRANSFER_OUT leaves the scope, TRANSFER_IN enters it.
      let signed = amount
      if (r.sourceCashTransactionId == null && r.sourceTransactionId != null) {
        if (r.sourceTransactionType === "TRANSFER_OUT") signed = -amount
        else if (r.sourceTransactionType === "TRANSFER_IN") signed = amount
      }
      cur.transfers += signed < 0 ? -converted : converted
    }
    annual.set(y, cur)
  }

  const currentYear = (opts.now ?? new Date()).getUTCFullYear()
  return [...annual]
    .sort((a, b) => a[0] - b[0])
    .map(([year, v]) => ({
      year,
      contributions: roundAmount(v.contributions),
      withdrawals: roundAmount(v.withdrawals),
      net: roundAmount(v.contributions - v.withdrawals),
      transfers: roundAmount(v.transfers),
      partial: year === currentYear,
      unknown: v.unknown,
    }))
}
