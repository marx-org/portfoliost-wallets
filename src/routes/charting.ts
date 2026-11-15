import { Hono } from "hono"
import { and, eq, inArray, max, sql } from "drizzle-orm"
import { userIdentityMiddleware } from "../auth.js"
import { getDb, type DB } from "../db/index.js"
import {
  chartEventFacts,
  chartPositionDaily,
  chartProjectionState,
  portfolios,
  positions,
} from "../db/schema.js"
import { resolveChartScope, type ChartScopeInput, type ResolvedChartScope } from "../services/charting/scope.js"
import { getScopedDailySeries } from "../services/charting/queries.js"
import { aggregateIncome, monthlyIncomeSeries } from "../services/charting/income.js"
import type { components } from "../generated/api-types.js"

type ChartIncomeData = components["schemas"]["ChartIncomeData"]
type ChartAllocationData = components["schemas"]["ChartAllocationData"]
type ChartPerformanceData = components["schemas"]["ChartPerformanceData"]
type ChartCashData = components["schemas"]["ChartCashData"]
type ChartCoverage = components["schemas"]["ChartCoverage"]
type ChartScopeDto = components["schemas"]["ChartScope"]

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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

  /** The common published generation across the scoped accounts (0 when none). */
  async function scopeGeneration(database: DB, accountIds: string[]): Promise<{ generation: number; complete: boolean }> {
    if (accountIds.length === 0) return { generation: 0, complete: false }
    const rows = await database
      .select({ generation: chartProjectionState.generation, status: chartProjectionState.status })
      .from(chartProjectionState)
      .where(inArray(chartProjectionState.portfolioId, accountIds))
    if (rows.length === 0) return { generation: 0, complete: false }
    const generation = Math.min(...rows.map((r) => r.generation))
    const complete = rows.every((r) => r.generation === generation && r.status === "complete")
    return { generation, complete }
  }

  const coverage = (generation: number, complete: boolean, status: ChartCoverage["status"]): ChartCoverage => ({
    generation,
    asOf: new Date().toISOString(),
    status,
    partial: !complete,
    currentPeriod: false,
    stale: false,
    missing: [],
  })

  // GET /api/portfolios/charting/income
  routes.get("/income", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const input = parseScope(c)
    if (hasMalformedIds(input)) return c.json({ error: "ValidationError", message: "malformed id" }, 422)
    const scope = await resolveChartScope(database, identity.id, input)
    const accountIds = await effectiveAccountIds(database, identity.id, scope)
    const { generation, complete } = await scopeGeneration(database, accountIds)
    const agg = await aggregateIncome(database, accountIds, generation, scope.from, scope.to)
    const body: ChartIncomeData = {
      currency: scope.currency,
      scope: toScopeDto(scope),
      coverage: coverage(generation, complete, accountIds.length === 0 ? "empty" : complete ? "complete" : "partial"),
      monthly: monthlyIncomeSeries(agg),
      cumulative: [],
      annual: agg.annual.map((b) => ({
        year: Number(b.period),
        dividends: b.dividends,
        interest: b.interest,
        options: b.options,
        total: b.total,
        priorYearTotal: null,
        yoyChangePercent: null,
      })),
      quarterly: agg.quarterly.map((b) => ({
        quarter: b.period,
        dividends: b.dividends,
        interest: b.interest,
        options: b.options,
        total: b.total,
        priorYearQuarterTotal: null,
        yoyChangePercent: null,
      })),
      dailyAverageByYear: [],
      monthlyAverageByYear: [],
      payerCoverage: [],
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
    const { generation, complete } = await scopeGeneration(database, accountIds)
    const series = await getScopedDailySeries(database, accountIds, generation, scope.from, scope.to)
    const body: ChartPerformanceData = {
      currency: scope.currency,
      scope: toScopeDto(scope),
      coverage: coverage(generation, complete, accountIds.length === 0 ? "empty" : complete ? "complete" : "partial"),
      series: series.points.map((p) => ({
        date: p.date,
        value: p.value,
        invested: p.netFlow,
        capitalBasis: p.remainingBasis,
        cumulativeIncome: p.income,
        cumulativeOptions: null,
        unpricedValue: null,
        carriedValue: null,
        twr: null,
        mwr: null,
        simple: null,
      })),
      quarterly: [],
      scatter: [],
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
    const { generation, complete } = await scopeGeneration(database, accountIds)

    const byAsset = new Map<string, number>()
    const bySector = new Map<string, number>()
    const byCurrency = new Map<string, number>()
    let total = 0
    if (accountIds.length > 0 && generation > 0) {
      const [maxRow] = await database
        .select({ d: max(chartPositionDaily.day) })
        .from(chartPositionDaily)
        .where(and(eq(chartPositionDaily.generation, generation), inArray(chartPositionDaily.portfolioId, accountIds)))
      const latestDay = maxRow?.d ?? null
      if (latestDay) {
        const rows = await database
          .select({
            positionId: chartPositionDaily.positionId,
            value: chartPositionDaily.value,
            assetType: positions.assetType,
            sector: positions.sector,
            instrumentCurrency: positions.instrumentCurrency,
          })
          .from(chartPositionDaily)
          .innerJoin(positions, eq(positions.id, chartPositionDaily.positionId))
          .where(and(eq(chartPositionDaily.generation, generation), eq(chartPositionDaily.day, latestDay), inArray(chartPositionDaily.portfolioId, accountIds)))
        for (const r of rows) {
          const v = Number(r.value)
          total += v
          const asset = r.assetType || "UNKNOWN"
          byAsset.set(asset, (byAsset.get(asset) ?? 0) + v)
          const sector = r.sector || "UNKNOWN"
          bySector.set(sector, (bySector.get(sector) ?? 0) + v)
          const ccy = r.instrumentCurrency || "USD"
          byCurrency.set(ccy, (byCurrency.get(ccy) ?? 0) + v)
        }
      }
    }
    const slice = (key: string, value: number) => ({ key, label: key, value, percent: total > 0 ? Math.round((value / total) * 1000) / 10 : null, sourceCurrency: null, sourceValue: null, unknown: key === "UNKNOWN" })
    const body: ChartAllocationData = {
      currency: scope.currency,
      scope: toScopeDto(scope),
      coverage: coverage(generation, complete, accountIds.length === 0 ? "empty" : complete ? "complete" : "partial"),
      byCurrency: [...byCurrency].map(([k, v]) => slice(k, v)),
      byAssetType: [...byAsset].map(([k, v]) => slice(k, v)),
      bySector: [...bySector].map(([k, v]) => slice(k, v)),
      byCategory: [],
      byLabel: [],
      byCostBasis: [],
      positions: [],
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
    const { generation, complete } = await scopeGeneration(database, accountIds)

    const annual = new Map<number, { contributions: number; withdrawals: number }>()
    if (accountIds.length > 0 && generation > 0) {
      const rows = await database
        .select({ year: sql<string>`extract(year from ${chartEventFacts.eventDate})`, kind: chartEventFacts.receiptKind, amount: chartEventFacts.amountBase })
        .from(chartEventFacts)
        .where(and(eq(chartEventFacts.generation, generation), inArray(chartEventFacts.portfolioId, accountIds)))
      for (const r of rows) {
        const y = Number(r.year)
        const cur = annual.get(y) ?? { contributions: 0, withdrawals: 0 }
        const amt = Number(r.amount)
        if (r.kind === "contribution") cur.contributions += amt
        else if (r.kind === "withdrawal") cur.withdrawals += Math.abs(amt)
        annual.set(y, cur)
      }
    }
    const body: ChartCashData = {
      currency: scope.currency,
      scope: toScopeDto(scope),
      coverage: coverage(generation, complete, accountIds.length === 0 ? "empty" : complete ? "complete" : "partial"),
      balanceHistory: [],
      annualContributions: [...annual]
        .sort((a, b) => a[0] - b[0])
        .map(([year, v]) => ({ year, contributions: v.contributions, withdrawals: v.withdrawals, net: v.contributions - v.withdrawals, partial: false })),
    }
    return c.json(body satisfies ChartCashData)
  })

  return routes
}