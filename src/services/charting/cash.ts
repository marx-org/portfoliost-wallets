import type { DB } from "../../db/index.js"
import type { PublishedGeneration } from "./queries.js"
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
  const from = opts.from ?? yearsAgo(5, now)
  const to = opts.to ?? now.toISOString().slice(0, 10)

  const series: CashBalanceSeries[] = []
  const totalByDate = new Map<string, number>()

  for (const p of published) {
    const balances = await cashBalanceSeries(db, opts.authToken, p.portfolioId, from, to, currency)
    const points = [...balances.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([date, balance]) => ({ date, balance }))
    series.push({ key: p.portfolioId, label: p.portfolioId, points })
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