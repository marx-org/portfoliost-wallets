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
 * Portfolios whose facts must be built by the next refresh pass:
 *  - never projected (no `chart_projection_state` row at all, or generation 0),
 *  - or marked dirty by a transaction/cash/import mutation.
 *
 * The first case is the bootstrap: the schema and the invalidation hooks landed
 * while portfolios already existed, so nothing gave them a row and the daily
 * pass — which selected only `status = 'stale'` — had nothing to rebuild. That
 * is why every Charting chart read generation 0 in production while Compose,
 * whose seed publishes a generation by hand, looked fine.
 *
 * Virtual portfolios are label views over real accounts: their facts come from
 * the underlying accounts, so they are never projected on their own.
 */
export async function portfoliosNeedingChartingRebuild(db: DB): Promise<string[]> {
  const rows = await db
    .select({ id: portfolios.id })
    .from(portfolios)
    .leftJoin(chartProjectionState, eq(chartProjectionState.portfolioId, portfolios.id))
    .where(
      and(
        eq(portfolios.isVirtual, false),
        sql`${chartProjectionState.generation} is null
          or ${chartProjectionState.generation} = 0
          or ${chartProjectionState.status} <> 'complete'`,
      ),
    )
  return rows.map((r) => r.id)
}

/**
 * Rebuild every portfolio that needs it: never-projected portfolios are
 * bootstrapped, dirty ones are republished at a fresh generation. This is what
 * the scheduled refresh calls, so the work is bounded to what actually changed
 * instead of re-fetching every portfolio's price history daily.
 */
export async function recomputeDirtyCharting(
  db: DB,
  authToken: string,
  opts: Omit<BuildChartFactsOptions, "generation"> = {},
): Promise<{ rebuilt: number; failed: number }> {
  const ids = await portfoliosNeedingChartingRebuild(db)
  let rebuilt = 0
  let failed = 0
  for (const portfolioId of ids) {
    try {
      await recomputeChartingForPortfolio(db, portfolioId, authToken, opts)
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