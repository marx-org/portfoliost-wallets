import { and, eq, inArray, lte, max, sql } from "drizzle-orm"
import type { DB } from "../../db/index.js"
import { chartPositionDaily, labels, portfolios, positions, positionLabels, stockChartCategories } from "../../db/schema.js"
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
/**
 * Current market value by asset type (feature #253, sub-issue #267).
 *
 * One slice per canonical asset type across the scoped current positions, in the
 * account base currency. This is the same `byAssetType` the allocation endpoint
 * and the portfolio Allocation table use; it is extracted here so the charting
 * renderer and any future caller share one aggregation. Asset types are the
 * canonical `positions.asset_type` values (STOCK, BOND, FUND, …); an unknown
 * type is exposed as `UNKNOWN`, never silently dropped. Cash is a ledger balance,
 * not a position-day fact, so it is not part of this position universe.
 */
export interface AssetTypeSlice {
  key: string
  value: number
}

export interface AssetTypeAllocation {
  /** Descending by value; zero-value types omitted. */
  slices: AssetTypeSlice[]
  /** Denominator: the total the percentages are relative to. */
  total: number
}

export async function allocationByAssetType(
  db: DB,
  published: PublishedGeneration[],
): Promise<AssetTypeAllocation> {
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
    .select({ assetType: positions.assetType, value: chartPositionDaily.value })
    .from(chartPositionDaily)
    .innerJoin(positions, eq(positions.id, chartPositionDaily.positionId))
    .where(and(scopeCondition, eq(chartPositionDaily.day, latestDay)))

  const totals = new Map<string, number>()
  let total = 0
  for (const r of rows) {
    const value = Number(r.value)
    if (!Number.isFinite(value)) continue
    total += value
    const key = r.assetType || "UNKNOWN"
    totals.set(key, (totals.get(key) ?? 0) + value)
  }
  const slices = [...totals]
    .map(([key, value]) => ({ key, value: round8(value) }))
    .filter((s) => s.value !== 0)
    .sort((a, b) => b.value - a.value)
  return { slices, total: round8(total) }
}

/**
 * Current market value by sector (feature #253, sub-issue #268).
 *
 * One slice per `positions.sector` at the latest published day, descending by
 * value. The existing portfolio Allocation donut/table and the Charting sector
 * renderer share this aggregation; an unknown/missing sector is exposed as
 * `UNKNOWN` rather than dropped. Cash is a ledger balance, not a position-day
 * fact, so it is not part of this universe.
 */
export interface SectorSlice {
  key: string
  value: number
}

export interface SectorAllocation {
  /** Descending by value; zero-value sectors omitted. */
  slices: SectorSlice[]
  /** Denominator: the total the percentages are relative to. */
  total: number
}

export async function allocationBySector(
  db: DB,
  published: PublishedGeneration[],
): Promise<SectorAllocation> {
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
    .select({ sector: positions.sector, value: chartPositionDaily.value })
    .from(chartPositionDaily)
    .innerJoin(positions, eq(positions.id, chartPositionDaily.positionId))
    .where(and(scopeCondition, eq(chartPositionDaily.day, latestDay)))

  const totals = new Map<string, number>()
  let total = 0
  for (const r of rows) {
    const value = Number(r.value)
    if (!Number.isFinite(value)) continue
    total += value
    const key = r.sector || "UNKNOWN"
    totals.set(key, (totals.get(key) ?? 0) + value)
  }
  const slices = [...totals]
    .map(([key, value]) => ({ key, value: round8(value) }))
    .filter((s) => s.value !== 0)
    .sort((a, b) => b.value - a.value)
  return { slices, total: round8(total) }
}

/**
 * Currency-denomination weights in a comparable display currency (feature
 * #253, sub-issue #266).
 *
 * The facts store each position's value in its ACCOUNT base currency, so the
 * old by-currency rows added EUR + USD + PLN as if they were one number. This
 * converts every position from its account base into the requested display
 * currency first, then groups by the instrument's denomination currency. The
 * denominator is therefore a single comparable total, and each slice's `value`
 * is in that display currency while `key` is the denomination.
 *
 * A position whose rate cannot be resolved is not silently treated as 1:1: its
 * value is left out of the comparable total and the denomination is flagged
 * `unknown`. Cash is a ledger balance, not a position-day fact, so it is not
 * part of this position universe.
 */
export interface CurrencySlice {
  /** Instrument denomination currency (e.g. USD, PLN). */
  key: string
  /** Comparable value in the display currency. */
  value: number
  unknown: boolean
}

export interface CurrencyAllocation {
  slices: CurrencySlice[]
  /** Denominator: the comparable total the percentages are relative to. */
  total: number
  currency: string
}

export async function allocationByCurrency(
  db: DB,
  published: PublishedGeneration[],
  opts: {
    displayCurrency: string
    /** Convert an amount from a source currency into the display currency; null = unknown. */
    convert: (from: string, amount: number) => Promise<number | null>
  },
): Promise<CurrencyAllocation> {
  const currency = opts.displayCurrency
  if (published.length === 0) return { slices: [], total: 0, currency }
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
  if (!latestDay) return { slices: [], total: 0, currency }

  const rows = await db
    .select({
      baseCurrency: portfolios.baseCurrency,
      instrumentCurrency: positions.instrumentCurrency,
      value: chartPositionDaily.value,
    })
    .from(chartPositionDaily)
    .innerJoin(positions, eq(positions.id, chartPositionDaily.positionId))
    .innerJoin(portfolios, eq(portfolios.id, chartPositionDaily.portfolioId))
    .where(and(scopeCondition, eq(chartPositionDaily.day, latestDay)))

  const totals = new Map<string, { value: number; unknown: boolean }>()
  let total = 0
  for (const r of rows) {
    const amount = Number(r.value)
    if (!Number.isFinite(amount)) continue
    const key = r.instrumentCurrency || "UNKNOWN"
    const base = r.baseCurrency || ""
    const converted = await opts.convert(base, amount)
    if (converted == null || !Number.isFinite(converted)) {
      const cur = totals.get(key) ?? { value: 0, unknown: false }
      cur.unknown = true
      totals.set(key, cur)
      continue
    }
    total += converted
    const cur = totals.get(key) ?? { value: 0, unknown: false }
    cur.value += converted
    totals.set(key, cur)
  }
  const slices = [...totals]
    .map(([key, v]) => ({ key, value: round8(v.value), unknown: v.unknown }))
    .filter((s) => s.value !== 0 || s.unknown)
    .sort((a, b) => b.value - a.value)
  return { slices, total: round8(total), currency }
}

/**
 * Current composition of all holdings (feature #253, sub-issue #271).
 *
 * Market value per instrument identity (asset type + symbol + instrument
 * currency, so a same-ticker option or a different listing never merges) plus
 * the scoped cash balance, converted into the display currency. The result is
 * sorted descending; the renderer groups the tail into an expandable "Other".
 * Closed/zero-value holdings do not appear. A signed cash balance is kept signed
 * in the data; the pie basis is disclosed by the renderer.
 *
 * Cash is read from the wallets cash ledger by the caller and passed in already
 * converted, so this function stays a fact aggregation.
 */
export interface HoldingSlice {
  /** Canonical instrument identity (or the cash bucket). */
  key: string
  label: string
  assetType: string
  /** Comparable value in the display currency; cash may be negative. */
  value: number
  unknown: boolean
}

export interface HoldingsComposition {
  /** Descending by value; zero-value rows omitted. */
  slices: HoldingSlice[]
  /** Sum of all slice values (signed, so cash can reduce it). */
  total: number
  currency: string
}

export async function holdingsComposition(
  db: DB,
  published: PublishedGeneration[],
  opts: {
    displayCurrency: string
    /** Convert an account-base amount into the display currency; null = unknown. */
    convert: (from: string, amount: number) => Promise<number | null>
    /** Cash already converted into the display currency, if available. */
    cash?: number
  },
): Promise<HoldingsComposition> {
  const currency = opts.displayCurrency
  if (published.length === 0) return { slices: [], total: 0, currency }
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

  const groups = new Map<string, HoldingSlice>()
  let total = 0
  if (latestDay) {
    const rows = await db
      .select({
        baseCurrency: portfolios.baseCurrency,
        symbol: positions.symbol,
        companyName: positions.companyName,
        assetType: positions.assetType,
        instrumentCurrency: positions.instrumentCurrency,
        value: chartPositionDaily.value,
      })
      .from(chartPositionDaily)
      .innerJoin(positions, eq(positions.id, chartPositionDaily.positionId))
      .innerJoin(portfolios, eq(portfolios.id, chartPositionDaily.portfolioId))
      .where(and(scopeCondition, eq(chartPositionDaily.day, latestDay)))

    for (const r of rows) {
      const amount = Number(r.value)
      if (!Number.isFinite(amount)) continue
      const key = `${r.assetType || "UNKNOWN"}|${r.symbol ?? ""}|${r.instrumentCurrency ?? ""}`
      const converted = await opts.convert(r.baseCurrency || "", amount)
      const existing = groups.get(key) ?? {
        key,
        label: r.companyName || r.symbol || key,
        assetType: r.assetType || "UNKNOWN",
        value: 0,
        unknown: false,
      }
      if (converted == null || !Number.isFinite(converted)) existing.unknown = true
      else existing.value += converted
      groups.set(key, existing)
    }
  }

  if (typeof opts.cash === "number" && Number.isFinite(opts.cash) && opts.cash !== 0) {
    groups.set("CASH", { key: "CASH", label: "Cash", assetType: "CASH", value: opts.cash, unknown: false })
  }

  const slices = [...groups.values()]
    .filter((s) => s.value !== 0 || s.unknown)
    .sort((a, b) => b.value - a.value)
  for (const s of slices) total += s.value
  return {
    slices: slices.map((s) => ({ ...s, value: round8(s.value) })),
    total: round8(total),
    currency,
  }
}

/**
 * Market value vs total profit scatter (feature #253, sub-issue #275).
 *
 * One point per canonical instrument identity (asset type + symbol + instrument
 * currency, so a same-ticker option or a different listing stays distinct), at
 * the latest published day. Total profit is the existing realized + unrealized +
 * received-dividend P/L: `unrealized = marketValue − remainingBasis`. Values are
 * converted into the display currency before comparison. A position with zero
 * market value (e.g. sold on the latest day) is kept as an x=0 point rather
 * than dropped, so its historic profit stays accessible.
 */
export interface ProfitValuePoint {
  /** Canonical identity: assetType|symbol|instrumentCurrency. */
  key: string
  symbol: string
  name: string
  assetType: string
  accounts: string[]
  marketValue: number
  totalProfit: number
  realized: number
  unrealized: number
  dividends: number
}

export interface ProfitValueScatter {
  points: ProfitValuePoint[]
  currency: string
}

export async function profitValuePoints(
  db: DB,
  published: PublishedGeneration[],
  opts: {
    displayCurrency: string
    /** Convert an account-base amount into the display currency; null = unknown. */
    convert: (from: string, amount: number) => Promise<number | null>
  },
): Promise<ProfitValueScatter> {
  const currency = opts.displayCurrency
  if (published.length === 0) return { points: [], currency }
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
  if (!latestDay) return { points: [], currency }

  const rows = await db
    .select({
      positionId: chartPositionDaily.positionId,
      portfolioId: portfolios.id,
      portfolioName: portfolios.name,
      baseCurrency: portfolios.baseCurrency,
      symbol: positions.symbol,
      companyName: positions.companyName,
      assetType: positions.assetType,
      instrumentCurrency: positions.instrumentCurrency,
      value: chartPositionDaily.value,
      remainingBasis: chartPositionDaily.remainingBasis,
    })
    .from(chartPositionDaily)
    .innerJoin(positions, eq(positions.id, chartPositionDaily.positionId))
    .innerJoin(portfolios, eq(portfolios.id, chartPositionDaily.portfolioId))
    .where(and(scopeCondition, eq(chartPositionDaily.day, latestDay)))

  // Realized gains and dividends are cumulative per position; the latest day
  // only carries that day's slice, so sum the whole published history.
  const sumRows = await db
    .select({
      positionId: chartPositionDaily.positionId,
      realized: sql<string>`coalesce(sum(${chartPositionDaily.realizedGain}), 0)`,
      dividends: sql<string>`coalesce(sum(${chartPositionDaily.income}), 0)`,
    })
    .from(chartPositionDaily)
    .where(and(scopeCondition, lte(chartPositionDaily.day, latestDay)))
    .groupBy(chartPositionDaily.positionId)
  const sums = new Map(
    sumRows.map((r) => [r.positionId, { realized: Number(r.realized), dividends: Number(r.dividends) }]),
  )

  const groups = new Map<
    string,
    {
      point: ProfitValuePoint
      accounts: Set<string>
    }
  >()
  for (const r of rows) {
    const base = r.baseCurrency || ""
    const value = Number(r.value)
    const basis = Number(r.remainingBasis)
    const realized = sums.get(r.positionId)?.realized ?? 0
    const dividends = sums.get(r.positionId)?.dividends ?? 0
    if (![value, basis, realized, dividends].every((n) => Number.isFinite(n))) continue
    const convertedValue = await opts.convert(base, value)
    const convertedBasis = await opts.convert(base, basis)
    const convertedRealized = await opts.convert(base, realized)
    const convertedDividends = await opts.convert(base, dividends)
    if (
      convertedValue == null ||
      convertedBasis == null ||
      convertedRealized == null ||
      convertedDividends == null
    ) {
      continue
    }
    const key = `${r.assetType || "UNKNOWN"}|${r.symbol ?? ""}|${r.instrumentCurrency ?? ""}`
    const unrealized = convertedValue - convertedBasis
    const existing = groups.get(key)
    if (existing) {
      existing.point.marketValue += convertedValue
      existing.point.realized += convertedRealized
      existing.point.unrealized += unrealized
      existing.point.dividends += convertedDividends
      existing.point.totalProfit += convertedRealized + unrealized + convertedDividends
      existing.accounts.add(r.portfolioName)
    } else {
      groups.set(key, {
        point: {
          key,
          symbol: r.symbol ?? key,
          name: r.companyName || r.symbol || key,
          assetType: r.assetType || "UNKNOWN",
          accounts: [],
          marketValue: convertedValue,
          totalProfit: convertedRealized + unrealized + convertedDividends,
          realized: convertedRealized,
          unrealized,
          dividends: convertedDividends,
        },
        accounts: new Set([r.portfolioName]),
      })
    }
  }

  const points = [...groups.values()]
    .map(({ point, accounts }) => ({ ...point, accounts: [...accounts].sort() }))
    .sort((a, b) => b.marketValue - a.marketValue)
  return { points, currency }
}
