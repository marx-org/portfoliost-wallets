import { and, eq, gte, inArray, lte, sql } from "drizzle-orm"
import type { DB } from "../../db/index.js"
import { chartPositionDaily } from "../../db/schema.js"

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
 * Bounded read: sum the per-position daily facts for the given accounts and
 * generation, grouped by day. Never replays trades, rebuilds prices or fans out
 * provider calls — it reads one published generation's facts.
 */
export async function getScopedDailySeries(
  db: DB,
  accountIds: string[],
  generation: number,
  from?: string | null,
  to?: string | null,
): Promise<ScopedDailySeries> {
  if (accountIds.length === 0) return { generation, points: [] }
  const conds = [
    eq(chartPositionDaily.generation, generation),
    inArray(chartPositionDaily.portfolioId, accountIds),
  ]
  if (from) conds.push(gte(chartPositionDaily.day, from))
  if (to) conds.push(lte(chartPositionDaily.day, to))

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
    generation,
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