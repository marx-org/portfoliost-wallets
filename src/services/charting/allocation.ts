import { and, eq, max } from "drizzle-orm"
import type { DB } from "../../db/index.js"
import { chartPositionDaily, positions, stockChartCategories } from "../../db/schema.js"
import { publishedFactsCondition, type PublishedGeneration } from "./queries.js"
import { STOCK_CHART_CATEGORIES } from "./categories.js"

/**
 * Dividend-stock category allocation (feature #253, sub-issue #269).
 *
 * A value-weighted breakdown of the CURRENT STOCK holdings across the fixed
 * five categories. The universe is the latest published position-day facts whose
 * position is a STOCK: cash, bonds and derivatives are excluded from both the
 * slices and the denominator, and the category label is user-edited, never
 * inferred from yield/growth. An unassigned stock falls into `not_classified`.
 *
 * A same-ticker option is a different `asset_type` and therefore never inherits
 * the equity's category. A stock held in two accounts is two attributed
 * position-days and is summed once per holding — the facts already carry the
 * per-account attribution, so no membership join can double count it.
 */

export interface StockCategorySlice {
  key: string
  value: number
}

export interface StockCategoryAllocation {
  /** Fixed-category order, zero slices omitted. */
  slices: StockCategorySlice[]
  /** Denominator: the STOCK-only total the percentages are relative to. */
  total: number
}

const CATEGORY_LABEL: Record<string, string> = {
  balanced: "Balanced",
  high_yield: "High yield",
  high_growth: "High growth",
  very_high_growth: "Very high growth",
  not_classified: "Not classified",
}

export function stockCategoryLabel(key: string): string {
  return CATEGORY_LABEL[key] ?? key
}

/** The equity identity an assignment is keyed by (symbol + instrument currency). */
function stockKey(symbol: string | null, instrumentCurrency: string | null): string {
  return `${symbol ?? ""}\u0000${instrumentCurrency ?? ""}`
}

export async function allocationByStockCategory(
  db: DB,
  userId: string,
  published: PublishedGeneration[],
): Promise<StockCategoryAllocation> {
  if (published.length === 0) return { slices: [], total: 0 }
  const scopeCondition = publishedFactsCondition(
    chartPositionDaily.portfolioId,
    chartPositionDaily.generation,
    published,
  )

  const [latest] = await db
    .select({ d: max(chartPositionDaily.day) })
    .from(chartPositionDaily)
    .where(scopeCondition)
  const latestDay = latest?.d ?? null
  if (!latestDay) return { slices: [], total: 0 }

  const rows = await db
    .select({
      symbol: positions.symbol,
      instrumentCurrency: positions.instrumentCurrency,
      value: chartPositionDaily.value,
    })
    .from(chartPositionDaily)
    .innerJoin(positions, eq(positions.id, chartPositionDaily.positionId))
    .where(
      and(
        scopeCondition,
        eq(chartPositionDaily.day, latestDay),
        eq(positions.assetType, "STOCK"),
      ),
    )
  if (rows.length === 0) return { slices: [], total: 0 }

  const assignments = await db
    .select({
      symbol: stockChartCategories.symbol,
      instrumentCurrency: stockChartCategories.instrumentCurrency,
      category: stockChartCategories.category,
    })
    .from(stockChartCategories)
    .where(eq(stockChartCategories.userId, userId))
  const categoryByStock = new Map(
    assignments.map((a) => [stockKey(a.symbol, a.instrumentCurrency), a.category]),
  )

  const totals = new Map<string, number>()
  let total = 0
  for (const r of rows) {
    const value = Number(r.value)
    if (!Number.isFinite(value)) continue
    total += value
    const key = categoryByStock.get(stockKey(r.symbol, r.instrumentCurrency)) ?? "not_classified"
    totals.set(key, (totals.get(key) ?? 0) + value)
  }

  const slices = STOCK_CHART_CATEGORIES
    .map((key) => ({ key, value: totals.get(key) ?? 0 }))
    .filter((s) => s.value !== 0)

  return { slices, total }
}