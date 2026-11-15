import { and, eq, gte, inArray, lte } from "drizzle-orm"
import type { DB } from "../../db/index.js"
import { chartEventFacts } from "../../db/schema.js"

/**
 * Income aggregation (feature #253). One canonical input — the normalized
 * `chart_event_facts` — feeds the monthly, cumulative, annual, quarterly and
 * average income charts. Dividends, interest and options are kept separate;
 * contributions, withdrawals, transfers and trade cash effects are NOT income.
 */

export type IncomeComponent = "dividends" | "interest" | "options"

export interface IncomeBucket {
  period: string
  dividends: number
  interest: number
  options: number
  total: number
}

export interface AggregatedIncome {
  monthly: IncomeBucket[]
  quarterly: IncomeBucket[]
  annual: IncomeBucket[]
}

/** Receipt kinds that count as received income, and the component they map to. */
const INCOME_COMPONENT: Record<string, IncomeComponent> = {
  dividend: "dividends",
  interest: "interest",
  option: "options",
}

function emptyBucket(period: string): IncomeBucket {
  return { period, dividends: 0, interest: 0, options: 0, total: 0 }
}

function addTo(bucket: IncomeBucket, kind: string, amount: number): void {
  const comp = INCOME_COMPONENT[kind]
  if (!comp) return
  bucket[comp] += amount
  bucket.total += amount
}

function monthKey(date: string): string {
  return date.slice(0, 7)
}

function quarterKey(date: string): string {
  const month = Number(date.slice(5, 7))
  return `${date.slice(0, 4)}-Q${Math.floor((month - 1) / 3) + 1}`
}

function yearKey(date: string): string {
  return date.slice(0, 4)
}

function finalize(buckets: Map<string, IncomeBucket>): IncomeBucket[] {
  return [...buckets.values()]
    .map((b) => ({
      period: b.period,
      dividends: round(b.dividends),
      interest: round(b.interest),
      options: round(b.options),
      total: round(b.total),
    }))
    .sort((a, b) => a.period.localeCompare(b.period))
}

function round(n: number): number {
  return Math.round(n * 1e8) / 1e8
}

/**
 * Aggregate income facts for the given accounts/generation/window into monthly,
 * quarterly and annual buckets. Reads only the published generation's facts; it
 * never replays trades or calls providers.
 */
export async function aggregateIncome(
  db: DB,
  accountIds: string[],
  generation: number,
  from?: string | null,
  to?: string | null,
): Promise<AggregatedIncome> {
  if (accountIds.length === 0) return { monthly: [], quarterly: [], annual: [] }

  const conds = [
    eq(chartEventFacts.generation, generation),
    inArray(chartEventFacts.portfolioId, accountIds),
  ]
  if (from) conds.push(gte(chartEventFacts.eventDate, from))
  if (to) conds.push(lte(chartEventFacts.eventDate, to))

  const rows = await db
    .select({
      date: chartEventFacts.eventDate,
      receiptKind: chartEventFacts.receiptKind,
      amountBase: chartEventFacts.amountBase,
    })
    .from(chartEventFacts)
    .where(and(...conds))

  const monthly = new Map<string, IncomeBucket>()
  const quarterly = new Map<string, IncomeBucket>()
  const annual = new Map<string, IncomeBucket>()

  for (const r of rows) {
    if (!INCOME_COMPONENT[r.receiptKind]) continue
    const amount = Number(r.amountBase)
    const mk = monthKey(r.date)
    const qk = quarterKey(r.date)
    const yk = yearKey(r.date)
    if (!monthly.has(mk)) monthly.set(mk, emptyBucket(mk))
    if (!quarterly.has(qk)) quarterly.set(qk, emptyBucket(qk))
    if (!annual.has(yk)) annual.set(yk, emptyBucket(yk))
    addTo(monthly.get(mk)!, r.receiptKind, amount)
    addTo(quarterly.get(qk)!, r.receiptKind, amount)
    addTo(annual.get(yk)!, r.receiptKind, amount)
  }

  return { monthly: finalize(monthly), quarterly: finalize(quarterly), annual: finalize(annual) }
}