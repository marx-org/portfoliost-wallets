import { Hono } from "hono"
import { and, asc, count as drizzleCount, eq, sql } from "drizzle-orm"
import { z } from "zod"
import { userIdentityMiddleware } from "../auth.js"
import { getDb, type DB } from "../db/index.js"
import {
  portfolios,
  positions,
  portfolioTransactions,
  shares,
  valueSnapshots,
  wallets,
} from "../db/schema.js"
import { preferredBaseCurrency } from "../services/preferences.js"
import { refreshQuotes } from "../services/quotes.js"
import { runBackfill, getBackfillStatus, buildBenchmarkSeries } from "../services/backfill.js"
import { createTransactionRoutes } from "./portfolio-transactions.js"
import type { components } from "../generated/api-types.js"

type Portfolio = components["schemas"]["Portfolio"]
type PortfolioTotalMetrics = components["schemas"]["PortfolioTotalMetrics"]
type HeldStocks = components["schemas"]["HeldStocks"]
type PortfolioSummaryMetrics = components["schemas"]["PortfolioSummaryMetrics"]

const ISO_CURRENCY = /^[A-Za-z]{3}$/

// ── Request schemas ────────────────────────────────────────────────────

export const CreatePortfolioSchema = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  strategy: z.string().optional(),
  type: z.string().optional(),
  currency: z.string().regex(ISO_CURRENCY, "currency must be an ISO 4217 code"),
  baseCurrency: z.string().regex(ISO_CURRENCY).optional(),
  walletId: z.string().uuid().optional(),
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
  walletId: z.string().uuid().nullable().optional(),
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
    currency: p.currency,
    baseCurrency: p.baseCurrency,
    walletId: p.walletId ?? "",
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

/** Returns the ISO date cutoff for a timeframe query, or null for ALL. */
function timeframeCutoff(timeframe: string): string | null {
  const now = new Date()
  const months: Record<string, number> = { "6M": 6, "1Y": 12, "2Y": 24 }
  const m = months[timeframe.toUpperCase()]
  if (!m) return null
  const d = new Date(now)
  d.setUTCMonth(d.getUTCMonth() - m)
  return d.toISOString().slice(0, 10)
}

/** Group daily values by YYYY-MM; return monthly return % per month. */
function buildMonthlyReturns(
  series: Array<{ date: string; value: number }>,
): Array<{ month: string; returnPercent: number }> {
  const byMonth = new Map<string, { first: number; last: number }>()
  for (const { date, value } of series) {
    const month = date.slice(0, 7)
    const cur = byMonth.get(month)
    if (!cur) {
      byMonth.set(month, { first: value, last: value })
    } else {
      cur.last = value
    }
  }
  return [...byMonth.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, { first, last }]) => ({
      month,
      returnPercent: first > 0 ? ((last / first - 1) * 100) : 0,
    }))
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

    // Compute actual totals from positions + transactions rather than
    // stale denormalized columns.
    const portfolioBreakdown = await Promise.all(
      portfolioRows.map(async (p) => {
        const totalInvested = Number(p.totalInvested || 0)

        // Sum market values from open positions
        const [posAgg] = await database
          .select({
            totalMarketValue: sql<string>`COALESCE(SUM(CASE WHEN ${positions.isOpen} = true THEN COALESCE(${positions.marketValue}, ${positions.quantity} * ${positions.averageCostBasis}) ELSE 0 END), 0)`,
          })
          .from(positions)
          .where(sql`${positions.portfolioId} = ${p.id}`)

        const currentValue = Number(posAgg.totalMarketValue || 0)
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

    return c.json({
      totalValue,
      totalInvested,
      totalGainLoss,
      returnPercentage,
      baseCurrency: "USD",
      portfolioBreakdown,
      externalCapitalReturnPercent: returnPercentage,
      externalCapitalReturnAmount: totalGainLoss,
      externalCapitalBasis: totalInvested,
      externalCapitalBasisSource: "none",
      externalCapitalSuppressedReason: null,
      externalCapitalReturnBasisKind: "inception",
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

    // Validate walletId belongs to this user
    if (parsed.data.walletId) {
      const [w] = await database
        .select()
        .from(wallets)
        .where(
          and(
            sql`${wallets.id} = ${parsed.data.walletId}`,
            sql`${wallets.userId} = ${identity.id}`,
          ),
        )
      if (!w) {
        return c.json({ error: "ValidationError", message: "wallet not found" }, 422)
      }
    }

    const [created] = await database
      .insert(portfolios)
      .values({
        userId: identity.id,
        name: parsed.data.name,
        description: parsed.data.description ?? null,
        strategy: parsed.data.strategy ?? "GROWTH",
        type: parsed.data.type ?? "regular",
        currency: parsed.data.currency.toUpperCase(),
        baseCurrency: defaultBase.toUpperCase(),
        walletId: parsed.data.walletId ?? null,
        isPublic: parsed.data.isPublic ?? false,
        isMarginEnabled: parsed.data.isMarginEnabled ?? false,
        marginRate: parsed.data.marginRate != null ? String(parsed.data.marginRate) : null,
        maintenanceMarginRate:
          parsed.data.maintenanceMarginRate != null ? String(parsed.data.maintenanceMarginRate) : null,
      })
      .returning()

    return c.json(serializePortfolio(created) satisfies Portfolio, 201)
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
    if (data.walletId !== undefined) updates.walletId = data.walletId
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

    const totalValue = posRows.reduce(
      (s, p) => s + (p.marketValue != null ? Number(p.marketValue) : Number(p.quantity) * Number(p.averageCostBasis)),
      0,
    )
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

    return c.json({
      totalValue: Math.round(totalValue * 100) / 100,
      totalCostBasis: Math.round(totalCostBasis * 100) / 100,
      unrealizedPnl: Math.round(unrealizedPnl * 100) / 100,
      unrealizedPnlPercent: Math.round(unrealizedPnlPercent * 100) / 100,
      realizedPnl: Math.round(realizedPnl * 100) / 100,
      dayChange: Math.round(dayChange * 100) / 100,
      dayChangePercent: Math.round(dayChangePercent * 100) / 100,
      weight: 0,
      positionCount: posRows.length,
    })
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
      .select({ id: portfolios.id })
      .from(portfolios)
      .where(and(eq(portfolios.id, id), eq(portfolios.userId, identity.id)))
      .limit(1)
    if (!pf) return c.json({ error: "NotFound" }, 404)

    // Check how many snapshot rows exist
    const [{ n }] = await database
      .select({ n: drizzleCount() })
      .from(valueSnapshots)
      .where(eq(valueSnapshots.portfolioId, id))

    if (n < 2) {
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
      .select({ snapshotDate: valueSnapshots.snapshotDate, value: valueSnapshots.value, invested: valueSnapshots.invested })
      .from(valueSnapshots)
      .where(cutoff
        ? and(eq(valueSnapshots.portfolioId, id), sql`${valueSnapshots.snapshotDate} >= ${cutoff}`)
        : eq(valueSnapshots.portfolioId, id))
      .orderBy(asc(valueSnapshots.snapshotDate))

    const timeSeries = rows.map((r) => ({ date: r.snapshotDate, value: Number(r.value) }))
    const lastRow = rows[rows.length - 1]
    const firstRow = rows[0]
    const totalValue = Number(lastRow?.value ?? 0)
    const totalInvested = Number(lastRow?.invested ?? 0)
    const totalReturn = totalValue - totalInvested
    const totalReturnPercent = totalInvested > 0 ? (totalReturn / totalInvested) * 100 : 0

    // Monthly returns: group by YYYY-MM, (last_value / first_value - 1) × 100
    const monthlyReturns = buildMonthlyReturns(rows.map((r) => ({ date: r.snapshotDate, value: Number(r.value) })))

    // Benchmarks: normalize requested tickers to an indexed return line aligned
    // with the portfolio snapshot window (D46/D48). Unknown tickers are dropped.
    let benchmarks: Array<NonNullable<components["schemas"]["PortfolioAnalytics"]["benchmarks"]>[number]> = []
    if (benchmarkSymbols.length > 0) {
      const from = firstRow?.snapshotDate
      const to = lastRow?.snapshotDate
      const authToken = c.req.header("Authorization") ?? ""
      const series = await Promise.all(
        benchmarkSymbols.map((sym) => buildBenchmarkSeries(sym, from, to, authToken, sym)),
      )
      benchmarks = series
        .filter((s): s is NonNullable<typeof s> => s !== null)
        .map((s) => ({ symbol: s.symbol, name: s.name, timeSeries: s.timeSeries, returnPercent: s.returnPercent, volatility: s.volatility }))
    }

    return c.json({
      timeframe,
      backfillStatus: "complete",
      performance: { timeSeries, totalValue, totalInvested, totalReturn, totalReturnPercent, monthlyReturns },
      benchmarks,
    })
  })

  routes.get("/:id/dividends", (c) => {
    return c.json({ totalDividends: 0, count: 0, items: [] })
  })

  routes.get("/:id/calendar", (c) => {
    return c.json({ events: [] })
  })

  routes.get("/:id/news", (c) => {
    return c.json({ articles: [], total: 0 })
  })

  routes.get("/:id/compare", (c) => {
    return c.json({ portfolios: [], timeframe: "1Y" })
  })

  routes.get("/:id/risk-metrics", (c) => {
    return c.json({
      volatility: 0,
      sharpeRatio: 0,
      maxDrawdown: 0,
      beta: 0,
      alpha: 0,
      correlation: {},
    })
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
        currency: portfolio.currency,
      },
    })
  })

  return routes
}
