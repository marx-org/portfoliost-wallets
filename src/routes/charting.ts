import { Hono } from "hono"
import { and, eq, inArray, sql } from "drizzle-orm"
import { userIdentityMiddleware } from "../auth.js"
import { getDb, type DB } from "../db/index.js"
import {
  chartEventFacts,
  chartPositionDaily,
  chartProjectionState,
  portfolios,
} from "../db/schema.js"
import { resolveChartScope, type ChartScopeInput, type ResolvedChartScope } from "../services/charting/scope.js"
import { publishedFactsCondition, type PublishedGeneration } from "../services/charting/queries.js"
import { getScopedPerformance, getScopedBenchmarkSeries, quarterlyReturns } from "../services/charting/performance.js"
import {
  allocationByAssetType,
  allocationByCurrency,
  allocationBySector,
  allocationByStockCategory,
  costAndValueByLabel,
  holdingsComposition,
  profitValuePoints,
  stockCategoryLabel,
} from "../services/charting/allocation.js"
import { resolvedFxRate } from "../services/instruments-fx.js"
import { cashBalances } from "../services/cashLedger.js"
import {
  aggregateIncome,
  annualIncomeEquivalent,
  annualIncomeSeries,
  cumulativeIncomeSeries,
  monthlyIncomeSeries,
  quarterlyIncomeGrowth,
  quarterlyIncomeSeries,
} from "../services/charting/income.js"
import {
  isStockChartCategory,
  listHoldableStocks,
  listStockCategories,
  upsertStockCategory,
  type StockCategoryAssignment,
} from "../services/charting/categories.js"
import { monthlyPayerCoverage } from "../services/charting/payerCoverage.js"
import { cashBalanceSeriesForScope } from "../services/charting/cash.js"
import type { components } from "../generated/api-types.js"

type ChartIncomeData = components["schemas"]["ChartIncomeData"]
type ChartAllocationData = components["schemas"]["ChartAllocationData"]
type ChartPerformanceData = components["schemas"]["ChartPerformanceData"]
type ChartCashData = components["schemas"]["ChartCashData"]
type ChartCoverage = components["schemas"]["ChartCoverage"]
type ChartMissingCoverage = components["schemas"]["ChartMissingCoverage"]
type ChartScopeDto = components["schemas"]["ChartScope"]
type StockChartCategoryAssignment = components["schemas"]["StockChartCategoryAssignment"]

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Result of resolving which scoped accounts actually have published facts. */
interface ScopeProjection {
  published: PublishedGeneration[]
  missing: ChartMissingCoverage[]
  generation: number
  complete: boolean
  stale: boolean
}

function hasMalformedIds(input: ChartScopeInput): boolean {
  return [...(input.accountIds ?? []), ...(input.labelIds ?? [])].some((id) => !UUID_RE.test(id))
}

/**
 * Charting reads (feature #253). Each GET reads one published fact generation
 * plus bounded joins/aggregation — it never replays trades, rebuilds prices or
 * fans out provider calls. Rebuilds happen in recompute/refresh jobs.
 */
export function createChartingRoutes(db?: DB) {
  const routes = new Hono()
  routes.use("*", userIdentityMiddleware)
  const getDbInstance = () => db ?? getDb()

  const parseScope = (c: { req: { query: () => Record<string, string | undefined> } }): ChartScopeInput => {
    const q = c.req.query()
    const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined)
    return {
      accountIds: list(q.accounts),
      labelIds: list(q.labels),
      currency: q.currency,
      from: q.from ?? null,
      to: q.to ?? null,
      metric: q.metric,
    }
  }

  const toScopeDto = (s: ResolvedChartScope): ChartScopeDto => ({
    accountIds: s.accountIds,
    labelIds: s.labelIds,
    currency: s.currency,
    from: s.from,
    to: s.to,
  })

  /** The real accounts a resolved scope reads facts from (All → every owned real account). */
  async function effectiveAccountIds(database: DB, userId: string, scope: ResolvedChartScope): Promise<string[]> {
    if (!scope.allAccounts) return scope.accountIds
    const rows = await database
      .select({ id: portfolios.id })
      .from(portfolios)
      .where(and(eq(portfolios.userId, userId), eq(portfolios.isVirtual, false)))
    return rows.map((r) => r.id)
  }

  /**
   * Which scoped accounts have published facts, and at which generation.
   * Generations are per portfolio: an account whose projection has never run
   * contributes nothing and is reported in `coverage.missing`; it must not drag
   * the whole scope down to generation 0 (#95). `generation` is the newest
   * published generation in the scope, and each account is read at its own.
   */
  async function scopeProjection(database: DB, accountIds: string[]): Promise<ScopeProjection> {
    if (accountIds.length === 0) return { published: [], missing: [], generation: 0, complete: false, stale: false }
    const rows = await database
      .select({
        portfolioId: portfolios.id,
        name: portfolios.name,
        generation: chartProjectionState.generation,
        status: chartProjectionState.status,
      })
      .from(portfolios)
      .leftJoin(chartProjectionState, eq(chartProjectionState.portfolioId, portfolios.id))
      .where(inArray(portfolios.id, accountIds))
    const byPortfolio = new Map(rows.map((r) => [r.portfolioId, r]))

    const published: PublishedGeneration[] = []
    const missing: ChartMissingCoverage[] = []
    for (const id of accountIds) {
      const row = byPortfolio.get(id)
      if (!row || row.generation == null || row.generation <= 0) {
        missing.push({ reason: "not_projected", detail: row?.name ?? id })
        continue
      }
      published.push({ portfolioId: id, generation: row.generation })
    }
    if (published.length === 0) return { published, missing, generation: 0, complete: false, stale: false }

    const stale = published.some((p) => byPortfolio.get(p.portfolioId)?.status !== "complete")
    return {
      published,
      missing,
      generation: Math.max(...published.map((p) => p.generation)),
      // Complete means every account in scope has published facts that are not
      // flagged dirty; differing generations across accounts are still complete,
      // because each is served from its own published generation.
      complete: missing.length === 0 && !stale,
      stale,
    }
  }

  const coverage = (p: ScopeProjection, accountCount: number): ChartCoverage => ({
    generation: p.generation,
    asOf: new Date().toISOString(),
    status:
      accountCount === 0
        ? "empty"
        : p.complete
          ? "complete"
          : p.stale && p.missing.length === 0
            ? "stale"
            : "partial",
    partial: !p.complete,
    currentPeriod: false,
    stale: p.stale,
    missing: p.missing,
  })

  // GET /api/portfolios/charting/income
  routes.get("/income", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const input = parseScope(c)
    if (hasMalformedIds(input)) return c.json({ error: "ValidationError", message: "malformed id" }, 422)
    const scope = await resolveChartScope(database, identity.id, input)
    const accountIds = await effectiveAccountIds(database, identity.id, scope)
    const projection = await scopeProjection(database, accountIds)
    const agg = await aggregateIncome(database, projection.published, scope.from, scope.to, scope.labelIds)
    const monthly = monthlyIncomeSeries(agg)
    const cumulative = await cumulativeIncomeSeries(database, projection.published, monthly, {
      from: scope.from,
      labelIds: scope.labelIds,
    })
    const annual = annualIncomeSeries(agg.annual)
    const quarterly = quarterlyIncomeSeries(agg.quarterly)
    const quarterlyGrowth = quarterlyIncomeGrowth(quarterly)
    const payerCoverage = await monthlyPayerCoverage(database, identity.id, projection.published, {
      labelIds: scope.labelIds,
    })
    const body: ChartIncomeData = {
      currency: scope.currency,
      scope: toScopeDto(scope),
      coverage: coverage(projection, accountIds.length),
      monthly,
      cumulative,
      annual: annual.map(({ partial: _partial, ...rest }) => rest),
      quarterly: quarterly.map((b, i) => ({
        quarter: b.quarter,
        dividends: b.dividends,
        interest: b.interest,
        options: b.options,
        total: b.total,
        priorYearQuarterTotal: quarterlyGrowth[i].prior,
        yoyChangePercent: quarterlyGrowth[i].changePercent,
      })),
      dailyAverageByYear: annualIncomeEquivalent(annual, "day"),
      monthlyAverageByYear: annualIncomeEquivalent(annual, "month"),
      payerCoverage,
    }
    return c.json(body satisfies ChartIncomeData)
  })

  // GET /api/portfolios/charting/performance
  routes.get("/performance", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const input = parseScope(c)
    if (hasMalformedIds(input)) return c.json({ error: "ValidationError", message: "malformed id" }, 422)
    const scope = await resolveChartScope(database, identity.id, input)
    const accountIds = await effectiveAccountIds(database, identity.id, scope)
    const projection = await scopeProjection(database, accountIds)
    const series = await getScopedPerformance(database, projection.published, {
      from: scope.from,
      to: scope.to,
      labelIds: scope.labelIds,
    })
    const benchmarkSymbols = (c.req.query("benchmarks") ?? "")
      .split(",")
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)
    const benchmarkFrom = scope.from ?? series.points[0]?.date
    const benchmarkTo = scope.to ?? series.points.at(-1)?.date
    const benchmarks =
      benchmarkSymbols.length > 0 && benchmarkFrom && benchmarkTo
        ? await getScopedBenchmarkSeries(database, projection.published, {
            from: benchmarkFrom,
            to: benchmarkTo,
            baseCurrency: scope.currency,
            authToken: c.req.header("Authorization") ?? null,
            symbols: benchmarkSymbols,
            labelIds: scope.labelIds,
          })
        : []
    const authToken = c.req.header("Authorization") ?? null
    const convertToDisplay = async (from: string, amount: number): Promise<number | null> => {
      if (!from) return null
      if (from === scope.currency) return amount
      const r = await resolvedFxRate(authToken, from, scope.currency)
      return r ? amount * r.rate : null
    }
    const scatter = await profitValuePoints(database, projection.published, {
      displayCurrency: scope.currency,
      convert: convertToDisplay,
    })
    const body: ChartPerformanceData = {
      currency: scope.currency,
      scope: { ...toScopeDto(scope), benchmarks: benchmarkSymbols },
      coverage: coverage(projection, accountIds.length),
      series: series.points.map((p) => ({
        date: p.date,
        value: p.value,
        invested: p.invested,
        capitalBasis: p.capitalBasis,
        cumulativeIncome: p.cumulativeIncome,
        cumulativeOptions: p.cumulativeOptions,
        unpricedValue: null,
        carriedValue: null,
        twr: null,
        mwr: null,
        simple: null,
      })),
      quarterly: quarterlyReturns(series.points),
      scatter: scatter.points.map((p) => ({
        symbol: p.key,
        name: p.name,
        assetType: p.assetType,
        accounts: p.accounts,
        marketValue: p.marketValue,
        totalProfit: p.totalProfit,
        realized: p.realized,
        unrealized: p.unrealized,
        dividends: p.dividends,
      })),
      benchmarks,
    }
    return c.json(body satisfies ChartPerformanceData)
  })

  // GET /api/portfolios/charting/allocation
  routes.get("/allocation", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const input = parseScope(c)
    if (hasMalformedIds(input)) return c.json({ error: "ValidationError", message: "malformed id" }, 422)
    const scope = await resolveChartScope(database, identity.id, input)
    const accountIds = await effectiveAccountIds(database, identity.id, scope)
    const projection = await scopeProjection(database, accountIds)

    const asset = await allocationByAssetType(database, projection.published)
    const sector = await allocationBySector(database, projection.published)
    const authToken = c.req.header("Authorization") ?? null
    // Convert each account-base value into the requested display currency before
    // grouping by denomination; an unresolvable rate is exposed as unknown.
    const convertToDisplay = async (from: string, amount: number): Promise<number | null> => {
      if (!from) return null
      if (from === scope.currency) return amount
      const r = await resolvedFxRate(authToken, from, scope.currency)
      return r ? amount * r.rate : null
    }
    const currency = await allocationByCurrency(database, projection.published, {
      displayCurrency: scope.currency,
      convert: convertToDisplay,
    })
    // Current cash per scoped account, from the wallets ledger, converted into
    // the display currency. A ledger/FX failure leaves cash out rather than
    // inventing a zero.
    let cash = 0
    if (accountIds.length > 0) {
      const bases = await database
        .select({ id: portfolios.id, baseCurrency: portfolios.baseCurrency })
        .from(portfolios)
        .where(inArray(portfolios.id, accountIds))
      const baseById = new Map(bases.map((b) => [b.id, b.baseCurrency]))
      for (const id of accountIds) {
        try {
          const balances = await cashBalances(database, authToken, id)
          const base = baseById.get(id) ?? ""
          const amount = balances.get(base) ?? 0
          if (!amount) continue
          const converted = await convertToDisplay(base, amount)
          if (converted != null) cash += converted
        } catch {
          // Leave cash out of this account; the position composition is still valid.
        }
      }
    }
    const composition = await holdingsComposition(database, projection.published, {
      displayCurrency: scope.currency,
      convert: convertToDisplay,
      cash,
    })
    const sliceWith = (key: string, value: number, total: number, unknown = false) => ({
      key,
      label: key,
      value,
      percent: total > 0 ? Math.round((value / total) * 1000) / 10 : null,
      sourceCurrency: null,
      sourceValue: null,
      unknown,
    })
    // Dividend-stock categories are a STOCK-only denominator: cash, bonds and
    // derivatives are excluded, and an unassigned stock is `not_classified`.
    const category = await allocationByStockCategory(database, identity.id, projection.published)
    const categorySlice = (s: { key: string; value: number }) => ({
      key: s.key,
      label: stockCategoryLabel(s.key),
      value: s.value,
      percent: category.total > 0 ? Math.round((s.value / category.total) * 1000) / 10 : null,
      sourceCurrency: null,
      sourceValue: null,
      unknown: s.key === "not_classified",
    })
    // Cost basis vs market value per label. Label groups are independent, so the
    // rows are not a partition and their sum is not a portfolio total.
    const costValue = await costAndValueByLabel(database, identity.id, projection.published, {
      allLabels: scope.allLabels,
      labelIds: scope.labelIds,
    })
    const body: ChartAllocationData = {
      currency: scope.currency,
      scope: toScopeDto(scope),
      coverage: coverage(projection, accountIds.length),
      byCurrency: currency.slices.map((s) => sliceWith(s.key, s.value, currency.total, s.unknown)),
      byAssetType: asset.slices.map((s) => sliceWith(s.key, s.value, asset.total)),
      bySector: sector.slices.map((s) => sliceWith(s.key, s.value, sector.total)),
      byCategory: category.slices.map(categorySlice),
      byLabel: [],
      byCostBasis: costValue.groups.map((g) => ({
        key: g.key,
        label: g.label,
        costBasis: g.costBasis,
        value: g.value,
        percentCost: null,
        percentValue: null,
        unknown: false,
      })),
      positions: composition.slices.map((s) => ({
        key: s.key,
        label: s.label,
        value: s.value,
        percent: composition.total > 0 ? Math.round((s.value / composition.total) * 1000) / 10 : null,
        sourceCurrency: null,
        sourceValue: null,
        unknown: s.unknown,
      })),
    }
    return c.json(body satisfies ChartAllocationData)
  })

  // GET /api/portfolios/charting/cash
  routes.get("/cash", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const input = parseScope(c)
    if (hasMalformedIds(input)) return c.json({ error: "ValidationError", message: "malformed id" }, 422)
    const scope = await resolveChartScope(database, identity.id, input)
    const accountIds = await effectiveAccountIds(database, identity.id, scope)
    const projection = await scopeProjection(database, accountIds)

    const annual = new Map<number, { contributions: number; withdrawals: number }>()
    if (projection.published.length > 0) {
      const rows = await database
        .select({ year: sql<string>`extract(year from ${chartEventFacts.eventDate})`, kind: chartEventFacts.receiptKind, amount: chartEventFacts.amountBase })
        .from(chartEventFacts)
        .where(publishedFactsCondition(chartEventFacts.portfolioId, chartEventFacts.generation, projection.published))
      for (const r of rows) {
        const y = Number(r.year)
        const cur = annual.get(y) ?? { contributions: 0, withdrawals: 0 }
        const amt = Number(r.amount)
        if (r.kind === "contribution") cur.contributions += amt
        else if (r.kind === "withdrawal") cur.withdrawals += Math.abs(amt)
        annual.set(y, cur)
      }
    }
    const cash = await cashBalanceSeriesForScope(database, projection.published, {
      from: scope.from,
      to: scope.to,
      displayCurrency: scope.currency,
      authToken: c.req.header("Authorization") ?? null,
    })
    const body: ChartCashData = {
      currency: scope.currency,
      scope: toScopeDto(scope),
      coverage: coverage(projection, accountIds.length),
      balanceHistory: cash.total,
      series: cash.series,
      annualContributions: [...annual]
        .sort((a, b) => a[0] - b[0])
        .map(([year, v]) => ({ year, contributions: v.contributions, withdrawals: v.withdrawals, net: v.contributions - v.withdrawals, partial: false })),
    }
    return c.json(body satisfies ChartCashData)
  })

  // GET /api/portfolios/charting/stock-categories
  routes.get("/stock-categories", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const input = parseScope(c)
    if (hasMalformedIds(input)) return c.json({ error: "ValidationError", message: "malformed id" }, 422)
    const scope = await resolveChartScope(database, identity.id, input)
    const accountIds = await effectiveAccountIds(database, identity.id, scope)
    const all = await listStockCategories(database, identity.id)
    let rows: StockCategoryAssignment[] = all
    // An account/label filter narrows the assignment table to the scoped STOCK
    // holdings; All returns every assignment the caller owns.
    if (!scope.allAccounts || !scope.allLabels) {
      const stocks = await listHoldableStocks(database, identity.id, { accountIds, labelIds: scope.labelIds })
      const allowed = new Set(stocks.map((s) => `${s.symbol}|${s.instrumentCurrency}`))
      rows = all.filter((a) => allowed.has(`${a.symbol}|${a.instrumentCurrency}`))
    }
    return c.json(rows.map(toCategoryDto) satisfies StockChartCategoryAssignment[])
  })

  // PUT /api/portfolios/charting/stock-categories
  routes.put("/stock-categories", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return c.json({ error: "ValidationError", message: "invalid json" }, 422)
    }
    const body = (raw ?? {}) as Record<string, unknown>
    const symbol = typeof body.symbol === "string" ? body.symbol.trim().toUpperCase() : ""
    const instrumentCurrency =
      typeof body.instrumentCurrency === "string" ? body.instrumentCurrency.trim().toUpperCase() : ""
    const category = body.category
    if (
      !symbol ||
      !/^[A-Z0-9][A-Z0-9.^_-]{0,31}$/.test(symbol) ||
      !/^[A-Z]{3}$/.test(instrumentCurrency) ||
      !isStockChartCategory(category)
    ) {
      return c.json({ error: "ValidationError", message: "unknown category or identity" }, 422)
    }
    const row = await upsertStockCategory(database, identity.id, { symbol, instrumentCurrency, category })
    return c.json(toCategoryDto(row) satisfies StockChartCategoryAssignment)
  })

  return routes
}

function toCategoryDto(row: StockCategoryAssignment): StockChartCategoryAssignment {
  return {
    symbol: row.symbol,
    instrumentCurrency: row.instrumentCurrency,
    name: row.name ?? null,
    category: row.category,
    updatedAt: row.updatedAt.toISOString(),
  }
}