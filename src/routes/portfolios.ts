import { Hono } from "hono"
import { and, eq, sql, count as drizzleCount } from "drizzle-orm"
import { z } from "zod"
import { userIdentityMiddleware } from "../auth.js"
import { getDb, type DB } from "../db/index.js"
import {
  portfolios,
  positions,
  portfolioTransactions,
  shares,
  wallets,
} from "../db/schema.js"
import { preferredBaseCurrency } from "../services/preferences.js"
import { createTransactionRoutes } from "./portfolio-transactions.js"

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
    walletId: p.walletId,
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

    return c.json(serializePortfolio(created), 201)
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
      avgCostBasis: Number(pos.averageCostBasis),
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

    return c.json(serializePortfolio(updated))
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

  // ── Stubs for unimplemented endpoints (Phase F) ──────────────────────
  // Returns valid empty content so the SPA doesn't break before these are wired.

  routes.get("/total-metrics", (c) => {
    return c.json({
      totalValue: 0,
      totalCostBasis: 0,
      totalRealizedPnl: 0,
      totalUnrealizedPnl: 0,
      dayChange: 0,
      dayChangePercent: 0,
      totalDividends: 0,
      totalFees: 0,
    })
  })

  routes.get("/:id/summary-metrics", (c) => {
    return c.json({
      totalValue: 0,
      totalCostBasis: 0,
      unrealizedPnl: 0,
      unrealizedPnlPercent: 0,
      realizedPnl: 0,
      dayChange: 0,
      dayChangePercent: 0,
      weight: 0,
      positionCount: 0,
    })
  })

  routes.get("/:id/analytics", (c) => {
    return c.json({
      timeframe: c.req.query("timeframe") || "1Y",
      performance: [],
      benchmarks: [],
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

  // Shares stubs (Phase G will implement)
  routes.get("/shares", (c) => {
    return c.json([])
  })

  routes.post("/shares", (c) => {
    return c.json({ error: "NotImplemented", message: "shares not yet available" }, 501)
  })

  routes.delete("/shares/:shareId", (c) => {
    return c.body(null, 204)
  })

  // Public share view stub
  routes.get("/public/:shareId", (c) => {
    return c.json({ error: "NotFound", message: "share not found" }, 404)
  })

  return routes
}
