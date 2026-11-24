/**
 * Realized and unrealized P/L for the analytics payloads.
 *
 * The card shows both as point-in-time figures (not windowed): unrealized is
 * the sum of open positions' unrealized gain/loss, realized is the sum of
 * SELL rows' realized gain/loss. Both are summed raw, matching the existing
 * summary-metrics behaviour (the card converts the total from the base
 * currency).
 */

import { and, eq, or } from "drizzle-orm"
import type { DB } from "../db/index.js"
import { positions, portfolioTransactions } from "../db/schema.js"
import { positionInPortfolio, transactionInPortfolio } from "../db/position-membership.js"

function inPortfolios(ids: string[]) {
  return or(...ids.map((id) => positionInPortfolio(id)))
}
function txInPortfolios(ids: string[]) {
  return or(...ids.map((id) => transactionInPortfolio(id)))
}

/** Σ unrealized gain/loss across open positions in the portfolios. */
export async function unrealizedGains(db: DB, userId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  const rows = await db
    .select({ u: positions.unrealizedGainLoss })
    .from(positions)
    .where(and(eq(positions.userId, userId), inPortfolios(ids), eq(positions.isOpen, true)))
  return rows.reduce((s, r) => s + (r.u != null ? Number(r.u) : 0), 0)
}

/** Σ realized gain/loss across SELL transactions in the portfolios. */
export async function realizedGains(db: DB, userId: string, ids: string[]): Promise<number> {
  if (ids.length === 0) return 0
  const rows = await db
    .select({ g: portfolioTransactions.realizedGainLoss })
    .from(portfolioTransactions)
    .where(
      and(
        eq(portfolioTransactions.userId, userId),
        txInPortfolios(ids),
        eq(portfolioTransactions.type, "SELL"),
      ),
    )
  return rows.reduce((s, r) => s + (r.g != null ? Number(r.g) : 0), 0)
}