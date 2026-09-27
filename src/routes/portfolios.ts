import { Hono } from "hono"
import { and, asc, count as drizzleCount, desc, eq, sql } from "drizzle-orm"
import { z } from "zod"
import { userIdentityMiddleware } from "../auth.js"
import { getDb, type DB } from "../db/index.js"
import {
  portfolios,
  positions,
  portfolioTransactions,
  shares,
  valueSnapshots,
} from "../db/schema.js"
import { preferredBaseCurrency } from "../services/preferences.js"
import { refreshQuotes } from "../services/quotes.js"
import { getPortfolioNews } from "../services/portfolioNews.js"
import { getPortfolioCalendar } from "../services/portfolioCalendar.js"
import { runBackfill, runBackfillRecent, getBackfillStatus, buildBenchmarkSeries, forcePortfolioRecalc, hasBackfillableHistory } from "../services/backfill.js"
import { cashBalances, dailyExternalFlows } from "../services/cashLedger.js"
import { buildPortfolioCash } from "./portfolio-cash.js"
import { computeRiskMetrics } from "../services/riskMetrics.js"
import { resolveRates, fxTo } from "../services/instruments-fx.js"
import { sumSnapshotsByDateForwardFilled, buildMergedPerformance } from "../services/mergedAnalytics.js"
import { createTransactionRoutes } from "./portfolio-transactions.js"
import type { components } from "../generated/api-types.js"

type Portfolio = components["schemas"]["Portfolio"]
type PortfolioTotalMetrics = components["schemas"]["PortfolioTotalMetrics"]
type HeldStocks = components["schemas"]["HeldStocks"]
type PortfolioSummaryMetrics = components["schemas"]["PortfolioSummaryMetrics"]

const ISO_CURRENCY = /^[A-Za-z]{3}$/

const round2 = (n: number) => Math.round(n * 100) / 100

// ── Request schemas ────────────────────────────────────────────────────

export const CreatePortfolioSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  strategy: z.string().optional(),
  type: z.string().optional(),
  baseCurrency: z.string().regex(ISO_CURRENCY).optional(),
  isPublic: z.boolean().optional(),
  isMarginEnabled: z.boolean().optional(),
  marginRate: z.number().optional(),
  maintenanceMarginRate: z.number().optional(),
})

export const UpdatePortfolioSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional(),
  strategy: z.string().optional(),
  type: z.string().optional(),
  baseCurrency: z.string().regex(ISO_CURRENCY).optional(),
  isPublic: z.boolean().optional(),
  isMarginEnabled: z.boolean().optional(),
  marginRate: z.number().nullable().optional(),
  maintenanceMarginRate: z.number().nullable().optional(),
})

// ── Serializers ────────────────────────────────────────────────────────

function serializePortfolio(p: typeof portfolios.$inferSelect) {
  return {
    id: p.id,
    userId: p.userId,
    name: p.name,
    description: p.description,
    strategy: p.strategy,
    type: p.type,
    baseCurrency: p.baseCurrency,
    totalInvested: Number(p.totalInvested),
    currentValue: Number(p.currentValue),
    isPublic: p.isPublic,
    isMarginEnabled: p.isMarginEnabled,
    marginRate: p.marginRate != null ? Number(p.marginRate) : null,
    maintenanceMarginRate: p.maintenanceMarginRate != null ? Number(p.maintenanceMarginRate) : null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  }
}

// ── Helpers ────────────────────────────────────────────────────────────

async function computeMetrics(db: DB, portfolioId: string) {
  const [posCounts] = await db
    .select({
      total: drizzleCount(),
      open: sql<number>`count(*) filter (where ${positions.isOpen} = true)::int`,
    })
    .from(positions)
    .where(sql`${positions.portfolioId} = ${portfolioId}`)

  const [txSums] = await db
    .select({
      realizedGainLoss: sql<string>`coalesce(sum(${portfolioTransactions.realizedGainLoss}) filter (where ${portfolioTransactions.type} = 'SELL'), 0)`,
      income: sql<string>`coalesce(sum(${portfolioTransactions.totalAmount}) filter (where ${portfolioTransactions.type} = 'DIVIDEND'), 0)`,
    })
    .from(portfolioTransactions)
    .where(sql`${portfolioTransactions.portfolioId} = ${portfolioId}`)

  const realized = Number(txSums?.realizedGainLoss ?? 0)
  const income = Number(txSums?.income ?? 0)
  const positionCount = posCounts?.total ?? 0
  const openPositions = posCounts?.open ?? 0

  return {
    positionCount,
    openPositions,
    closedPositions: positionCount - openPositions,
    realizedGainLoss: realized,
    unrealizedGainLoss: 0, // will be enriched by quote adapter in Phase E
    totalInvested: 0, // pulled from portfolio row
    income,
    returnBasis: 0,
    totalReturn: 0,
    totalReturnAmount: 0,
    dayChange: 0,
    dayChangeAmount: 0,
    dayChangeDate: null as string | null,
    asOf: new Date().toISOString(),
    externalCapitalReturnPercent: 0,
    externalCapitalReturnAmount: 0,
    externalCapitalBasis: 0,
    externalCapitalBasisSource: "externalFlows",
    externalCapitalSuppressedReason: null,
    externalCapitalReturnBasisKind: "inception",
  }
}

// ── Analytics helpers ───────────────────────────────────────────────────

/** Returns the ISO date cutoff for a timeframe query, or null for ALL/unknown. */
export function timeframeCutoff(timeframe: string, now = new Date()): string | null {
  const months: Record<string, number> = { "1M": 1, "3M": 3, "6M": 6, "1Y": 12, "2Y": 24 }
  const days: Record<string, number> = { "1W": 7 }
  const upper = timeframe.toUpperCase()
  const m = months[upper]
  if (m) {
    const d = new Date(now)
    d.setUTCMonth(d.getUTCMonth() - m)
    return d.toISOString().slice(0, 10)
  }
  const d = days[upper]
  if (d) {
    const dt = new Date(now)
    dt.setUTCDate(dt.getUTCDate() - d)
    return dt.toISOString().slice(0, 10)
  }
  return null
}

/** Group daily values by YYYY-MM; return monthly return % per month. */
function buildMonthlyReturns(
  series: Array<{ date: string; cumulativeTwr: number | null }>,
): Array<{ month: string; returnPercent: number }> {
  // Month-over-month growth of the already flow-adjusted TWR index, so a
  // deposit inflating the raw value does not inflate the monthly return.
  const byMonth = new Map<string, number>()
  for (const { date, cumulativeTwr } of series) {
    const month = date.slice(0, 7)
    if (cumulativeTwr == null) continue
    byMonth.set(month, cumulativeTwr)
  }
  let prevTwr = 100
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, lastTwr]) => {
      const returnPercent = prevTwr > 0 ? Math.round(((lastTwr / prevTwr - 1) * 100) * 100) / 100 : 0
      prevTwr = lastTwr
      return { month, returnPercent }
    })
}

// ── Routes ─────────────────────────────────────────────────────────────

export function createPortfolioRoutes(db?: DB) {
  const routes = new Hono()
  routes.use("*", userIdentityMiddleware)

  const getDbInstance = () => db ?? getDb()

  // GET /api/portfolios — list with metrics
  routes.get("/", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()

    const rows = await database
      .select()
      .from(portfolios)
      .where(sql`${portfolios.userId} = ${identity.id}`)
      .orderBy(sql`${portfolios.createdAt} DESC`)

    const result = await Promise.all(
      rows.map(async (p) => {
        const metrics = await computeMetrics(database, p.id)
        metrics.totalInvested = Number(p.totalInvested)
        metrics.totalReturn =
          Number(p.currentValue) > 0 && metrics.totalInvested > 0
            ? ((Number(p.currentValue) - metrics.totalInvested) / metrics.totalInvested) * 100
            : 0
        metrics.totalReturnAmount = Number(p.currentValue) - metrics.totalInvested
        metrics.returnBasis = metrics.totalInvested

        return {
          ...serializePortfolio(p),
          metrics,
          positionCount: metrics.positionCount,
          performance: {
            returnPercentage: metrics.totalReturn,
            totalGainLoss: metrics.totalReturnAmount,
            dailyChange: 0,
            dailyChangePercentage: 0,
          },
          cash: await buildPortfolioCash(database, c.req.header("Authorization") ?? "", p),
        }
      }),
    )

    return c.json(result)
  })

  // GET /api/portfolios/light — lightweight selector payload
  routes.get("/light", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()

    const rows = await database
      .select()
      .from(portfolios)
      .where(sql`${portfolios.userId} = ${identity.id}`)
      .orderBy(sql`${portfolios.createdAt} DESC`)

    const result = await Promise.all(
      rows.map(async (p) => {
        const [cnt] = await database
          .select({ count: drizzleCount() })
          .from(positions)
          .where(sql`${positions.portfolioId} = ${p.id}`)

        return {
          ...serializePortfolio(p),
          positionCount: cnt?.count ?? 0,
        }
      }),
    )

    return c.json(result)
  })

  // ── G1: GET /total-metrics — aggregate metrics across all portfolios ─

  routes.get("/total-metrics", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()

    const portfolioRows = await database
      .select()
      .from(portfolios)
      .where(sql`${portfolios.userId} = ${identity.id}`)

    // plan §48.6e B5 — each portfolio's value/invested is denominated in its
    // own base_currency (each position in its instrument currency). Convert
    // to the aggregate baseCurrency (USD) via instruments' FX BEFORE summing
    // — never add foreign-currency values raw. Unresolvable pairs degrade
    // 1:1 (plan §48.3).
    const toBase = await fxTo(c.req.header("Authorization") ?? "", "USD")

    // Compute actual totals from positions + transactions rather than
    // stale denormalized columns.
    const portfolioBreakdown = await Promise.all(
      portfolioRows.map(async (p) => {
        const totalInvested =
          Number(p.totalInvested || 0) * (await toBase(p.baseCurrency ?? "USD"))

        // Sum market values from open positions (each in its instrument ccy)
        const posRows = await database
          .select({
            marketValue: positions.marketValue,
            quantity: positions.quantity,
            averageCostBasis: positions.averageCostBasis,
            instrumentCurrency: positions.instrumentCurrency,
          })
          .from(positions)
          .where(and(sql`${positions.portfolioId} = ${p.id}`, eq(positions.isOpen, true)))

        let currentValue = 0
        for (const r of posRows) {
          const mv =
            r.marketValue != null
              ? Number(r.marketValue)
              : Number(r.quantity) * Number(r.averageCostBasis)
          currentValue += mv * (await toBase(r.instrumentCurrency ?? "USD"))
        }

        const gainLoss = currentValue - totalInvested
        const returnPct = totalInvested > 0 ? (gainLoss / totalInvested) * 100 : 0
        return {
          id: p.id,
          name: p.name,
          totalValue: Math.round(currentValue * 100) / 100,
          totalInvested: Math.round(totalInvested * 100) / 100,
          returnPercentage: Math.round(returnPct * 100) / 100,
          weight: 0, // filled in after totals computed
        }
      }),
    )

    const totalValue = portfolioBreakdown.reduce((s, p) => s + p.totalValue, 0)
    const totalInvested = portfolioBreakdown.reduce((s, p) => s + p.totalInvested, 0)
    const totalGainLoss = totalValue - totalInvested
    const returnPercentage = totalInvested > 0 ? (totalGainLoss / totalInvested) * 100 : 0
    // back-fill weights now that totalValue is known
    for (const p of portfolioBreakdown) {
      p.weight = totalValue > 0 ? Math.round((p.totalValue / totalValue) * 10000) / 100 : 0
    }

    // §62 — aggregate cash across all portfolios (per-currency Σ, base-converted)
    const cashByCcy = new Map<string, number>()
    for (const p of portfolioRows) {
      const bal = await cashBalances(database, c.req.header("Authorization") ?? "", p.id)
      for (const [ccy, amt] of bal) cashByCcy.set(ccy, (cashByCcy.get(ccy) ?? 0) + amt)
    }
    let totalCash = 0
    const cashConverted = new Map<string, number>()
    for (const [ccy, balance] of cashByCcy) cashConverted.set(ccy, balance * (await toBase(ccy)))
    for (const conv of cashConverted.values()) totalCash += conv
    totalCash = Math.round(totalCash * 100) / 100
    const cashBreakdown = [...cashByCcy.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([currency, balance]) => ({
        currency,
        balance: Math.round(balance * 1e8) / 1e8,
        weight: totalCash !== 0 ? Math.round((cashConverted.get(currency)! / totalCash) * 10000) / 100 : 0,
      }))

    return c.json({
      totalValue,
      totalInvested,
      totalGainLoss,
      returnPercentage,
      // plan §48.6e B5 — the aggregate denomination every portfolio value
      // above has been converted into (the SPA treats it as the FX source).
      baseCurrency: "USD",
      portfolioBreakdown,
      externalCapitalReturnPercent: returnPercentage,
      externalCapitalReturnAmount: totalGainLoss,
      externalCapitalBasis: totalInvested,
      externalCapitalBasisSource: "none",
      externalCapitalSuppressedReason: null,
      externalCapitalReturnBasisKind: "inception",
      totalCash,
      cashBreakdown,
    } satisfies PortfolioTotalMetrics)
  })

  // ── G1: GET /held-stocks — aggregated open position view ─────────────

  routes.get("/held-stocks", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()

    const posRows = await database
      .select()
      .from(positions)
      .where(
        and(
          sql`${positions.userId} = ${identity.id}`,
          eq(positions.isOpen, true),
        ),
      )

    const bySymbol = new Map<string, {
      symbol: string
      companyName: string
      quantity: number
      totalCostBasis: number
      marketValue: number
      assetType: string
      instrumentCurrency: string
    }>()

    for (const p of posRows) {
      const existing = bySymbol.get(p.symbol)
      const qty = Number(p.quantity)
      const costBasis = Number(p.averageCostBasis) * qty
      const mktVal = p.marketValue != null ? Number(p.marketValue) : costBasis
      if (existing) {
        existing.quantity += qty
        existing.totalCostBasis += costBasis
        existing.marketValue += mktVal
      } else {
        bySymbol.set(p.symbol, {
          symbol: p.symbol,
          companyName: p.companyName || p.symbol,
          quantity: qty,
          totalCostBasis: costBasis,
          marketValue: mktVal,
          assetType: p.assetType || "STOCK",
          instrumentCurrency: p.instrumentCurrency || "USD",
        })
      }
    }

    const stocks = [...bySymbol.values()]
      .map((s) => ({
        symbol: s.symbol,
        name: s.companyName,
        logo: null as string | null,
        currentPrice: s.quantity > 0 ? Math.round((s.marketValue / s.quantity) * 100) / 100 : 0,
        changePercent: 0,
        assetType: s.assetType,
        totalQuantity: s.quantity,
        totalValue: Math.round(s.marketValue * 100) / 100,
      }))
      .sort((a, b) => b.totalValue - a.totalValue)

    return c.json({ stocks, totalCount: stocks.length } satisfies HeldStocks)
  })

  // ── G3: Shares CRUD ──────────────────────────────────────────────────
  // Must be before /:id routes so Hono matches as static path.

  routes.get("/shares", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()

    const rows = await database
      .select()
      .from(shares)
      .where(sql`${shares.userId} = ${identity.id}`)
      .orderBy(sql`${shares.createdAt} DESC`)

    const enriched = await Promise.all(
      rows.map(async (s) => {
        const [p] = await database
          .select({ name: portfolios.name })
          .from(portfolios)
          .where(eq(portfolios.id, s.portfolioId))
        return {
          ...s,
          portfolioName: p?.name ?? "",
        }
      }),
    )

    return c.json(enriched)
  })

  routes.post("/shares", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const body = await c.req.json().catch(() => ({}))
    const { portfolioId, displayName = "" } = body

    if (!portfolioId) {
      return c.json({ error: "ValidationError", message: "portfolioId is required" }, 422)
    }

    const [portfolio] = await database
      .select()
      .from(portfolios)
      .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, identity.id)))

    if (!portfolio) {
      return c.json({ error: "NotFound", message: "Portfolio not found" }, 404)
    }

    const [cnt] = await database
      .select({ count: drizzleCount() })
      .from(shares)
      .where(eq(shares.userId, identity.id))

    if (cnt && cnt.count >= 10) {
      return c.json({ error: "LimitReached", message: "You can have up to 10 active shares" }, 422)
    }

    const defaultPrivacy = {
      benchmarks: ["SPY"],
      showValues: true,
      displayName,
      showHoldings: true,
      showPositions: true,
      positionsToHide: [],
      showMonthlyReturns: true,
      showAssetAllocation: true,
      showPerformanceChart: true,
      showPositionAllocation: true,
      showSectorDistribution: true,
      showTransactionHistory: true,
    }

    const [created] = await database
      .insert(shares)
      .values({
        userId: identity.id,
        portfolioId,
        displayName,
        privacySettings: defaultPrivacy,
      })
      .returning()

    return c.json({
      ...created,
      portfolioName: portfolio.name,
      privacySettings: defaultPrivacy,
    }, 201)
  })

  routes.delete("/shares/:shareId", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const shareId = c.req.param("shareId") as string

    const [share] = await database
      .select()
      .from(shares)
      .where(and(eq(shares.id, shareId), eq(shares.userId, identity.id)))

    if (!share) {
      return c.json({ error: "NotFound", message: "Share not found" }, 404)
    }

    await database.delete(shares).where(eq(shares.id, shareId))
    return c.body(null, 204)
  })

  // POST /api/portfolios — create
  routes.post("/", async (c) => {
    const parsed = CreatePortfolioSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: "ValidationError", message: parsed.error.issues[0]?.message }, 422)
    }

    const identity = c.get("userIdentity")
    const database = getDbInstance()

    // D21b: explicit baseCurrency wins; otherwise from user prefs
    const forwardedHeaders: Record<string, string> = {}
    for (const k of ["authorization", "x-user-id", "x-user-email"]) {
      const v = c.req.header(k)
      if (v) forwardedHeaders[k] = v
    }
    const defaultBase =
      parsed.data.baseCurrency ?? (await preferredBaseCurrency(forwardedHeaders))

    try {
      const [created] = await database
        .insert(portfolios)
        .values({
          userId: identity.id,
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          strategy: parsed.data.strategy ?? "GROWTH",
          type: parsed.data.type ?? "regular",
          baseCurrency: defaultBase.toUpperCase(),
          isPublic: parsed.data.isPublic ?? false,
          isMarginEnabled: parsed.data.isMarginEnabled ?? false,
          marginRate: parsed.data.marginRate != null ? String(parsed.data.marginRate) : null,
          maintenanceMarginRate:
            parsed.data.maintenanceMarginRate != null ? String(parsed.data.maintenanceMarginRate) : null,
        })
        .returning()
      return c.json(serializePortfolio(created) satisfies Portfolio, 201)
    } catch (err) {
      // uq_portfolios_user_name (import bootstrap natural key) — duplicate name
      if ((err as { cause?: { code?: string } }).cause?.code === "23505") {
        return c.json(
          { error: "Conflict", message: `A portfolio named "${parsed.data.name}" already exists` },
          409,
        )
      }
      throw err
    }
  })

  // GET /api/portfolios/merged — combined all-portfolios performance (§46,
  // §41 follow-up 1). Sums every portfolio's value_snapshots into USD (the
  // currency the SPA assumes as source via total-metrics.baseCurrency).
  // Registered ABOVE "/:id" so "merged" is not parsed as a portfolio id.
  routes.get("/merged", async (c) => {
    const identity = c.get("userIdentity")
    const timeframe = c.req.query("timeframe") || "ALL"
    const database = getDbInstance()

    const portfolioRows = await database
      .select({ id: portfolios.id, baseCurrency: portfolios.baseCurrency })
      .from(portfolios)
      .where(sql`${portfolios.userId} = ${identity.id}`)

    // Backfill gate: any portfolio with < 2 snapshots AND a backfillable
    // history (a BUY/SELL on or before yesterday) keeps the merged series
    // pending (mirror /:id/analytics fire-and-forget path). Portfolios whose
    // trades all start today can never produce snapshots — they are complete,
    // not pending (§48.4).
    const pendingIds: string[] = []
    for (const p of portfolioRows) {
      const [{ n }] = await database
        .select({ n: drizzleCount() })
        .from(valueSnapshots)
        .where(eq(valueSnapshots.portfolioId, p.id))
      if (n < 2 && (await hasBackfillableHistory(database, p.id))) pendingIds.push(p.id)
    }
    if (pendingIds.length > 0) {
      const authToken = c.req.header("Authorization") ?? ""
      for (const id of pendingIds) {
        const status = await getBackfillStatus(database, id)
        if (status !== "pending") {
          void runBackfill(database, id, authToken).catch(() => undefined)
        }
      }
      return c.json({
        timeframe,
        backfillStatus: "pending",
        performance: {
          timeSeries: [],
          totalValue: 0,
          totalInvested: 0,
          totalReturn: 0,
          totalReturnPercent: 0,
          monthlyReturns: [],
        },
        benchmarks: [],
      } satisfies components["schemas"]["PortfolioAnalytics"])
    }

    const cutoff = timeframeCutoff(timeframe)
    const rows = await database
      .select({
        portfolioId: valueSnapshots.portfolioId,
        baseCurrency: portfolios.baseCurrency,
        snapshotDate: valueSnapshots.snapshotDate,
        value: valueSnapshots.value,
        invested: valueSnapshots.invested,
      })
      .from(valueSnapshots)
      .innerJoin(portfolios, eq(valueSnapshots.portfolioId, portfolios.id))
      .where(
        cutoff
          ? and(
              sql`${portfolios.userId} = ${identity.id}`,
              sql`${valueSnapshots.snapshotDate} >= ${cutoff}`,
            )
          : sql`${portfolios.userId} = ${identity.id}`,
      )
      .orderBy(asc(valueSnapshots.snapshotDate))

    const rateMap = await resolveRates(
      c.req.header("Authorization") ?? "",
      "USD",
      rows.map((r) => r.baseCurrency),
    )
    const series = sumSnapshotsByDateForwardFilled(
      rows.map((r) => ({
        portfolioId: r.portfolioId,
        baseCurrency: r.baseCurrency,
        snapshotDate: r.snapshotDate,
        value: Number(r.value),
        invested: Number(r.invested),
      })),
      (from) => rateMap.get(from.toUpperCase()) ?? null,
      "USD",
    )

    return c.json({
      timeframe,
      backfillStatus: "complete",
      performance: buildMergedPerformance(series),
      benchmarks: [],
    } satisfies components["schemas"]["PortfolioAnalytics"])
  })

  // GET /api/portfolios/:id — detail with metrics
  routes.get("/:id", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const id = c.req.param("id")

    const [p] = await database
      .select()
      .from(portfolios)
      .where(and(sql`${portfolios.id} = ${id}`, sql`${portfolios.userId} = ${identity.id}`))

    if (!p) {
      return c.json({ error: "NotFound", message: "portfolio not found" }, 404)
    }

    const metrics = await computeMetrics(database, p.id)
    metrics.totalInvested = Number(p.totalInvested)
    metrics.totalReturn =
      Number(p.currentValue) > 0 && metrics.totalInvested > 0
        ? ((Number(p.currentValue) - metrics.totalInvested) / metrics.totalInvested) * 100
        : 0
    metrics.totalReturnAmount = Number(p.currentValue) - metrics.totalInvested
    metrics.returnBasis = metrics.totalInvested

    // D58: refresh live quotes before building position summaries
    await refreshQuotes(database, identity.id, p.id, c.req.header("Authorization") ?? "")

    // Fetch position summaries
    const posRows = await database
      .select()
      .from(positions)
      .where(sql`${positions.portfolioId} = ${id}`)

    const posSummaries = posRows.map((pos) => ({
      id: pos.id,
      portfolioId: pos.portfolioId,
      symbol: pos.symbol,
      companyName: pos.companyName,
      assetType: pos.assetType,
      quantity: Number(pos.quantity),
      averageCostBasis: Number(pos.averageCostBasis),
      totalCostBasis: Number(pos.quantity) * Number(pos.averageCostBasis),
      currentPrice: pos.currentPrice != null ? Number(pos.currentPrice) : null,
      marketValue: pos.marketValue != null ? Number(pos.marketValue) : null,
      unrealizedGainLoss: pos.unrealizedGainLoss != null ? Number(pos.unrealizedGainLoss) : null,
      percentageChange:
        pos.currentPrice != null && Number(pos.averageCostBasis) > 0
          ? ((Number(pos.currentPrice) - Number(pos.averageCostBasis)) / Number(pos.averageCostBasis)) * 100
          : null,
      percentOfPortfolio:
        pos.marketValue != null && Number(p.currentValue) > 0
          ? (Number(pos.marketValue) / Number(p.currentValue)) * 100
          : null,
      dayChange: pos.dayChange != null ? Number(pos.dayChange) : null,
      dayChangePercent: pos.dayChangePercent != null ? Number(pos.dayChangePercent) : null,
      sector: pos.sector,
      industry: pos.industry,
      country: pos.country,
      purchaseCurrency: pos.purchaseCurrency,
      instrumentCurrency: pos.instrumentCurrency,
      isOpen: pos.isOpen,
      openedAt: pos.openedAt.toISOString(),
      closedAt: pos.closedAt?.toISOString() ?? null,
    }))

    return c.json({
      ...serializePortfolio(p),
      metrics,
      positions: posSummaries,
      positionCount: posSummaries.length,
      cash: await buildPortfolioCash(database, c.req.header("Authorization") ?? "", p),
    })
  })

  // PATCH /api/portfolios/:id — update settings
  routes.patch("/:id", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const id = c.req.param("id")

    const parsed = UpdatePortfolioSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: "ValidationError", message: parsed.error.issues[0]?.message }, 422)
    }

    const [existing] = await database
      .select()
      .from(portfolios)
      .where(and(sql`${portfolios.id} = ${id}`, sql`${portfolios.userId} = ${identity.id}`))

    if (!existing) {
      return c.json({ error: "NotFound", message: "portfolio not found" }, 404)
    }

    const data = parsed.data
    const updates: Record<string, unknown> = { updatedAt: new Date() }
    if (data.name !== undefined) updates.name = data.name
    if (data.description !== undefined) updates.description = data.description
    if (data.strategy !== undefined) updates.strategy = data.strategy
    if (data.type !== undefined) updates.type = data.type
    if (data.baseCurrency !== undefined) updates.baseCurrency = data.baseCurrency.toUpperCase()
    if (data.isPublic !== undefined) updates.isPublic = data.isPublic
    if (data.isMarginEnabled !== undefined) updates.isMarginEnabled = data.isMarginEnabled
    if (data.marginRate !== undefined) updates.marginRate = data.marginRate != null ? String(data.marginRate) : null
    if (data.maintenanceMarginRate !== undefined)
      updates.maintenanceMarginRate =
        data.maintenanceMarginRate != null ? String(data.maintenanceMarginRate) : null

    const [updated] = await database
      .update(portfolios)
      .set(updates)
      .where(sql`${portfolios.id} = ${id}`)
      .returning()

    return c.json(serializePortfolio(updated) satisfies Portfolio)
  })

  // DELETE /api/portfolios/:id — guarded (D59): 409 while tx or open positions exist
  routes.delete("/:id", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const id = c.req.param("id")

    const [existing] = await database
      .select()
      .from(portfolios)
      .where(and(sql`${portfolios.id} = ${id}`, sql`${portfolios.userId} = ${identity.id}`))

    if (!existing) {
      return c.json({ error: "NotFound", message: "portfolio not found" }, 404)
    }

    // D59: guarded delete — 409 while transactions or open positions exist
    const [txCount] = await database
      .select({ count: drizzleCount() })
      .from(portfolioTransactions)
      .where(sql`${portfolioTransactions.portfolioId} = ${id}`)
    if (txCount && txCount.count > 0) {
      return c.json({ error: "Conflict", message: "portfolio has transactions" }, 409)
    }

    const [posCount] = await database
      .select({ count: drizzleCount() })
      .from(positions)
      .where(
        and(sql`${positions.portfolioId} = ${id}`, sql`${positions.isOpen} = true`),
      )
    if (posCount && posCount.count > 0) {
      return c.json({ error: "Conflict", message: "portfolio has open positions" }, 409)
    }

    await database.delete(portfolios).where(sql`${portfolios.id} = ${id}`)
    return c.body(null, 204)
  })

  // Mount transaction + position routes (Phase C)
  routes.route("/", createTransactionRoutes(getDbInstance()))

  // ── G2: GET /:id/summary-metrics — per-portfolio computed metrics ────

  routes.get("/:id/summary-metrics", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const portfolioId = c.req.param("id") as string

    const [portfolio] = await database
      .select()
      .from(portfolios)
      .where(and(sql`${portfolios.id} = ${portfolioId}`, sql`${portfolios.userId} = ${identity.id}`))

    if (!portfolio) return c.json({ error: "NotFound", message: "Portfolio not found" }, 404)

    const posRows = await database
      .select()
      .from(positions)
      .where(
        and(
          eq(positions.userId, identity.id),
          eq(positions.portfolioId, portfolioId),
          eq(positions.isOpen, true),
        ),
      )

    const positionValue = posRows.reduce(
      (s, p) => s + (p.marketValue != null ? Number(p.marketValue) : Number(p.quantity) * Number(p.averageCostBasis)),
      0,
    )
    // §62.4 — totalValue includes the current cash total (base currency);
    // positionValue stays positions-only.
    const cashBal = await cashBalances(database, c.req.header("Authorization") ?? "", portfolioId)
    const sumToBase = await fxTo(c.req.header("Authorization") ?? "", portfolio.baseCurrency ?? "USD")
    let cashTotal = 0
    for (const [ccy, bal] of cashBal) cashTotal += bal * (await sumToBase(ccy, 1))
    const totalValue = positionValue + cashTotal
    const totalCostBasis = posRows.reduce(
      (s, p) => s + Number(p.quantity) * Number(p.averageCostBasis),
      0,
    )
    const unrealizedPnl = posRows.reduce(
      (s, p) => s + (p.unrealizedGainLoss != null ? Number(p.unrealizedGainLoss) : 0),
      0,
    )
    const unrealizedPnlPercent = totalCostBasis > 0 ? (unrealizedPnl / totalCostBasis) * 100 : 0
    const dayChange = posRows.reduce(
      (s, p) => s + (p.dayChange != null ? Number(p.dayChange) : 0),
      0,
    )
    const dayChangePercent = totalValue > 0 ? (dayChange / totalValue) * 100 : 0

    // Realized PnL from SELL transactions
    const sellTxs = await database
      .select()
      .from(portfolioTransactions)
      .where(
        and(
          eq(portfolioTransactions.userId, identity.id),
          eq(portfolioTransactions.portfolioId, portfolioId),
          eq(portfolioTransactions.type, "SELL"),
        ),
      )
    const realizedPnl = sellTxs.reduce(
      (s, t) => s + (t.realizedGainLoss != null ? Number(t.realizedGainLoss) : 0),
      0,
    )

    // Dividend income
    const [divRow] = await database
      .select({
        income: sql<string>`coalesce(sum(${portfolioTransactions.totalAmount}) filter (where ${portfolioTransactions.type} = 'DIVIDEND'), 0)`,
      })
      .from(portfolioTransactions)
      .where(
        and(
          eq(portfolioTransactions.userId, identity.id),
          eq(portfolioTransactions.portfolioId, portfolioId),
        ),
      )
    const cumulativeDividends = Number(divRow?.income ?? 0)

    const totalInvested = Number(portfolio.totalInvested ?? 0)
    const simpleReturnPercent = totalInvested > 0
      ? Math.round(((totalValue - totalInvested) / totalInvested * 100) * 100) / 100
      : 0

    return c.json({
      totalValue: Math.round(totalValue * 100) / 100,
      totalInvested: Math.round(totalInvested * 100) / 100,
      costBasis: Math.round(totalCostBasis * 100) / 100,
      positionValue: Math.round(positionValue * 100) / 100,
      simpleReturnPercent,
      investmentReturnPercent: simpleReturnPercent,
      currencyImpactPercent: 0,
      unrealizedGainLoss: Math.round(unrealizedPnl * 100) / 100,
      realizedGain: Math.round(realizedPnl * 100) / 100,
      cumulativeDividends: Math.round(cumulativeDividends * 100) / 100,
      totalDividends: Math.round(cumulativeDividends * 100) / 100,
      dayChangeAmount: Math.round(dayChange * 100) / 100,
      dayChangePercent: Math.round(dayChangePercent * 100) / 100,
      dayChangeDate: new Date().toISOString(),
      weight: 0,
      positionCount: posRows.length,
    } satisfies components["schemas"]["PortfolioSummaryMetrics"] & { weight: number; positionCount: number })
  })

  routes.post("/:id/recompute", async (c) => {
    const identity = c.get("userIdentity")
    const id = c.req.param("id")
    const database = getDbInstance()

    // Verify portfolio belongs to user
    const [pf] = await database
      .select({ id: portfolios.id })
      .from(portfolios)
      .where(and(eq(portfolios.id, id), eq(portfolios.userId, identity.id)))
      .limit(1)
    if (!pf) return c.json({ error: "NotFound", message: "Portfolio not found" }, 404)

    // Two modes (2026-09-27) over one shared core (computeSnapshotBatch):
    // default = FULL delete+rebuild (manual recompute after data fixes — no
    // stale rows can survive); ?mode=upsert = ADDITIVE (upsert computed days,
    // never delete) — what the scheduled refresh job uses, so a mid-day pass
    // that fails can't erase a day it didn't recompute.
    if (c.req.query("mode") === "upsert") {
      // additive + through today (the job's mode — re-values the last 2 days)
      void runBackfillRecent(database, id, c.req.header("Authorization") ?? "").catch(() => undefined)
    } else {
      void forcePortfolioRecalc(database, id, c.req.header("Authorization") ?? "").catch(() => undefined)
    }
    return c.json({ backfillStatus: "pending" } satisfies components["schemas"]["BackfillRecomputeResponse"])
  })

  routes.get("/:id/analytics", async (c) => {
    const identity = c.get("userIdentity")
    const id = c.req.param("id")
    const timeframe = c.req.query("timeframe") || "1Y"
    const benchmarkCalcType = c.req.query("benchmarkCalcType") || "timeWeighted"
    const benchmarkParam = c.req.query("benchmarks")
    const benchmarkSymbols = benchmarkParam
      ? benchmarkParam.split(",").map((s) => s.trim()).filter(Boolean)
      : []
    const database = getDbInstance()

    // Verify portfolio belongs to user
    const [pf] = await database
      .select({ id: portfolios.id, baseCurrency: portfolios.baseCurrency })
      .from(portfolios)
      .where(and(eq(portfolios.id, id), eq(portfolios.userId, identity.id)))
      .limit(1)
    if (!pf) return c.json({ error: "NotFound" }, 404)

    // Check how many snapshot rows exist
    const [{ n }] = await database
      .select({ n: drizzleCount() })
      .from(valueSnapshots)
      .where(eq(valueSnapshots.portfolioId, id))

    if (n < 2 && (await hasBackfillableHistory(database, id))) {
      const status = await getBackfillStatus(database, id)
      if (status !== "pending") {
        // Trigger backfill fire-and-forget
        void runBackfill(database, id, c.req.header("Authorization") ?? "").catch(() => undefined)
      }
      return c.json({
        timeframe,
        backfillStatus: "pending",
        performance: { timeSeries: [], totalValue: 0, totalInvested: 0, totalReturn: 0, totalReturnPercent: 0, monthlyReturns: [] },
        benchmarks: [],
      })
    }

    // Filter by timeframe
    const cutoff = timeframeCutoff(timeframe)
    const rows = await database
      .select({
        snapshotDate: valueSnapshots.snapshotDate,
        value: valueSnapshots.value,
        invested: valueSnapshots.invested,
        cumulativeTwr: valueSnapshots.cumulativeTwr,
        cumulativeMwr: valueSnapshots.cumulativeMwr,
        cumulativeSimple: valueSnapshots.cumulativeSimple,
      })
      .from(valueSnapshots)
      .where(cutoff
        ? and(eq(valueSnapshots.portfolioId, id), sql`${valueSnapshots.snapshotDate} >= ${cutoff}`)
        : eq(valueSnapshots.portfolioId, id))
      .orderBy(asc(valueSnapshots.snapshotDate))

    const timeSeries = rows.map((r) => ({
      date: r.snapshotDate,
      value: Number(r.value),
      cumulativeTwr: r.cumulativeTwr !== null ? Number(r.cumulativeTwr) : undefined,
      cumulativeMwr: r.cumulativeMwr !== null ? Number(r.cumulativeMwr) : undefined,
      cumulativeSimple: r.cumulativeSimple !== null ? Number(r.cumulativeSimple) : undefined,
    }))
    const lastRow = rows[rows.length - 1]
    const firstRow = rows[0]
    const totalValue = Number(lastRow?.value ?? 0)
    const totalInvested = Number(lastRow?.invested ?? 0)
    const totalReturn = totalValue - totalInvested
    const totalReturnPercent = totalInvested > 0 ? (totalReturn / totalInvested) * 100 : 0

    // Monthly returns: month-over-month growth of the flow-adjusted TWR index
    const monthlyReturns = buildMonthlyReturns(rows.map((r) => ({ date: r.snapshotDate, cumulativeTwr: r.cumulativeTwr === null ? null : Number(r.cumulativeTwr) })))

    // Benchmarks: mirror the portfolio's cash flows into each requested ticker
    // (D50) — BUYs invest cash in the benchmark, SELLs release it, seed = the
    // portfolio's invested capital at the window start. Unknown tickers dropped.
    let benchmarks: Array<NonNullable<components["schemas"]["PortfolioAnalytics"]["benchmarks"]>[number]> = []
    if (benchmarkSymbols.length > 0 && firstRow && lastRow) {
      const from = firstRow.snapshotDate
      const to = lastRow.snapshotDate
      const baseCurrency = pf.baseCurrency ?? "USD"
      const flows = await dailyExternalFlows(database, c.req.header("Authorization") ?? "", id, from, to, baseCurrency)
      const seedInvested = Number(firstRow.invested ?? 0)
      const calcType = (["moneyWeighted", "timeWeighted", "simple"] as const).includes(
        benchmarkCalcType as "moneyWeighted" | "timeWeighted" | "simple",
      )
        ? (benchmarkCalcType as "moneyWeighted" | "timeWeighted" | "simple")
        : "timeWeighted"
      const authToken = c.req.header("Authorization") ?? ""
      const series = await Promise.all(
        benchmarkSymbols.map((sym) =>
          buildBenchmarkSeries(sym, from, to, authToken, sym, {
            db: database,
            portfolioId: id,
            baseCurrency,
            flows,
            seedInvested,
            calcType,
          }),
        ),
      )
      benchmarks = series
        .filter((s): s is NonNullable<typeof s> => s !== null)
        .map((s) => ({ symbol: s.symbol, name: s.name, timeSeries: s.timeSeries, returnPercent: s.returnPercent, volatility: s.volatility }))
    }

    return c.json({
      timeframe,
      backfillStatus: "complete",
      performance: {
        timeSeries,
        totalValue,
        totalInvested,
        totalReturn,
        totalReturnPercent,
        monthlyReturns,
        // Scalar return values derived from the last pre-computed cumulative index point
        timeWeightedReturn: timeSeries.length > 0 && timeSeries[timeSeries.length - 1].cumulativeTwr !== undefined
          ? Math.round(((timeSeries[timeSeries.length - 1].cumulativeTwr! - 100)) * 100) / 100
          : null,
        moneyWeightedReturn: timeSeries.length > 0 && timeSeries[timeSeries.length - 1].cumulativeMwr !== undefined
          ? Math.round(((timeSeries[timeSeries.length - 1].cumulativeMwr! - 100)) * 100) / 100
          : null,
        simpleReturnPercent: timeSeries.length > 0 && timeSeries[timeSeries.length - 1].cumulativeSimple !== undefined
          ? Math.round(((timeSeries[timeSeries.length - 1].cumulativeSimple! - 100)) * 100) / 100
          : null,
      },
      benchmarks,
    })
  })

  routes.get("/:id/dividends", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const id = c.req.param("id")

    const [pf] = await database
      .select({ id: portfolios.id })
      .from(portfolios)
      .where(and(eq(portfolios.id, id), eq(portfolios.userId, identity.id)))
      .limit(1)
    if (!pf) return c.json({ error: "NotFound", message: "Portfolio not found" }, 404)

    // §49.3: aggregate the portfolio's REAL DIVIDEND transactions (gross =
    // quantity × price, amount = net = gross − taxes), newest first.
    const rows = await database
      .select()
      .from(portfolioTransactions)
      .where(
        and(
          eq(portfolioTransactions.portfolioId, id),
          eq(portfolioTransactions.userId, identity.id),
          eq(portfolioTransactions.type, "DIVIDEND"),
        ),
      )
      .orderBy(desc(portfolioTransactions.executedAt))

    const items = rows.map((r) => {
      const quantity = Number(r.quantity)
      const gross = round2(quantity * Number(r.price))
      const taxes = r.taxes != null ? Number(r.taxes) : null
      const amount = Math.round((gross - (taxes ?? 0)) * 1e8) / 1e8
      const exchangeRate = r.exchangeRate != null ? Number(r.exchangeRate) : null
      return {
        symbol: r.instrumentSymbol,
        instrumentName: r.instrumentName,
        date: r.executedAt?.toISOString?.() ?? r.executedAt,
        quantity,
        gross,
        taxes,
        amount,
        currency: r.currency,
        exchangeRate,
        convertedAmount: exchangeRate != null ? round2(amount * exchangeRate) : null,
        notes: r.notes ?? null,
      }
    })

    const count = items.length
    const totalDividends = round2(items.reduce((s, it) => s + (it.convertedAmount ?? it.amount), 0))

    return c.json({ totalDividends, count, items })
  })

  routes.get("/:id/calendar", async (c) => {
    const identity = c.get("userIdentity")
    const id = c.req.param("id")
    const holdings = await getPortfolioCalendar(
      getDbInstance(),
      id,
      identity.id,
      c.req.header("Authorization") ?? "",
    )
    return c.json({ holdings } satisfies components["schemas"]["CalendarData"])
  })

  routes.get("/:id/news", async (c) => {
    const identity = c.get("userIdentity")
    const id = c.req.param("id")
    const limitParam = Number(c.req.query("limit"))
    const limit = Number.isFinite(limitParam) && limitParam > 0 ? Math.min(Math.floor(limitParam), 100) : 50
    const out = await getPortfolioNews(
      getDbInstance(),
      id,
      identity.id,
      c.req.header("Authorization") ?? "",
      limit,
    )
    return c.json(out satisfies components["schemas"]["NewsArticleList"])
  })

  routes.get("/:id/compare", (c) => {
    return c.json({ portfolios: [], timeframe: "1Y" })
  })

  routes.get("/:id/risk-metrics", async (c) => {
    const identity = c.get("userIdentity")
    const id = c.req.param("id")
    const timeframe = c.req.query("timeframe") || "1Y"
    const database = getDbInstance()

    // Verify ownership
    const [pf] = await database
      .select({ id: portfolios.id })
      .from(portfolios)
      .where(and(eq(portfolios.id, id), eq(portfolios.userId, identity.id)))
      .limit(1)
    if (!pf) return c.json({ error: "NotFound" }, 404)

    // Fetch snapshot series filtered by timeframe
    const cutoff = timeframeCutoff(timeframe)
    const rows = await database
      .select({
        snapshotDate: valueSnapshots.snapshotDate,
        value: valueSnapshots.value,
        cumulativeTwr: valueSnapshots.cumulativeTwr,
        cumulativeMwr: valueSnapshots.cumulativeMwr,
      })
      .from(valueSnapshots)
      .where(
        cutoff
          ? and(eq(valueSnapshots.portfolioId, id), sql`${valueSnapshots.snapshotDate} >= ${cutoff}`)
          : eq(valueSnapshots.portfolioId, id),
      )
      .orderBy(asc(valueSnapshots.snapshotDate))

    const values = rows.map((r) => Number(r.value))
    const dates = rows.map((r) => r.snapshotDate)

    // Use pre-computed MWR index as the money-weighted return scalar (last point − 100)
    const lastMwr = rows.length > 0 ? rows[rows.length - 1].cumulativeMwr : null
    const mwrPercent = lastMwr !== null ? Math.round((Number(lastMwr) - 100) * 100) / 100 : null

    const metrics = computeRiskMetrics(values, dates)

    return c.json({
      sharpeRatio: metrics.sharpeRatio,
      sortinoRatio: metrics.sortinoRatio,
      calmarRatio: metrics.calmarRatio,
      volatility: metrics.volatility,
      maxDrawdown: metrics.maxDrawdown,
      winRate: metrics.winRate,
      periodReturnPercent: metrics.periodReturnPercent,
      annualizedReturn: metrics.annualizedReturn,
      annualizedReturnWithheldReason: metrics.annualizedReturnWithheldReason,
      moneyWeightedReturn: mwrPercent,
      moneyWeightedReturnWithheldReason: null,
    } satisfies components["schemas"]["PortfolioRiskMetrics"])
  })

  return routes
}

// ── G3: Public share view (auth-exempt) ──────────────────────────────────
// Exported separately to mount without auth middleware.

export function createPublicShareRoutes(db?: DB) {
  const routes = new Hono()

  routes.get("/:shareId", async (c) => {
    const database = db ?? getDb()
    const shareId = c.req.param("shareId") as string

    const [share] = await database!
      .select()
      .from(shares)
      .where(eq(shares.id, shareId))

    if (!share) {
      return c.json({ error: "NotFound", message: "Share not found" }, 404)
    }

    // Increment view count
    await database!
      .update(shares)
      .set({ viewCount: sql`${shares.viewCount} + 1`, updatedAt: new Date() })
      .where(eq(shares.id, shareId))

    const [portfolio] = await database!
      .select()
      .from(portfolios)
      .where(eq(portfolios.id, share.portfolioId))

    if (!portfolio) {
      return c.json({ error: "NotFound", message: "Portfolio not found" }, 404)
    }

    const privacy = share.privacySettings as Record<string, unknown>

    return c.json({
      shareId: share.id,
      displayName: share.displayName || portfolio.name,
      privacySettings: privacy,
      portfolio: {
        name: portfolio.name,
        description: portfolio.description,
        strategy: portfolio.strategy,
        currency: portfolio.baseCurrency,
      },
    })
  })

  return routes
}
