import { and, eq, gte, inArray, lt, lte } from "drizzle-orm"
import type { DB } from "../../db/index.js"
import { chartEventFacts, positionLabels } from "../../db/schema.js"

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
  labelIds: string[] = [],
): Promise<AggregatedIncome> {
  if (accountIds.length === 0) return { monthly: [], quarterly: [], annual: [] }

  const conds = [
    eq(chartEventFacts.generation, generation),
    inArray(chartEventFacts.portfolioId, accountIds),
  ]
  if (from) conds.push(gte(chartEventFacts.eventDate, from))
  if (to) conds.push(lte(chartEventFacts.eventDate, to))
  if (labelIds.length) {
    // A subquery, not a join: an event whose position carries two selected
    // labels must be counted ONCE (overlapping labels intersect, not add).
    const labelled = db
      .select({ id: positionLabels.positionId })
      .from(positionLabels)
      .where(inArray(positionLabels.labelId, labelIds))
    conds.push(inArray(chartEventFacts.positionId, labelled))
  }

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
/**
 * One month of received income with a partial flag (feature #253, sub-issue
 * #257). A month is partial when it is the current (or a future) calendar month
 * relative to `now`, so a trend and any current-month total are marked as such.
 */
export interface MonthlyIncomePoint {
  period: string
  dividends: number
  interest: number
  options: number
  total: number
  partial: boolean
}

export function monthlyIncomeSeries(agg: AggregatedIncome, now: Date = new Date()): MonthlyIncomePoint[] {
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`
  if (agg.monthly.length === 0) return []

  // Fill gaps between the first and last receipt month with TRUE zero months, so
  // a trend line and the current-month total see them (a month with no receipts
  // is zero, not absent). Months outside the observed window are not invented.
  const byPeriod = new Map(agg.monthly.map((b) => [b.period, b]))
  const first = agg.monthly[0].period
  const last = agg.monthly[agg.monthly.length - 1].period
  const points: MonthlyIncomePoint[] = []
  for (let p = first; p <= last; p = nextMonth(p)) {
    const b = byPeriod.get(p)
    points.push({
      period: p,
      dividends: b?.dividends ?? 0,
      interest: b?.interest ?? 0,
      options: b?.options ?? 0,
      total: b?.total ?? 0,
      // Current and future months are incomplete.
      partial: p >= currentMonth,
    })
  }
  return points
}

function nextMonth(period: string): string {
  const y = Number(period.slice(0, 4))
  const m = Number(period.slice(5, 7))
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`
}

export interface Trend {
  slope: number
  intercept: number
}

/**
 * Least-squares linear trend over the COMPLETE (non-partial) points, used for
 * the dividends+interest trend line. Returns null when there are fewer than two
 * complete points (undefined, never a fabricated zero slope).
 */
export function linearTrend(points: { period: string; value: number; partial?: boolean }[]): Trend | null {
  const pts = points.filter((p) => !p.partial)
  if (pts.length < 2) return null
  const n = pts.length
  let sx = 0
  let sy = 0
  let sxx = 0
  let sxy = 0
  for (let i = 0; i < n; i++) {
    const x = i
    const y = pts[i].value
    sx += x
    sy += y
    sxx += x * x
    sxy += x * y
  }
  const denom = n * sxx - sx * sx
  if (denom === 0) return null
  const slope = (n * sxy - sx * sy) / denom
  const intercept = (sy - slope * sx) / n
  return { slope, intercept }
}

/**
 * One point of the cumulative dividends+interest curve (feature #253, sub-issue
 * #259). `dividends` and `interest` are CUMULATIVE from the start of time;
 * `total = openingBalance + dividends + interest`. Options are excluded from
 * this curve (they remain in the valuation and the monthly options series).
 * `openingBalance` is the lifetime cumulative at the first visible point, so a
 * narrow date window still shows the true cumulative, not the in-window sum.
 */
export interface CumulativeIncomePoint {
  /** First day of the month this cumulative point closes. */
  date: string
  dividends: number
  interest: number
  options: number
  total: number
  openingBalance: number
}

/** Dividends + interest received strictly before `before` (the window opening). */
async function incomeBefore(
  db: DB,
  accountIds: string[],
  generation: number,
  before: string,
  labelIds: string[],
): Promise<number> {
  if (accountIds.length === 0) return 0
  const conds = [
    eq(chartEventFacts.generation, generation),
    inArray(chartEventFacts.portfolioId, accountIds),
    lt(chartEventFacts.eventDate, before),
  ]
  if (labelIds.length) {
    const labelled = db
      .select({ id: positionLabels.positionId })
      .from(positionLabels)
      .where(inArray(positionLabels.labelId, labelIds))
    conds.push(inArray(chartEventFacts.positionId, labelled))
  }
  const rows = await db
    .select({ kind: chartEventFacts.receiptKind, amount: chartEventFacts.amountBase })
    .from(chartEventFacts)
    .where(and(...conds))
  let sum = 0
  for (const r of rows) {
    const comp = INCOME_COMPONENT[r.kind]
    if (comp && comp !== "options") sum += Number(r.amount)
  }
  return round(sum)
}

/**
 * Cumulative dividends+interest over `monthly` (the in-window buckets), opening
 * with the lifetime pre-window total. A zero-receipt month is flat by
 * construction, because the running sum only moves when a bucket does.
 */
export async function cumulativeIncomeSeries(
  db: DB,
  accountIds: string[],
  generation: number,
  monthly: IncomeBucket[],
  opts?: { from?: string | null; labelIds?: string[] },
): Promise<CumulativeIncomePoint[]> {
  const opening = opts?.from ? await incomeBefore(db, accountIds, generation, opts.from, opts.labelIds ?? []) : 0
  let dividends = 0
  let interest = 0
  return monthly.map((b) => {
    dividends += b.dividends
    interest += b.interest
    return {
      date: `${b.period}-01`,
      dividends: round(dividends),
      interest: round(interest),
      options: 0,
      total: round(opening + dividends + interest),
      openingBalance: round(opening),
    }
  })
}
