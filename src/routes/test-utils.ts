import type { Hono } from "hono"
import { and, eq } from "drizzle-orm"
import { createTestDb } from "../db/test-db.js"
import { positions, positionPortfolios } from "../db/schema.js"
import { positionInPortfolio } from "../db/position-membership.js"
import type { DB } from "../db/index.js"

export interface Harness {
  db: DB
  app: Hono
  headers: Record<string, string>
  /** Identity used for X-User-* fallback auth; change + reuse `headers`. */
  user: { id: string; email: string }
}

/** Compose-style harness: isolated PGlite db + X-User-* identity headers. */
export async function makeHarness(userId = "user-1"): Promise<Harness> {
  const { db } = await createTestDb()
  return {
    db,
    headers: { "X-User-Id": userId, "X-User-Email": `${userId}@test.dev` },
    user: { id: userId, email: `${userId}@test.dev` },
  } as never
}

/**
 * §70 — seed `market_value` on a portfolio's open positions.
 *
 * Positions are inserted WITHOUT a market value (the BUY path never sets it, and
 * only `refreshQuotes` ever does), so a freshly seeded position is UNPRICED. The
 * aggregate paths used to paper over that by valuing it at `quantity ×
 * average_cost_basis` — reporting cost as market value — and a lot of tests were
 * passing only because of that lie. Tests that assert a portfolio is worth
 * something must therefore state its price explicitly.
 *
 * @param pricePerUnit the resolved market price, in the position's own currency
 */
export async function priceOpenPositions(
  db: DB,
  portfolioId: string,
  pricePerUnit: number | ((p: { quantity: string; averageCostBasis: string }) => number),
): Promise<void> {
  const open = await db
    .select({ id: positions.id, quantity: positions.quantity, averageCostBasis: positions.averageCostBasis })
    .from(positions)
    .where(and(positionInPortfolio(portfolioId), eq(positions.isOpen, true)))
  for (const p of open) {
    const price = typeof pricePerUnit === "function" ? pricePerUnit(p) : pricePerUnit
    await db
      .update(positions)
      .set({ marketValue: String(price * Number(p.quantity)) })
      .where(eq(positions.id, p.id))
  }
}

export type PositionInsert = typeof positions.$inferInsert

/**
 * #115 — insert positions and their portfolio membership in one step.
 *
 * `positions` no longer carries `portfolio_id`; ownership lives in the
 * `position_portfolios` join row. Tests keep passing `portfolioId` in the
 * values for readability — it is extracted here and written to the join table,
 * so the seeded data still belongs to the intended portfolio.
 */
export async function insertPositions(
  db: DB,
  rows: Array<PositionInsert & { portfolioId?: string }>,
): Promise<Array<typeof positions.$inferSelect>> {
  const inserted: Array<typeof positions.$inferSelect> = []
  for (const { portfolioId, ...values } of rows) {
    const [row] = await db.insert(positions).values(values).returning()
    if (portfolioId) {
      await db.insert(positionPortfolios).values({ positionId: row.id, portfolioId })
    }
    inserted.push(row)
  }
  return inserted
}

/** #115 — singular form of {@link insertPositions}. */
export async function insertPosition(
  db: DB,
  row: PositionInsert & { portfolioId?: string },
): Promise<typeof positions.$inferSelect> {
  const [created] = await insertPositions(db, [row])
  return created
}

