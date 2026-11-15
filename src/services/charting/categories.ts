import { and, asc, eq, inArray } from "drizzle-orm"
import type { DB } from "../../db/index.js"
import { positionLabels, positionPortfolios, positions, stockChartCategories } from "../../db/schema.js"

/**
 * Fixed stock categories for the Charting stock-category chart (feature #253,
 * sub-issue #258).
 *
 * One assignment per (owner, STOCK symbol, instrument currency) across all lots
 * and accounts. Options and other asset types are excluded from the holdable
 * surface, so a same-ticker option contract never inherits an equity's category.
 * Absence of an assignment means `not_classified`; there is no automatic
 * yield/growth classifier.
 */

export const STOCK_CHART_CATEGORIES = [
  "balanced",
  "high_yield",
  "high_growth",
  "very_high_growth",
  "not_classified",
] as const

export type StockChartCategory = (typeof STOCK_CHART_CATEGORIES)[number]

export function isStockChartCategory(value: unknown): value is StockChartCategory {
  return typeof value === "string" && (STOCK_CHART_CATEGORIES as readonly string[]).includes(value)
}

export interface StockCategoryAssignment {
  symbol: string
  instrumentCurrency: string
  /** Display name when a held position carries one; null otherwise. */
  name: string | null
  category: StockChartCategory
  updatedAt: Date
}

export interface HoldableStock {
  symbol: string
  instrumentCurrency: string
  name: string | null
}

function assignment(row: {
  symbol: string
  instrumentCurrency: string
  category: string
  updatedAt: Date
}): StockCategoryAssignment {
  return {
    symbol: row.symbol,
    instrumentCurrency: row.instrumentCurrency,
    name: null,
    category: row.category as StockChartCategory,
    updatedAt: row.updatedAt,
  }
}

/** Every assignment the caller owns, ordered by symbol then currency. */
export async function listStockCategories(db: DB, userId: string): Promise<StockCategoryAssignment[]> {
  const rows = await db
    .select({
      symbol: stockChartCategories.symbol,
      instrumentCurrency: stockChartCategories.instrumentCurrency,
      category: stockChartCategories.category,
      updatedAt: stockChartCategories.updatedAt,
    })
    .from(stockChartCategories)
    .where(eq(stockChartCategories.userId, userId))
    .orderBy(asc(stockChartCategories.symbol), asc(stockChartCategories.instrumentCurrency))
  return rows.map(assignment)
}

/**
 * The distinct STOCK instruments the caller holds, optionally narrowed to a set
 * of accounts and/or position labels. This is the assignment surface: a
 * same-ticker OPTION is excluded, so it cannot be classified as the equity.
 */
export async function listHoldableStocks(
  db: DB,
  userId: string,
  opts?: { accountIds?: string[]; labelIds?: string[] },
): Promise<HoldableStock[]> {
  const conds = [eq(positions.userId, userId), eq(positions.assetType, "STOCK")]
  if (opts?.accountIds?.length) {
    const owned = db
      .select({ id: positionPortfolios.positionId })
      .from(positionPortfolios)
      .where(inArray(positionPortfolios.portfolioId, opts.accountIds))
    conds.push(inArray(positions.id, owned))
  }
  if (opts?.labelIds?.length) {
    const labelled = db
      .select({ id: positionLabels.positionId })
      .from(positionLabels)
      .where(inArray(positionLabels.labelId, opts.labelIds))
    conds.push(inArray(positions.id, labelled))
  }
  const rows = await db
    .selectDistinct({
      symbol: positions.symbol,
      instrumentCurrency: positions.instrumentCurrency,
      name: positions.companyName,
    })
    .from(positions)
    .where(and(...conds))
  return rows
    .map((r) => ({ symbol: r.symbol, instrumentCurrency: r.instrumentCurrency, name: r.name }))
    .sort((a, b) => a.symbol.localeCompare(b.symbol) || a.instrumentCurrency.localeCompare(b.instrumentCurrency))
}

/**
 * Create or update one assignment. The unique (owner, symbol, currency) key
 * means a second account holding the same stock edits the same row, and an
 * invalid category is rejected by the caller before this runs.
 */
export async function upsertStockCategory(
  db: DB,
  userId: string,
  input: { symbol: string; instrumentCurrency: string; category: StockChartCategory },
): Promise<StockCategoryAssignment> {
  const now = new Date()
  const [row] = await db
    .insert(stockChartCategories)
    .values({
      userId,
      symbol: input.symbol,
      instrumentCurrency: input.instrumentCurrency,
      category: input.category,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [stockChartCategories.userId, stockChartCategories.symbol, stockChartCategories.instrumentCurrency],
      set: { category: input.category, updatedAt: now },
    })
    .returning({
      symbol: stockChartCategories.symbol,
      instrumentCurrency: stockChartCategories.instrumentCurrency,
      category: stockChartCategories.category,
      updatedAt: stockChartCategories.updatedAt,
    })
  return assignment(row)
}