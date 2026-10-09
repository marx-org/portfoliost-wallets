import { sql } from "drizzle-orm"
import { positionPortfolios, positions } from "./schema.js"

/**
 * SQL predicate: the position belongs to the given portfolio through the
 * many-to-many `position_portfolios` membership (#115).
 *
 * Replaces the former `positions.portfolio_id` equality wherever a query
 * filtered positions by portfolio. It reads ownership from the relationship
 * table and is used as a WHERE predicate (rather than a join) so a query that
 * selects whole `positions` rows keeps returning a flat row shape.
 */
export function positionInPortfolio(portfolioId: string) {
  return sql`exists (select 1 from ${positionPortfolios} where ${positionPortfolios.positionId} = ${positions.id} and ${positionPortfolios.portfolioId} = ${portfolioId})`
}
