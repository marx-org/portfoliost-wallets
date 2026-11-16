import { and, eq, inArray, max } from "drizzle-orm"
import type { DB } from "../../db/index.js"
import { chartPositionDaily, labels, positions, positionLabels, stockChartCategories } from "../../db/schema.js"
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

/**
 * Remaining cost basis versus current market value per position label (feature
 * #253, sub-issue #270).
 *
 * The sheet grouped holdings by hardcoded strategy flags (growth / dividend /
 * bonds / funds / crypto); this groups by the user's own labels instead and
 * keeps the same shared account/label scope. Each label is an INDEPENDENT group:
 * a holding carrying two labels contributes its full basis and value to both, so
 * the rows are not a partition and their sum is not a portfolio total. A
 * position with no label is shown under `Unlabelled` only when the caller asked
 * for All labels — it is a display bucket, never a fabricated persistent label.
 *
 * Both numbers come from the same published position-day fact, so they are
 * already in that account's base currency (never a mix of basis and value in
 * different currencies). Facts are read once at each account's published
 * generation; nothing here replays trades or rebuilds prices.
 */

export const UNLABELLED_KEY = "__unlabelled__"
export const UNLABELLED_LABEL = "Unlabelled"

export interface LabelCostValue {
  /** Label id, or `UNLABELLED_KEY` for the display-only unlabelled bucket. */
  key: string
  label: string
  /** Remaining cost basis in the dataset currency. */
  costBasis: number
  /** Current market value in the dataset currency. */
  value: number
}

export interface LabelCostValueAllocation {
  groups: LabelCostValue[]
}

export interface LabelCostValueOptions {
  /** No label filter supplied: include labelled groups plus an Unlabelled bucket. */
  allLabels: boolean
  /** Selected label ids, combined with OR; ignored when `allLabels`. */
  labelIds: string[]
}

function round8(n: number): number {
  return Math.round(n * 1e8) / 1e8
}

export async function costAndValueByLabel(
  db: DB,
  userId: string,
  published: PublishedGeneration[],
  opts: LabelCostValueOptions,
): Promise<LabelCostValueAllocation> {
  if (published.length === 0) return { groups: [] }
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
  if (!latestDay) return { groups: [] }

  // Owned label names. A foreign or stale id simply has no name here and is
  // dropped, the same ownership rule the rest of the charting scope applies.
  const labelRows = await db
    .select({ id: labels.id, name: labels.name })
    .from(labels)
    .where(eq(labels.userId, userId))
  const nameById = new Map(labelRows.map((l) => [l.id, l.name]))
  const selectedLabelIds = opts.labelIds.filter((id) => nameById.has(id))

  const conds = [scopeCondition, eq(chartPositionDaily.day, latestDay)]
  if (selectedLabelIds.length > 0) {
    // A subquery, not a join: a position carrying two selected labels must be
    // read ONCE (overlapping labels intersect, not add).
    const labelled = db
      .select({ id: positionLabels.positionId })
      .from(positionLabels)
      .where(inArray(positionLabels.labelId, selectedLabelIds))
    conds.push(inArray(chartPositionDaily.positionId, labelled))
  }

  const rows = await db
    .select({
      positionId: chartPositionDaily.positionId,
      value: chartPositionDaily.value,
      remainingBasis: chartPositionDaily.remainingBasis,
    })
    .from(chartPositionDaily)
    .where(and(...conds))
  if (rows.length === 0) return { groups: [] }

  const positionIds = [...new Set(rows.map((r) => r.positionId))]
  const membershipRows = await db
    .select({ positionId: positionLabels.positionId, labelId: positionLabels.labelId })
    .from(positionLabels)
    .where(
      selectedLabelIds.length > 0
        ? and(inArray(positionLabels.positionId, positionIds), inArray(positionLabels.labelId, selectedLabelIds))
        : inArray(positionLabels.positionId, positionIds),
    )
  const labelsByPosition = new Map<string, string[]>()
  for (const m of membershipRows) {
    const list = labelsByPosition.get(m.positionId) ?? []
    list.push(m.labelId)
    labelsByPosition.set(m.positionId, list)
  }

  const groups = new Map<string, LabelCostValue>()
  const addTo = (key: string, label: string, value: number, basis: number): void => {
    const cur = groups.get(key) ?? { key, label, costBasis: 0, value: 0 }
    cur.value += value
    cur.costBasis += basis
    groups.set(key, cur)
  }

  const selectedSet = new Set(selectedLabelIds)
  for (const r of rows) {
    const value = Number(r.value)
    const basis = Number(r.remainingBasis)
    if (!Number.isFinite(value) || !Number.isFinite(basis)) continue
    const positionLabelsForRow = labelsByPosition.get(r.positionId) ?? []
    if (positionLabelsForRow.length === 0) {
      // No label on this holding. Only All shows the display-only bucket.
      if (opts.allLabels) addTo(UNLABELLED_KEY, UNLABELLED_LABEL, value, basis)
      continue
    }
    for (const labelId of positionLabelsForRow) {
      if (!opts.allLabels && !selectedSet.has(labelId)) continue
      const name = nameById.get(labelId) ?? labelId
      addTo(labelId, name, value, basis)
    }
  }

  const ordered = [...groups.values()].sort((a, b) => {
    if (a.key === UNLABELLED_KEY) return 1
    if (b.key === UNLABELLED_KEY) return -1
    return a.label.localeCompare(b.label)
  })
  return {
    groups: ordered.map((g) => ({
      key: g.key,
      label: g.label,
      costBasis: round8(g.costBasis),
      value: round8(g.value),
    })),
  }
}