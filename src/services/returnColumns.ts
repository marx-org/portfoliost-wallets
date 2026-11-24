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
 *
 * The pure return math lives in `src/returns/` (the single engine); this module
 * re-exports it for the many existing importers and adds the DB-bound
 * recompute/sync functions that cannot move.
 */

import { and, asc, desc, eq } from "drizzle-orm"
import type { DB } from "../db/index.js"
import { portfolios, valueSnapshots } from "../db/schema.js"
import { buildSimple, buildTwr, buildMwr } from "../returns/index.js"

// Re-export the engine so existing importers (`mergedAnalytics`, `backfill`,
// `charting/performance`, `routes/portfolios`, `riskMetrics`) keep working.
export {
  buildSimple,
  buildDailyReturns,
  chainReturns,
  buildTwr,
  buildMwr,
  moneyWeightedRate,
  xirr,
  daysBetween,
  buildMonthlyReturns,
} from "../returns/index.js"

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