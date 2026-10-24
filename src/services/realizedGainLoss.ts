import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm"
import type { DB } from "../db/index.js"
import { portfolioTransactions, positionPortfolios, positions } from "../db/schema.js"

export function positionMembershipKey(portfolioId: string, positionId: string): string {
  return `${portfolioId}:${positionId}`
}

/**
 * Sum the ledger's stored realized amounts for each position membership.
 *
 * The portfolio component is intentional: one position can be shared between
 * portfolios, but a trade belongs to only the portfolio recorded on that row.
 * Older interactive SELLs may have no position link. Those are attributed only
 * when their portfolio, symbol, and execution time fall inside exactly one
 * position lifecycle; overlapping or incomplete lifecycles remain unattributed.
 */
export async function realizedGainLossByMembership(
  db: DB,
  userId: string,
  portfolioIds: string[],
): Promise<Map<string, number>> {
  const ids = [...new Set(portfolioIds)]
  if (ids.length === 0) return new Map()

  // Most rows have an exact position link. Aggregate those in the database so
  // every page read transfers one row per membership instead of the full sale
  // history into Node just to sum it again.
  const linkedTotals = await db
    .select({
      portfolioId: portfolioTransactions.portfolioId,
      positionId: portfolioTransactions.positionId,
      realizedGainLoss: sql<string>`sum(${portfolioTransactions.realizedGainLoss})`,
    })
    .from(portfolioTransactions)
    .where(
      and(
        eq(portfolioTransactions.userId, userId),
        inArray(portfolioTransactions.portfolioId, ids),
        inArray(portfolioTransactions.type, ["SELL", "EXPIRATION"]),
        isNotNull(portfolioTransactions.positionId),
        isNotNull(portfolioTransactions.realizedGainLoss),
      ),
    )
    .groupBy(portfolioTransactions.portfolioId, portfolioTransactions.positionId)

  const totals = new Map<string, number>()
  const add = (portfolioId: string, positionId: string, amount: string | null) => {
    if (amount == null) return
    const key = positionMembershipKey(portfolioId, positionId)
    totals.set(key, (totals.get(key) ?? 0) + Number(amount))
  }

  for (const row of linkedTotals) {
    if (row.positionId != null) add(row.portfolioId, row.positionId, row.realizedGainLoss)
  }

  // Keep the legacy attribution path, but ask for only the rows that need it.
  const unlinked = await db
    .select({
      portfolioId: portfolioTransactions.portfolioId,
      symbol: portfolioTransactions.instrumentSymbol,
      executedAt: portfolioTransactions.executedAt,
      realizedGainLoss: portfolioTransactions.realizedGainLoss,
    })
    .from(portfolioTransactions)
    .where(
      and(
        eq(portfolioTransactions.userId, userId),
        inArray(portfolioTransactions.portfolioId, ids),
        inArray(portfolioTransactions.type, ["SELL", "EXPIRATION"]),
        isNull(portfolioTransactions.positionId),
        isNotNull(portfolioTransactions.realizedGainLoss),
        isNotNull(portfolioTransactions.instrumentSymbol),
      ),
    )

  if (unlinked.length > 0) {
    const candidates = await db
      .select({
        portfolioId: positionPortfolios.portfolioId,
        positionId: positions.id,
        symbol: positions.symbol,
        isOpen: positions.isOpen,
        openedAt: positions.openedAt,
        closedAt: positions.closedAt,
      })
      .from(positions)
      .innerJoin(positionPortfolios, eq(positionPortfolios.positionId, positions.id))
      .where(
        and(
          eq(positions.userId, userId),
          inArray(positionPortfolios.portfolioId, ids),
        ),
      )

    const candidatesByPortfolioSymbol = new Map<string, typeof candidates>()
    for (const position of candidates) {
      const key = `${position.portfolioId}\u0000${position.symbol.toUpperCase()}`
      const rows = candidatesByPortfolioSymbol.get(key) ?? []
      rows.push(position)
      candidatesByPortfolioSymbol.set(key, rows)
    }

    for (const transaction of unlinked) {
      const symbol = transaction.symbol!.toUpperCase()
      const at = transaction.executedAt.getTime()
      const matching = (candidatesByPortfolioSymbol.get(`${transaction.portfolioId}\u0000${symbol}`) ?? []).filter((position) => {
        if (at < position.openedAt.getTime()) return false
        if (position.closedAt != null) return at <= position.closedAt.getTime()
        // An isOpen=false row with no closedAt has no provable lifecycle end.
        return position.isOpen
      })
      if (matching.length === 1) {
        add(transaction.portfolioId, matching[0].positionId, transaction.realizedGainLoss)
      }
    }
  }

  // Preserve the ledger's numeric(20, 8) precision; each stored amount is
  // authoritative and must not be rounded to a different cost-basis policy.
  return new Map([...totals].map(([key, value]) => [key, Math.round(value * 1e8) / 1e8]))
}
