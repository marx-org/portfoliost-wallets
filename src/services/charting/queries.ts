import { and, eq, gte, inArray, lte, or, sql, type Column } from "drizzle-orm"
import type { DB } from "../../db/index.js"
import { chartPositionDaily, positionLabels } from "../../db/schema.js"

/**
 * One scoped account pinned to the generation its facts are published at.
 * `chart_projection_state` is per portfolio, so generations are NOT shared
 * across a scope: a brand-new account has generation 0 while an older one is at
 * 3. Reading the whole scope at one number (the old `min()`) silently empties
 * every account that is ahead of it — see #95.
 */
export interface PublishedGeneration {
  portfolioId: string
  generation: number
}

/**
 * Subquery of the position ids carrying any of `labelIds`. Used as an
 * `inArray` right-hand side so a position with two selected labels is matched
 * ONCE (overlapping labels intersect, not add).
 */
export function labelledPositionIds(db: DB, labelIds: string[]) {
  return db
    .select({ id: positionLabels.positionId })
    .from(positionLabels)
    .where(inArray(positionLabels.labelId, labelIds))
}

/**
 * Restrict a facts table to each scoped account's own published generation.
 * Returns `false` for an empty scope so a caller can never read generation-0
 * rows that do not exist.
 */
export function publishedFactsCondition(
  portfolioColumn: Column,
  generationColumn: Column,
  published: PublishedGeneration[],
) {
  if (published.length === 0) return sql`false`
  if (published.length === 1) {
    const p = published[0]
    return and(eq(portfolioColumn, p.portfolioId), eq(generationColumn, p.generation))
  }
  return or(...published.map((p) => and(eq(portfolioColumn, p.portfolioId), eq(generationColumn, p.generation))))
}

/**
 * One aggregated position-day point across the scoped accounts (feature #253).
 * Values are already in the fact's base currency; the projection stores facts
 * per portfolio base and the route converts comparable points to the requested
 * display currency before responding.
 */
export interface ScopedDailyPoint {
  date: string
  value: number
  remainingBasis: number
  income: number
  netFlow: number
  realizedGain: number
}

export interface ScopedDailySeries {
  generation: number
  points: ScopedDailyPoint[]
}

/**
 * Bounded read: sum the per-position daily facts for the given accounts, each at
 * its own published generation, grouped by day. Never replays trades, rebuilds
 * prices or fans out provider calls — it only reads facts that were published.
 */
export async function getScopedDailySeries(
  db: DB,
  published: PublishedGeneration[],
  from?: string | null,
  to?: string | null,
  labelIds: string[] = [],
): Promise<ScopedDailySeries> {
  if (published.length === 0) return { generation: 0, points: [] }
  const conds = [
    publishedFactsCondition(chartPositionDaily.portfolioId, chartPositionDaily.generation, published),
  ]
  if (from) conds.push(gte(chartPositionDaily.day, from))
  if (to) conds.push(lte(chartPositionDaily.day, to))
  if (labelIds.length > 0) {
    // A subquery, not a join: a position carrying two selected labels is read
    // once (overlapping labels intersect, not add).
    const labelled = db
      .select({ id: positionLabels.positionId })
      .from(positionLabels)
      .where(inArray(positionLabels.labelId, labelIds))
    conds.push(inArray(chartPositionDaily.positionId, labelled))
  }

  const rows = await db
    .select({
      day: chartPositionDaily.day,
      value: sql<string>`coalesce(sum(${chartPositionDaily.value}), 0)`,
      remainingBasis: sql<string>`coalesce(sum(${chartPositionDaily.remainingBasis}), 0)`,
      income: sql<string>`coalesce(sum(${chartPositionDaily.income}), 0)`,
      netFlow: sql<string>`coalesce(sum(${chartPositionDaily.netFlow}), 0)`,
      realizedGain: sql<string>`coalesce(sum(${chartPositionDaily.realizedGain}), 0)`,
    })
    .from(chartPositionDaily)
    .where(and(...conds))
    .groupBy(chartPositionDaily.day)
    .orderBy(chartPositionDaily.day)

  return {
    generation: Math.max(...published.map((p) => p.generation)),
    points: rows.map((r) => ({
      date: r.day,
      value: Number(r.value),
      remainingBasis: Number(r.remainingBasis),
      income: Number(r.income),
      netFlow: Number(r.netFlow),
      realizedGain: Number(r.realizedGain),
    })),
  }
}