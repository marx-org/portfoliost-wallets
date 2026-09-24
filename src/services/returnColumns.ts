/**
 * Pre-computed return-type columns for value_snapshots (D46–D49).
 *
 * Called after every write to value_snapshots (backfill bulk upsert,
 * snapshot-on-read single upsert). Reads all rows for a portfolio in
 * chronological order, computes TWR / MWR (XIRR) / Simple indexed series
 * (all starting at 100), then bulk-updates the three nullable columns.
 *
 * Because this runs after the write — not on read — the analytics query is a
 * plain SELECT with zero CPU work.
 */

import { and, asc, desc, eq, sql } from "drizzle-orm"
import type { DB } from "../db/index.js"
import { portfolios, valueSnapshots } from "../db/schema.js"

// ---------------------------------------------------------------------------
// Simple return — indexed from first portfolio value
// ---------------------------------------------------------------------------
export function buildSimple(values: number[]): number[] {
  const v0 = values[0] ?? 0
  if (v0 === 0) return values.map(() => 100)
  return values.map((v) => Math.round((v / v0) * 10000) / 100)
}

// ---------------------------------------------------------------------------
// TWR — daily chain-linked sub-period returns
// HPR_t = V_t / (V_{t-1} + netFlow_t) - 1
// ---------------------------------------------------------------------------
export function buildTwr(values: number[], flows: number[]): number[] {
  if (values.length === 0) return []
  const result: number[] = [100]
  let cum = 1
  for (let i = 1; i < values.length; i++) {
    const denom = values[i - 1] + flows[i]
    const hpr = denom !== 0 ? values[i] / denom - 1 : 0
    cum *= 1 + hpr
    result.push(Math.round(cum * 10000) / 100)
  }
  return result
}

// ---------------------------------------------------------------------------
// MWR — XIRR then de-annualise per point
// ---------------------------------------------------------------------------
function daysBetween(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / 86400000
}

// §53.1 — Newton on near-zero-capital / one-sided-flow histories "converges"
// to absurd roots (|r| up to 1e10); such a rate is nonsense, and
// Math.pow(1+r, t) then overflows the cumulative_mwr numeric column.
// Rejecting it makes buildMwr take its buildSimple fallback.
const MAX_ABS_XIRR = 10

function saneRate(r: number): boolean {
  return Number.isFinite(r) && Math.abs(r) <= MAX_ABS_XIRR
}

function xirr(cfs: number[], dates: string[]): number | null {
  if (cfs.length < 2) return null
  const hasPos = cfs.some((c) => c > 0)
  const hasNeg = cfs.some((c) => c < 0)
  if (!hasPos || !hasNeg) return null
  const t0 = dates[0]
  const days = dates.map((d) => daysBetween(t0, d))
  let r = 0.1
  for (let iter = 0; iter < 100; iter++) {
    let npv = 0, dnpv = 0
    for (let i = 0; i < cfs.length; i++) {
      const t = days[i] / 365
      const f = Math.pow(1 + r, t)
      npv += cfs[i] / f
      dnpv -= (cfs[i] * t) / (f * (1 + r))
    }
    if (Math.abs(dnpv) < 1e-12) break
    const nr = r - npv / dnpv
    if (Math.abs(nr - r) < 1e-8) return saneRate(nr) ? nr : null
    r = isFinite(nr) ? Math.max(nr, -0.9999) : r * 0.5
  }
  return null
}

export function buildMwr(values: number[], flows: number[], dates: string[]): number[] {
  if (values.length === 0) return []
  // Build XIRR cash flows: -V[0] at start, -flow[i] for deposits, +V[last] at end
  const xCF: number[] = [-values[0]]
  const xDates: string[] = [dates[0]]
  for (let i = 1; i < values.length - 1; i++) {
    if (flows[i] !== 0) { xCF.push(-flows[i]); xDates.push(dates[i]) }
  }
  xCF.push(values[values.length - 1])
  xDates.push(dates[dates.length - 1])

  const rate = xirr(xCF, xDates)
  const totalDays = daysBetween(dates[0], dates[dates.length - 1])

  if (rate !== null && totalDays > 0) {
    return dates.map((d) => {
      const t = daysBetween(dates[0], d)
      return Math.round(Math.pow(1 + rate, t / 365) * 10000) / 100
    })
  }
  // Fallback to simple
  return buildSimple(values)
}

// ---------------------------------------------------------------------------
// Public: recompute all three columns for one portfolio
// ---------------------------------------------------------------------------
/**
 * §53.5 — maintain `portfolios.current_value` from the newest
 * value_snapshots row. A 1-day-old value is acceptable (user decision
 * 2026-09-23); a portfolio with no snapshots (history cleared) resets to 0.
 * Call after every value_snapshots write (backfill, recalc, snapshot-on-read).
 */
export async function syncCurrentValueFromSnapshots(db: DB, portfolioId: string): Promise<void> {
  const [latest] = await db
    .select({ value: valueSnapshots.value })
    .from(valueSnapshots)
    .where(eq(valueSnapshots.portfolioId, portfolioId))
    .orderBy(desc(valueSnapshots.snapshotDate))
    .limit(1)
  await db
    .update(portfolios)
    .set({ currentValue: latest ? latest.value : "0" })
    .where(eq(portfolios.id, portfolioId))
}

export async function recomputeReturnColumns(db: DB, portfolioId: string): Promise<void> {
  const rows = await db
    .select({
      snapshotDate: valueSnapshots.snapshotDate,
      value: valueSnapshots.value,
      netFlow: valueSnapshots.netFlow,
    })
    .from(valueSnapshots)
    .where(eq(valueSnapshots.portfolioId, portfolioId))
    .orderBy(asc(valueSnapshots.snapshotDate))

  if (rows.length === 0) return

  const dates = rows.map((r) => r.snapshotDate)
  const values = rows.map((r) => Number(r.value))
  const flows = rows.map((r) => Number(r.netFlow))

  const simple = buildSimple(values)
  const twr = buildTwr(values, flows)
  const mwr = buildMwr(values, flows, dates)

  // Bulk update in chunks to avoid huge parameter lists
  const CHUNK = 100
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK)
    await Promise.all(
      chunk.map((r, j) => {
        const idx = i + j
        return db
          .update(valueSnapshots)
          .set({
            cumulativeSimple: String(simple[idx]),
            cumulativeTwr: String(twr[idx]),
            cumulativeMwr: String(mwr[idx]),
          })
          .where(
            and(
              eq(valueSnapshots.portfolioId, portfolioId),
              eq(valueSnapshots.snapshotDate, r.snapshotDate),
            ),
          )
      }),
    )
  }
}
