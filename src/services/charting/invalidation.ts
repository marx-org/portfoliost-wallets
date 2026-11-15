import { and, eq, inArray, sql } from "drizzle-orm"
import type { DB } from "../../db/index.js"
import { chartProjectionState, portfolios } from "../../db/schema.js"
import { buildChartFacts, type BuildChartFactsOptions } from "./projection.js"

/**
 * Charting invalidation and recompute (feature #253/#254).
 *
 * Mutations mark a portfolio's projection stale (earliest affected date +
 * bumped version) so a reader can tell a rebuild is pending. Rebuilds run in
 * the existing refresh/recompute lifecycle — never on a chart read — and write
 * a fresh generation, leaving the previous one readable until the new one is
 * published.
 */

/** Mark a portfolio's charting projection stale (idempotent, coalescing). */
export async function markChartingDirty(db: DB, portfolioId: string, fromDate?: string | null): Promise<void> {
  await db
    .insert(chartProjectionState)
    .values({ portfolioId, generation: 0, version: 1, status: "stale", dirtyFrom: fromDate ?? null, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: chartProjectionState.portfolioId,
      set: {
        status: "stale",
        dirtyFrom: fromDate ?? null,
        version: sql`${chartProjectionState.version} + 1`,
        updatedAt: new Date(),
      },
    })
}

/** The next generation for a portfolio (max current + 1, or 1). */
export async function nextChartGeneration(db: DB, portfolioId: string): Promise<number> {
  const [row] = await db
    .select({ generation: chartProjectionState.generation })
    .from(chartProjectionState)
    .where(eq(chartProjectionState.portfolioId, portfolioId))
    .limit(1)
  return (row?.generation ?? 0) + 1
}

/**
 * Rebuild one portfolio's charting facts at a fresh generation. Reads the
 * current generation, builds the next, and publishes it atomically inside
 * buildChartFacts. Never runs on a chart read.
 */
export async function recomputeChartingForPortfolio(
  db: DB,
  portfolioId: string,
  authToken: string,
  opts: Omit<BuildChartFactsOptions, "generation"> = {},
): Promise<void> {
  const generation = await nextChartGeneration(db, portfolioId)
  await buildChartFacts(db, portfolioId, authToken, { ...opts, generation })
}

/**
 * Rebuild only the portfolios whose projection is marked stale (dirty). This is
 * what the scheduled refresh calls: it bounds the work to what actually changed
 * instead of re-fetching every portfolio's price history daily.
 */
export async function recomputeDirtyCharting(
  db: DB,
  authToken: string,
  opts: Omit<BuildChartFactsOptions, "generation"> = {},
): Promise<{ rebuilt: number; failed: number }> {
  const rows = await db
    .select({ id: chartProjectionState.portfolioId })
    .from(chartProjectionState)
    .where(eq(chartProjectionState.status, "stale"))
  let rebuilt = 0
  let failed = 0
  for (const p of rows) {
    try {
      await recomputeChartingForPortfolio(db, p.id, authToken, opts)
      rebuilt += 1
    } catch {
      failed += 1
    }
  }
  return { rebuilt, failed }
}

/** Rebuild every real (non-virtual) portfolio's charting facts. */
export async function recomputeAllCharting(
  db: DB,
  authToken: string,
  opts: Omit<BuildChartFactsOptions, "generation"> & { portfolioIds?: string[] } = {},
): Promise<{ rebuilt: number; failed: number }> {
  const rows = await db
    .select({ id: portfolios.id })
    .from(portfolios)
    .where(
      opts.portfolioIds && opts.portfolioIds.length > 0
        ? and(eq(portfolios.isVirtual, false), inArray(portfolios.id, opts.portfolioIds))
        : eq(portfolios.isVirtual, false),
    )
  let rebuilt = 0
  let failed = 0
  for (const p of rows) {
    try {
      await recomputeChartingForPortfolio(db, p.id, authToken, opts)
      rebuilt += 1
    } catch {
      failed += 1
    }
  }
  return { rebuilt, failed }
}