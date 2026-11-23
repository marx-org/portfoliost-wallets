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
import { annualContributions, cashBalanceSeriesForScope, cumulativeContributions } from "../services/charting/cash.js"
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
  /**
   * The currency the facts are stored in — every scoped account's base currency.
   * The route converts comparable series from this into the requested display
   * currency before responding. All accounts share one base in practice; when
   * they do not, the first is used (a mixed-base aggregate is already undefined).
   */
  sourceCurrency: string
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
      kind: q.kind ?? null,
    }
  }

  const toScopeDto = (s: ResolvedChartScope): ChartScopeDto => ({
    accountIds: s.accountIds,
    virtualAccountIds: s.virtualAccountIds,
    labelIds: s.labelIds,
    currency: s.currency,
    from: s.from,
    to: s.to,
  })

  /** All owned real (non-virtual) account ids — the only accounts with facts. */
  async function allRealAccountIds(database: DB, userId: string): Promise<string[]> {
    const rows = await database
      .select({ id: portfolios.id })
      .from(portfolios)
      .where(and(eq(portfolios.userId, userId), eq(portfolios.isVirtual, false)))
    return rows.map((r) => r.id)
  }

  /**
   * The real accounts a resolved scope reads facts from. A virtual scope is a
   * label-defined view over the real accounts, so it always reads every real
   * account and narrows by label; a normal scope reads the selected real
   * accounts, or all of them when All.
   */
  async function effectiveAccountIds(database: DB, userId: string, scope: ResolvedChartScope): Promise<string[]> {
    if (scope.kind === "virtual" || scope.allAccounts) return allRealAccountIds(database, userId)
    return scope.accountIds
  }

  /**
   * The position-label constraint for this scope. In virtual mode the selected
   * virtual portfolios' labels are the universe (a virtual portfolio is a
   * read-only view over the positions carrying its label); in normal mode the
   * explicit label filter applies.
   */
  function effectiveLabelIds(scope: ResolvedChartScope): string[] {
    return scope.kind === "virtual" ? scope.virtualLabelIds : scope.labelIds
  }

  /**
   * Latest-rate converter from the facts' source currency into the requested
   * display currency. The rest of the app converts for display at the latest
   * rate; charting must do the same or a non-base selection is merely relabeled
   * (the values stay in the account base but wear the requested symbol). A rate
   * that cannot be resolved leaves the value untouched, matching the app's
   * degrade-to-base behaviour. Rates are cached per request.
   */
  function makeRateConverter(authToken: string | null) {
    const cache = new Map<string, number | null>()
    return async (from: string, to: string): Promise<number | null> => {
      const src = (from || "").toUpperCase()
      const dst = (to || "").toUpperCase()
      if (!src || !dst || src === dst) return 1
      const key = `${src}>${dst}`
      if (cache.has(key)) return cache.get(key) ?? null
      const r = await resolvedFxRate(authToken, src, dst)
      const rate = r ? r.rate : null
      cache.set(key, rate)
      return rate
    }
  }

  /**
   * Which scoped accounts have published facts, and at which generation.
   * Generations are per portfolio: an account whose projection has never run
   * contributes nothing and is reported in `coverage.missing`; it must not drag
   * the whole scope down to generation 0 (#95). `generation` is the newest
   * published generation in the scope, and each account is read at its own.
   */
  async function scopeProjection(database: DB, accountIds: string[]): Promise<ScopeProjection> {
    if (accountIds.length === 0)
      return { published: [], missing: [], generation: 0, complete: false, stale: false, sourceCurrency: "USD" }
    const rows = await database
      .select({
        portfolioId: portfolios.id,
        name: portfolios.name,
        generation: chartProjectionState.generation,
        status: chartProjectionState.status,
        baseCurrency: portfolios.baseCurrency,
      })
      .from(portfolios)
      .leftJoin(chartProjectionState, eq(chartProjectionState.portfolioId, portfolios.id))
      .where(inArray(portfolios.id, accountIds))
    const byPortfolio = new Map(rows.map((r) => [r.portfolioId, r]))
    // The facts are stored in each account's base currency; the common one is
    // the source for display conversion.
    const sourceCurrency =
      [...new Set(rows.map((r) => (r.baseCurrency ?? "").toUpperCase()).filter(Boolean))][0] ?? "USD"

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
    if (published.length === 0)
      return { published, missing, generation: 0, complete: false, stale: false, sourceCurrency }

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
      sourceCurrency,
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
    const labelIds = effectiveLabelIds(scope)
    const agg = await aggregateIncome(database, projection.published, scope.from, scope.to, labelIds)
    const monthly = monthlyIncomeSeries(agg)
    const cumulative = await cumulativeIncomeSeries(database, projection.published, monthly, {
      from: scope.from,
      labelIds,
    })
    const annual = annualIncomeSeries(agg.annual)
    const quarterly = quarterlyIncomeSeries(agg.quarterly)
    const quarterlyGrowth = quarterlyIncomeGrowth(quarterly)
    const payerCoverage = await monthlyPayerCoverage(database, identity.id, projection.published, {
      labelIds,
    })
    // Income facts are stored in the accounts' base currency; convert every
    // amount to the requested display currency (ratios/yoy are scale-invariant).
    const incRate = await makeRateConverter(c.req.header("Authorization") ?? null)(
      projection.sourceCurrency,
      scope.currency,
    )
    const cv = (v: number): number => (incRate == null ? v : v * incRate)
    const cvN = (v: number | null | undefined): number | null | undefined =>
      v == null ? v : incRate == null ? v : v * incRate
    const annualConverted = annual.map((p) => ({
      ...p,
      dividends: cv(p.dividends),
      interest: cv(p.interest),
      options: cv(p.options),
      total: cv(p.total),
      priorYearTotal: cvN(p.priorYearTotal) ?? null,
    }))
    const body: ChartIncomeData = {
      currency: scope.currency,
      scope: toScopeDto(scope),
      coverage: coverage(projection, accountIds.length),
      monthly: monthly.map((p) => ({
        ...p,
        dividends: cv(p.dividends),
        interest: cv(p.interest),
        options: cv(p.options),
        total: cv(p.total),
      })),
      cumulative: cumulative.map((p) => ({
        ...p,
        dividends: cv(p.dividends),
        interest: cv(p.interest),
        options: cv(p.options),
        total: cv(p.total),
        openingBalance: cv(p.openingBalance),
      })),
      annual: annualConverted.map(({ partial: _partial, ...rest }) => rest),
      quarterly: quarterly.map((b, i) => ({
        quarter: b.quarter,
        dividends: cv(b.dividends),
        interest: cv(b.interest),
        options: cv(b.options),
        total: cv(b.total),
        priorYearQuarterTotal: cvN(quarterlyGrowth[i].prior) ?? null,
        yoyChangePercent: quarterlyGrowth[i].changePercent,
      })),
      dailyAverageByYear: annualIncomeEquivalent(annualConverted, "day"),
      monthlyAverageByYear: annualIncomeEquivalent(annualConverted, "month"),
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
    const labelIds = effectiveLabelIds(scope)
    const series = await getScopedPerformance(database, projection.published, {
      from: scope.from,
      to: scope.to,
      labelIds,
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
            labelIds,
          })
        : []
    const authToken = c.req.header("Authorization") ?? null
    const convertToDisplay = async (from: string, amount: number): Promise<number | null> => {
      if (!from) return null
      if (from === scope.currency) return amount
      const r = await resolvedFxRate(authToken, from, scope.currency)
      return r ? amount * r.rate : null
    }
    // The series is aggregated in the accounts' base currency; convert it to the
    // requested display currency so the response is not merely relabeled.
    const perfRate = await makeRateConverter(authToken)(projection.sourceCurrency, scope.currency)
    const convPerf = (v: number): number => (perfRate == null ? v : v * perfRate)
    const convPerfN = (v: number | null | undefined): number | null | undefined =>
      v == null ? v : perfRate == null ? v : v * perfRate
    const scatter = await profitValuePoints(database, projection.published, {
      displayCurrency: scope.currency,
      convert: convertToDisplay,
      labelIds,
    })
    const body: ChartPerformanceData = {
      currency: scope.currency,
      scope: { ...toScopeDto(scope), benchmarks: benchmarkSymbols },
      coverage: coverage(projection, accountIds.length),
      series: series.points.map((p) => ({
        date: p.date,
        value: convPerf(p.value),
        invested: convPerfN(p.invested),
        capitalBasis: convPerfN(p.capitalBasis),
        cumulativeIncome: convPerfN(p.cumulativeIncome),
        cumulativeOptions: convPerfN(p.cumulativeOptions),
        unpricedValue: null,
        carriedValue: null,
        twr: null,
        mwr: null,
        simple: null,
      })),
      quarterly: quarterlyReturns(series.points).map((q) => ({
        ...q,
        endingValue: convPerf(q.endingValue),
        cumulativeNetContributions: convPerfN(q.cumulativeNetContributions) ?? undefined,
      })),
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
    const labelIds = effectiveLabelIds(scope)

    const asset = await allocationByAssetType(database, projection.published, labelIds)
    const sector = await allocationBySector(database, projection.published, labelIds)
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
      labelIds,
    })
    // Current cash per scoped account, from the wallets ledger, converted into
    // the display currency. A ledger/FX failure leaves cash out rather than
    // inventing a zero. A virtual portfolio is a positions-only view with no
    // cash ledger, so it contributes no cash.
    let cash = 0
    if (scope.kind !== "virtual" && accountIds.length > 0) {
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
      labelIds,
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
    const category = await allocationByStockCategory(database, identity.id, projection.published, labelIds)
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
      labelIds,
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
    const labelIds = effectiveLabelIds(scope)
    const authToken = c.req.header("Authorization") ?? null

    // A virtual portfolio is a positions-only view with no cash ledger, so the
    // cash/funding charts are empty in virtual mode rather than showing the real
    // accounts' cash (which the virtual view does not own).
    const isVirtual = scope.kind === "virtual"
    // Convert each account-base amount into the requested display currency before
    // grouping by year; an unresolvable rate leaves the year marked incomplete.
    const convertToDisplay = async (from: string, amount: number): Promise<number | null> => {
      if (!from) return null
      if (from === scope.currency) return amount
      const r = await resolvedFxRate(authToken, from, scope.currency)
      return r ? amount * r.rate : null
    }
    const annual = isVirtual
      ? []
      : await annualContributions(database, projection.published, {
          convert: convertToDisplay,
          labelIds,
          from: scope.from,
          to: scope.to,
        })
    const cash = isVirtual
      ? { series: [], total: [], currency: scope.currency }
      : await cashBalanceSeriesForScope(database, projection.published, {
          from: scope.from,
          to: scope.to,
          displayCurrency: scope.currency,
          authToken,
        })
    const cumulative = isVirtual
      ? { series: [], total: [], currency: scope.currency }
      : await cumulativeContributions(database, projection.published, {
          convert: convertToDisplay,
          displayCurrency: scope.currency,
          labelIds,
          from: scope.from,
          to: scope.to,
        })
    const body: ChartCashData = {
      currency: scope.currency,
      scope: toScopeDto(scope),
      coverage: coverage(projection, accountIds.length),
      balanceHistory: cash.total,
      series: cash.series,
      annualContributions: annual,
      cumulativeContributions: cumulative.series,
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
    const labelIds = effectiveLabelIds(scope)
    const all = await listStockCategories(database, identity.id)
    let rows: StockCategoryAssignment[] = all
    // An account/label filter narrows the assignment table to the scoped STOCK
    // holdings; All returns every assignment the caller owns.
    if (!scope.allAccounts || !scope.allLabels || labelIds.length > 0) {
      const stocks = await listHoldableStocks(database, identity.id, { accountIds, labelIds })
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