import { Hono, type Context } from "hono"
import { and, eq, sql, asc, desc } from "drizzle-orm"
import { z } from "zod"
import { userIdentityMiddleware } from "../auth.js"
import { type DB } from "../db/index.js"
import {
  portfolios,
  positions,
  portfolioTransactions,
  walletTransactions,
  wallets,
} from "../db/schema.js"
import { resolveFeeFx } from "../services/fee-fx.js"
import { refreshQuotes } from "../services/quotes.js"

const scale8 = (n: number) => n.toFixed(8)
const round2 = (n: number) => Math.round(n * 100) / 100

const TransactionCreateSchema = z.object({
  type: z.enum(["BUY", "SELL", "DIVIDEND"]),
  symbol: z.string().min(1).max(20),
  instrumentName: z.string().optional(),
  quantity: z.number().positive(),
  price: z.number().positive(),
  currency: z.string().length(3),
  instrumentCurrency: z.string().length(3).optional(),
  assetType: z.string().optional(),
  sector: z.string().optional(),
  country: z.string().optional(),
  fees: z.number().nonnegative().optional(),
  feesType: z.enum(["fixed", "pct"]).optional(),
  feeCurrency: z.string().length(3).optional(),
  rateSource: z.enum(["automatic", "manual"]).optional(),
  exchangeRate: z.number().positive().optional(),
  feeRateSource: z.enum(["automatic", "manual"]).optional(),
  feeExchangeRate: z.number().positive().optional(),
  walletId: z.string().uuid().optional(),
  positionId: z.string().uuid().optional(),
  executedAt: z.string().optional(),
  isGift: z.boolean().optional(),
})

const TransactionPatchSchema = z.object({
  quantity: z.number().positive().optional(),
  price: z.number().positive().optional(),
  fees: z.number().nonnegative().optional(),
  feesType: z.enum(["fixed", "pct"]).optional(),
  feeCurrency: z.string().length(3).optional(),
  rateSource: z.enum(["automatic", "manual"]).optional(),
  exchangeRate: z.number().positive().optional(),
  feeRateSource: z.enum(["automatic", "manual"]).optional(),
  feeExchangeRate: z.number().positive().optional(),
  executedAt: z.string().optional(),
})

async function loadPortfolio(db: DB, id: string, userId: string) {
  const [row] = await db
    .select()
    .from(portfolios)
    .where(and(eq(portfolios.id, id), eq(portfolios.userId, userId)))
  return row
}

async function recomputePortfolioTotals(
  tx: DB,
  userId: string,
  portfolioId: string,
) {
  const [agg] = await tx
    .select({
      totalInvested: sql<string>`COALESCE(SUM(CASE WHEN ${portfolioTransactions.type} = 'BUY' THEN ${portfolioTransactions.totalAmount} ELSE 0 END), 0)::text`,
    })
    .from(portfolioTransactions)
    .where(
      and(
        eq(portfolioTransactions.userId, userId),
        eq(portfolioTransactions.portfolioId, portfolioId),
      ),
    )

  await tx
    .update(portfolios)
    .set({
      totalInvested: agg.totalInvested,
      updatedAt: new Date(),
    })
    .where(eq(portfolios.id, portfolioId))
}

async function upsertPositionOnBuy(
  tx: DB,
  userId: string,
  portfolioId: string,
  body: {
    symbol: string
    instrumentName?: string
    quantity: number
    price: number
    currency: string
    instrumentCurrency?: string
    assetType?: string
    sector?: string
    country?: string
    positionId?: string
    walletId?: string
    feesSettled: number
    contractSize?: number
    direction?: "LONG" | "SHORT"
    optionType?: "CALL" | "PUT"
    strikePrice?: number
    expirationDate?: string
    openedAt?: Date
  },
) {
  const symbol = body.symbol.toUpperCase()
  const instCcy = (body.instrumentCurrency ?? body.currency).toUpperCase()

  let pos: typeof positions.$inferSelect | undefined

  if (body.positionId) {
    const [existing] = await tx
      .select()
      .from(positions)
      .where(
        and(
          eq(positions.id, body.positionId),
          eq(positions.userId, userId),
          eq(positions.portfolioId, portfolioId),
        ),
      )
    pos = existing
  }

  if (!pos) {
    const [existing] = await tx
      .select()
      .from(positions)
      .where(
        and(
          eq(positions.userId, userId),
          eq(positions.portfolioId, portfolioId),
          eq(positions.symbol, symbol),
          eq(positions.isOpen, true),
        ),
      )
    pos = existing
  }

  const costOfTrade = body.quantity * body.price

  if (pos) {
    const oldQty = Number(pos.quantity)
    const oldCost = Number(pos.averageCostBasis)
    const newQty = oldQty + body.quantity
    const newAvgCost = round2((oldQty * oldCost + costOfTrade) / newQty)

    const [updated] = await tx
      .update(positions)
      .set({
        quantity: String(newQty),
        averageCostBasis: String(newAvgCost),
        companyName: body.instrumentName ?? pos.companyName,
        instrumentCurrency: instCcy,
        assetType: body.assetType ?? pos.assetType,
        sector: body.sector ?? pos.sector,
        country: body.country ?? pos.country,
        walletId: body.walletId ?? pos.walletId,
        fees: String(Number(pos.fees ?? "0") + body.feesSettled),
        updatedAt: new Date(),
      })
      .where(eq(positions.id, pos.id))
      .returning()
    return updated
  }

  const [created] = await tx
    .insert(positions)
    .values({
      userId,
      portfolioId,
      symbol,
      companyName: body.instrumentName ?? null,
      quantity: String(body.quantity),
      averageCostBasis: String(body.price),
      instrumentCurrency: instCcy,
      assetType: body.assetType ?? "STOCK",
      contractSize: body.contractSize != null ? String(body.contractSize) : null,
      direction: body.direction ?? null,
      optionType: body.optionType ?? null,
      strikePrice: body.strikePrice != null ? String(body.strikePrice) : null,
      expirationDate: body.expirationDate ?? null,
      sector: body.sector ?? "Other",
      country: body.country ?? "Other",
      walletId: body.walletId ?? null,
      fees: String(body.feesSettled),
      isOpen: true,
      openedAt: body.openedAt ?? new Date(),
    })
    .returning()
  return created
}

async function processSell(
  tx: DB,
  userId: string,
  portfolioId: string,
  body: {
    symbol: string
    quantity: number
    price: number
    currency: string
    positionId?: string
    feesSettled: number
  },
) {
  const symbol = body.symbol.toUpperCase()

  let pos: typeof positions.$inferSelect | undefined
  if (body.positionId) {
    const [existing] = await tx
      .select()
      .from(positions)
      .where(
        and(
          eq(positions.id, body.positionId),
          eq(positions.userId, userId),
          eq(positions.portfolioId, portfolioId),
        ),
      )
    pos = existing
  }
  if (!pos) {
    const [existing] = await tx
      .select()
      .from(positions)
      .where(
        and(
          eq(positions.userId, userId),
          eq(positions.portfolioId, portfolioId),
          eq(positions.symbol, symbol),
          eq(positions.isOpen, true),
        ),
      )
    pos = existing
  }

  if (!pos) {
    return { error: "No open position found for this symbol" }
  }

  const oldQty = Number(pos.quantity)
  if (body.quantity > oldQty + 1e-9) {
    return { error: `Insufficient quantity: have ${oldQty}, selling ${body.quantity}` }
  }

  const avgCost = Number(pos.averageCostBasis)
  const realizedGainLoss = round2((body.price - avgCost) * body.quantity - body.feesSettled)
  const newQty = Math.round((oldQty - body.quantity) * 1e8) / 1e8

  const updateData: Record<string, unknown> = {
    quantity: String(newQty),
    fees: String(Number(pos.fees ?? "0") + body.feesSettled),
    updatedAt: new Date(),
  }
  if (newQty < 1e-9) {
    updateData.isOpen = false
    updateData.closedAt = new Date()
  }

  const [updated] = await tx
    .update(positions)
    .set(updateData)
    .where(eq(positions.id, pos.id))
    .returning()

  return { position: updated, realizedGainLoss }
}

async function createWalletLink(
  tx: DB,
  userId: string,
  body: {
    walletId?: string
    symbol: string
    type: "BUY" | "SELL" | "DIVIDEND"
    quantity: number
    price: number
    currency: string
    feesSettled: number
    exchangeRate: number
    transactionId: string
    portfolioId: string
  },
) {
  if (!body.walletId) return null

  const [wallet] = await tx
    .select()
    .from(wallets)
    .where(and(eq(wallets.id, body.walletId), eq(wallets.userId, userId)))
  if (!wallet) return null

  const symbol = body.symbol.toUpperCase()
  const reference = `PORTFOLIO_${body.type}_${symbol}_${body.transactionId.slice(0, 8)}`
  const amount = body.type === "BUY"
    ? -(body.quantity * body.price + body.feesSettled)
    : body.type === "SELL"
      ? body.quantity * body.price - body.feesSettled
      : body.quantity * body.price

  const [fresh] = await tx
    .select()
    .from(wallets)
    .where(eq(wallets.id, wallet.id))
    .for("update")

  const newBalance = Math.round((Number(fresh.balance) + amount) * 1e8) / 1e8
  const newAvailable = Math.round((Number(fresh.availableBalance) + amount) * 1e8) / 1e8

  if (newAvailable < -1e-9) {
    return { error: "Insufficient wallet funds" }
  }

  await tx
    .update(wallets)
    .set({ balance: scale8(newBalance), availableBalance: scale8(newAvailable), updatedAt: new Date() })
    .where(eq(wallets.id, wallet.id))

  const [wt] = await tx
    .insert(walletTransactions)
    .values({
      userId,
      walletId: wallet.id,
      type: "INVEST",
      amount: scale8(amount),
      currency: fresh.currency,
      reference,
      portfolioId: body.portfolioId,
      executedAt: new Date(),
    })
    .returning()

  return { walletTx: wt, newBalance, newAvailable }
}

const PositionCreateSchema = z.object({
  symbol: z.string().min(1).max(20),
  quantity: z.number().positive(),
  price: z.number().positive().optional(),
  averageCostBasis: z.number().positive().optional(),
  currency: z.string().length(3).optional(),
  instrumentCurrency: z.string().length(3).optional(),
  assetType: z.string().optional(),
  contractSize: z.number().optional(),
  direction: z.enum(["LONG", "SHORT"]).optional(),
  optionType: z.enum(["CALL", "PUT"]).optional(),
  strikePrice: z.number().optional(),
  expirationDate: z.string().optional(),
  sector: z.string().optional(),
  country: z.string().optional(),
  instrumentName: z.string().optional(),
  walletId: z.string().uuid().optional(),
  fees: z.number().nonnegative().optional(),
  feesType: z.enum(["fixed", "pct"]).optional(),
  feeCurrency: z.string().length(3).optional(),
  rateSource: z.enum(["automatic", "manual"]).optional(),
  exchangeRate: z.number().positive().optional(),
  feeRateSource: z.enum(["automatic", "manual"]).optional(),
  feeExchangeRate: z.number().positive().optional(),
  openedAt: z.string().optional(),
  executedAt: z.string().optional(),
})

type PositionRow = typeof positions.$inferSelect

/** Example service wire shape for a single position (GET list / create / edit / remove). */
function positionWire(
  p: PositionRow,
  portfolio: { id: string; baseCurrency: string },
  totalValue: number,
) {
  const avg = Number(p.averageCostBasis)
  const qty = Number(p.quantity)
  const price = p.currentPrice != null ? Number(p.currentPrice) : null
  const mv = p.marketValue != null ? Number(p.marketValue) : price != null ? price * qty : null
  const pct = price != null && avg > 0 ? ((price - avg) / avg) * 100 : null
  return {
    id: p.id,
    portfolioId: portfolio.id,
    symbol: p.symbol,
    companyName: p.companyName,
    assetType: p.assetType,
    contractSize: p.contractSize != null ? Number(p.contractSize) : null,
    direction: p.direction,
    optionType: p.optionType,
    strikePrice: p.strikePrice != null ? Number(p.strikePrice) : null,
    expirationDate: p.expirationDate,
    purchaseCurrency: p.purchaseCurrency,
    instrumentCurrency: p.instrumentCurrency,
    quantity: qty,
    averageCostBasis: avg,
    totalCostBasis: avg * qty,
    realizedGainLoss: 0,
    sector: p.sector,
    industry: p.industry,
    country: p.country,
    isOpen: p.isOpen,
    openedAt: p.openedAt,
    closedAt: p.closedAt,
    currentPrice: price,
    priceSource: p.priceSource,
    priceAsOf: p.priceAsOf,
    marketValue: mv,
    unrealizedGainLoss: p.unrealizedGainLoss != null ? Number(p.unrealizedGainLoss) : null,
    percentageChange: pct != null ? round2(pct) : null,
    percentOfPortfolio: mv != null && totalValue > 0 ? round2((mv / totalValue) * 100) : null,
    dayChange: p.dayChange != null ? Number(p.dayChange) : null,
    dayChangePercent: p.dayChangePercent != null ? Number(p.dayChangePercent) : null,
    preMarketPrice: null,
    preMarketChangePercent: null,
    afterHoursPrice: null,
    afterHoursChangePercent: null,
    metrics: null,
    displayCurrency: portfolio.baseCurrency,
  }
}

async function openPositionsValue(db: DB, userId: string, portfolioId: string) {
  const rows = await db
    .select()
    .from(positions)
    .where(
      and(
        eq(positions.userId, userId),
        eq(positions.portfolioId, portfolioId),
        eq(positions.isOpen, true),
      ),
    )
  return rows.reduce(
    (sum, p) => sum + (p.marketValue != null ? Number(p.marketValue) : Number(p.quantity) * Number(p.averageCostBasis)),
    0,
  )
}

export function createTransactionRoutes(db?: DB) {
  const routes = new Hono()
  routes.use("*", userIdentityMiddleware)

  const getDb = () => db

  // POST /:id/transactions — create BUY / SELL / DIVIDEND
  routes.post("/:id/transactions", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDb()!
    const portfolioId = c.req.param("id") as string

    const portfolio = await loadPortfolio(database, portfolioId, identity.id)
    if (!portfolio) return c.json({ error: "NotFound", message: "Portfolio not found" }, 404)

    const parsed = TransactionCreateSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: "ValidationError", message: parsed.error.issues[0]?.message }, 422)
    }
    const body = parsed.data
    const symbol = body.symbol.toUpperCase()
    const txCcy = body.currency.toUpperCase()
    const instCcy = (body.instrumentCurrency ?? body.currency).toUpperCase()
    const notional = body.quantity * body.price

    const fx = await resolveFeeFx(database, body, txCcy, { notional })
    if (!fx.ok) return c.json({ error: "ValidationError", message: fx.message }, 422)

    const executedAt = body.executedAt ? new Date(body.executedAt) : new Date()

    const result = await database.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(portfolioTransactions)
        .values({
          userId: identity.id,
          portfolioId,
          positionId: body.positionId ?? null,
          walletId: body.walletId ?? null,
          type: body.type,
          instrumentSymbol: symbol,
          instrumentName: body.instrumentName ?? null,
          sector: body.sector ?? null,
          country: body.country ?? null,
          quantity: String(body.quantity),
          price: String(body.price),
          currency: txCcy,
          instrumentCurrency: instCcy,
          assetType: body.assetType ?? "STOCK",
          fees: body.fees != null ? String(body.fees) : null,
          feesType: fx.fields.feesType,
          feeCurrency: fx.fields.feeCurrency,
          feesSettled: String(fx.feesSettled),
          totalAmount: String(round2(notional)),
          exchangeRate: String(fx.fields.exchangeRate),
          rateSource: fx.fields.rateSource,
          feeRateSource: fx.fields.feeRateSource,
          feeExchangeRate: fx.fields.feeExchangeRate != null ? String(fx.fields.feeExchangeRate) : null,
          convertedTotalAmount: String(round2(notional * fx.fields.exchangeRate)),
          convertedPrice: String(round2(body.price * fx.fields.exchangeRate)),
          convertedFees: String(round2(fx.feesSettled * fx.fields.exchangeRate)),
          displayCurrency: "USD",
          isGift: body.isGift ?? false,
          synthesizedOpeningLot: false,
          executedAt,
        })
        .returning()

      let position = null
      let realizedGainLoss = null

      if (body.type === "BUY") {
        position = await upsertPositionOnBuy(tx, identity.id, portfolioId, {
          ...body,
          symbol,
          feesSettled: fx.feesSettled,
        })
        // back-link positionId on the transaction
        if (position) {
          await tx
            .update(portfolioTransactions)
            .set({ positionId: position.id })
            .where(eq(portfolioTransactions.id, inserted.id))
          inserted.positionId = position.id
        }
      } else if (body.type === "SELL") {
        const sellResult = await processSell(tx, identity.id, portfolioId, {
          symbol,
          quantity: body.quantity,
          price: body.price,
          currency: txCcy,
          positionId: body.positionId,
          feesSettled: fx.feesSettled,
        })
        if ("error" in sellResult) return { error: sellResult.error }
        position = sellResult.position
        realizedGainLoss = sellResult.realizedGainLoss

        await tx
          .update(portfolioTransactions)
          .set({ realizedGainLoss: String(realizedGainLoss) })
          .where(eq(portfolioTransactions.id, inserted.id))
      }

      await recomputePortfolioTotals(tx, identity.id, portfolioId)

      let walletLink = null
      if (body.walletId) {
        walletLink = await createWalletLink(tx, identity.id, {
          ...body,
          symbol,
          feesSettled: fx.feesSettled,
          exchangeRate: fx.fields.exchangeRate,
          transactionId: inserted.id,
          portfolioId,
        })
        if (walletLink && "error" in walletLink) return { error: walletLink.error }
      }

      const convertedFees =
        body.fees != null
          ? round2(
              (fx.fields.feesType === "pct" ? notional * (body.fees ?? 0) / 100 : (body.fees ?? 0))
              * (fx.fields.feeCurrency === txCcy ? 1 : fx.fields.feeExchangeRate ?? 1)
              * fx.fields.exchangeRate,
            )
          : 0

      return {
        transaction: {
          ...inserted,
          quantity: body.quantity,
          price: body.price,
          fees: body.fees ?? 0,
          totalAmount: round2(notional),
          feesSettled: fx.feesSettled,
          exchangeRate: fx.fields.exchangeRate,
          rateSource: fx.fields.rateSource,
          convertedTotalAmount: round2(notional * fx.fields.exchangeRate),
          convertedPrice: round2(body.price * fx.fields.exchangeRate),
          convertedFees,
          realizedGainLoss,
        },
        position,
        walletLink,
      }
    })

    if ("error" in result) {
      return c.json({ error: "ValidationError", message: result.error }, 422)
    }

    return c.json({ ...result.transaction, position: result.position ?? null }, 201)
  })

  // PATCH /:id/transactions/:txId — update transaction + recompute
  routes.patch("/:id/transactions/:txId", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDb()!
    const portfolioId = c.req.param("id") as string
    const txId = c.req.param("txId") as string

    const portfolio = await loadPortfolio(database, portfolioId, identity.id)
    if (!portfolio) return c.json({ error: "NotFound", message: "Portfolio not found" }, 404)

    const parsed = TransactionPatchSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: "ValidationError", message: parsed.error.issues[0]?.message }, 422)
    }

    const existing = await database
      .select()
      .from(portfolioTransactions)
      .where(
        and(
          eq(portfolioTransactions.id, txId),
          eq(portfolioTransactions.userId, identity.id),
          eq(portfolioTransactions.portfolioId, portfolioId),
        ),
      )
      .then((rows) => rows[0])

    if (!existing) return c.json({ error: "NotFound", message: "Transaction not found" }, 404)

    const body = parsed.data
    const merged = { ...existing, ...body }
    const quantity = body.quantity ?? Number(existing.quantity)
    const price = body.price ?? Number(existing.price)
    const fees = body.fees ?? (existing.fees != null ? Number(existing.fees) : 0)
    const txCcy = existing.currency.toUpperCase()
    const notional = quantity * price

    const fx = await resolveFeeFx(database, merged, txCcy, { notional })
    if (!fx.ok) return c.json({ error: "ValidationError", message: fx.message }, 422)

    const result = await database.transaction(async (tx) => {
      const [updated] = await tx
        .update(portfolioTransactions)
        .set({
          quantity: String(quantity),
          price: String(price),
          fees: fees > 0 ? String(fees) : null,
          feesType: fx.fields.feesType,
          feeCurrency: fx.fields.feeCurrency,
          feesSettled: String(fx.feesSettled),
          totalAmount: String(round2(notional)),
          exchangeRate: String(fx.fields.exchangeRate),
          rateSource: fx.fields.rateSource,
          feeRateSource: fx.fields.feeRateSource,
          feeExchangeRate: fx.fields.feeExchangeRate != null ? String(fx.fields.feeExchangeRate) : null,
          convertedTotalAmount: String(round2(notional * fx.fields.exchangeRate)),
          convertedPrice: String(round2(price * fx.fields.exchangeRate)),
          convertedFees: String(round2(fx.feesSettled * fx.fields.exchangeRate)),
          executedAt: body.executedAt ? new Date(body.executedAt) : existing.executedAt,
          updatedAt: new Date(),
        })
        .where(eq(portfolioTransactions.id, txId))
        .returning()

      await recomputePortfolioTotals(tx, identity.id, portfolioId)

      return {
        ...updated,
        quantity,
        price,
        fees,
        feesSettled: fx.feesSettled,
        totalAmount: round2(notional),
        exchangeRate: fx.fields.exchangeRate,
        rateSource: fx.fields.rateSource,
        convertedTotalAmount: round2(notional * fx.fields.exchangeRate),
        convertedPrice: round2(price * fx.fields.exchangeRate),
        convertedFees: round2(fx.feesSettled * fx.fields.exchangeRate),
      }
    })

    return c.json(result)
  })

  // DELETE /:id/transactions/:txId — delete + reverse position + recompute
  routes.delete("/:id/transactions/:txId", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDb()!
    const portfolioId = c.req.param("id") as string
    const txId = c.req.param("txId") as string

    const portfolio = await loadPortfolio(database, portfolioId, identity.id)
    if (!portfolio) return c.json({ error: "NotFound", message: "Portfolio not found" }, 404)

    const existing = await database
      .select()
      .from(portfolioTransactions)
      .where(
        and(
          eq(portfolioTransactions.id, txId),
          eq(portfolioTransactions.userId, identity.id),
          eq(portfolioTransactions.portfolioId, portfolioId),
        ),
      )
      .then((rows) => rows[0])

    if (!existing) return c.json({ error: "NotFound", message: "Transaction not found" }, 404)

    await database.transaction(async (tx) => {
      // Find the position to reverse — use positionId if set, else find by symbol
      let pos = null as typeof positions.$inferSelect | null
      if (existing.positionId) {
        const [found] = await tx
          .select()
          .from(positions)
          .where(eq(positions.id, existing.positionId))
          .then((rows) => rows.slice(0, 1))
        pos = found ?? null
      }
      if (!pos) {
        const [found] = await tx
          .select()
          .from(positions)
          .where(
            and(
              eq(positions.userId, identity.id),
              eq(positions.portfolioId, portfolioId),
              eq(positions.symbol, existing.instrumentSymbol!),
              eq(positions.isOpen, true),
            ),
          )
          .then((rows) => rows.slice(0, 1))
        pos = found ?? null
      }

      if (pos) {
        const txQty = Number(existing.quantity)
        const txType = existing.type
        if (txType === "BUY") {
          const newQty = Math.max(0, Number(pos.quantity) - txQty)
          const updateData: Record<string, unknown> = {
            quantity: String(newQty),
            updatedAt: new Date(),
          }
          if (newQty < 1e-9) {
            updateData.isOpen = false
            updateData.closedAt = new Date()
          }
          await tx
            .update(positions)
            .set(updateData)
            .where(eq(positions.id, pos.id))
        } else if (txType === "SELL") {
          const newQty = Number(pos.quantity) + txQty
          await tx
            .update(positions)
            .set({
              quantity: String(newQty),
              isOpen: true,
              closedAt: null,
              updatedAt: new Date(),
            })
            .where(eq(positions.id, pos.id))
        }
      }

      await tx
        .delete(portfolioTransactions)
        .where(eq(portfolioTransactions.id, txId))

      if (existing.walletId) {
        const ref = `PORTFOLIO_${existing.type}_${existing.instrumentSymbol}_${txId.slice(0, 8)}`
        await tx
          .delete(walletTransactions)
          .where(
            and(
              eq(walletTransactions.portfolioId, portfolioId),
              eq(walletTransactions.reference, ref),
            ),
          )

        const [wallet] = await tx
          .select()
          .from(wallets)
          .where(eq(wallets.id, existing.walletId))
          .then((rows) => rows.slice(0, 1))
        if (wallet) {
          const notional = Number(existing.totalAmount)
          const feesSettled = Number(existing.feesSettled)
          const reversal = existing.type === "BUY"
            ? notional + feesSettled
            : -(notional - feesSettled)
          const newBal = Math.round((Number(wallet.balance) + reversal) * 1e8) / 1e8
          const newAvail = Math.round((Number(wallet.availableBalance) + reversal) * 1e8) / 1e8
          await tx
            .update(wallets)
            .set({ balance: scale8(newBal), availableBalance: scale8(newAvail), updatedAt: new Date() })
            .where(eq(wallets.id, wallet.id))
        }
      }

      await recomputePortfolioTotals(tx, identity.id, portfolioId)
    })

    return c.body(null, 204)
  })

  // PATCH /:id/positions/:positionId — metadata-only update
  routes.patch("/:id/positions/:positionId", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDb()!
    const portfolioId = c.req.param("id") as string
    const positionId = c.req.param("positionId") as string

    const portfolio = await loadPortfolio(database, portfolioId, identity.id)
    if (!portfolio) return c.json({ error: "NotFound", message: "Portfolio not found" }, 404)

    const body = await c.req.json().catch(() => ({}))

    const MetadataSchema = z.object({
      instrumentName: z.string().optional(),
      sector: z.string().optional(),
      country: z.string().optional(),
      assetType: z.string().optional(),
      currentPrice: z.number().optional(),
      priceSource: z.string().optional(),
      quantity: z.number().nonnegative().optional(),
      averageCostBasis: z.number().nonnegative().optional(),
    })
    const parsed = MetadataSchema.safeParse(body)
    if (!parsed.success) {
      return c.json({ error: "ValidationError", message: parsed.error.issues[0]?.message }, 422)
    }

    const updates = parsed.data

    const [pos] = await database
      .select()
      .from(positions)
      .where(
        and(
          eq(positions.id, positionId),
          eq(positions.userId, identity.id),
          eq(positions.portfolioId, portfolioId),
        ),
      )
    if (!pos) return c.json({ error: "NotFound", message: "Position not found" }, 404)

    const newQty = updates.quantity != null ? updates.quantity : Number(pos.quantity)
    const newAvg = updates.averageCostBasis != null ? updates.averageCostBasis : Number(pos.averageCostBasis)
    const newPrice =
      updates.currentPrice != null
        ? updates.currentPrice
        : pos.currentPrice != null
          ? Number(pos.currentPrice)
          : null

    const setData: Record<string, unknown> = { updatedAt: new Date() }
    if (updates.currentPrice != null) {
      setData.currentPrice = String(updates.currentPrice)
      setData.priceSource = updates.priceSource ?? pos.priceSource
      setData.priceAsOf = new Date()
    }
    if (updates.quantity != null) setData.quantity = String(newQty)
    if (updates.averageCostBasis != null) setData.averageCostBasis = String(newAvg)
    if (updates.instrumentName != null) setData.companyName = updates.instrumentName
    if (updates.sector != null) setData.sector = updates.sector
    if (updates.country != null) setData.country = updates.country
    if (updates.assetType != null) setData.assetType = updates.assetType

    if (updates.currentPrice != null || updates.quantity != null || updates.averageCostBasis != null) {
      const mktVal = newPrice != null ? round2(newQty * newPrice) : null
      setData.marketValue = mktVal != null ? String(mktVal) : (updates.quantity != null || updates.averageCostBasis != null ? "0" : pos.marketValue)
      if (newPrice != null) setData.unrealizedGainLoss = String(round2((newPrice - newAvg) * newQty))
    }

    await database
      .update(positions)
      .set(setData)
      .where(eq(positions.id, positionId))

    await recomputePortfolioTotals(database, identity.id, portfolioId)

    const [updated] = await database
      .select()
      .from(positions)
      .where(eq(positions.id, positionId))
    if (!updated) return c.json({ error: "NotFound", message: "Position not found" }, 404)

    const totalValue = await openPositionsValue(database, identity.id, portfolioId)
    return c.json(positionWire(updated, portfolio, totalValue))
  })

  // DELETE /:id/positions/:positionId — remove position + its transactions
  // (D4.8: cash from trades returned to linked wallets), mock parity:
  // returns the closed position
  routes.delete("/:id/positions/:positionId", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDb()!
    const portfolioId = c.req.param("id") as string
    const positionId = c.req.param("positionId") as string

    const portfolio = await loadPortfolio(database, portfolioId, identity.id)
    if (!portfolio) return c.json({ error: "NotFound", message: "Portfolio not found" }, 404)

    const [pos] = await database
      .select()
      .from(positions)
      .where(
        and(
          eq(positions.id, positionId),
          eq(positions.userId, identity.id),
          eq(positions.portfolioId, portfolioId),
        ),
      )
    if (!pos) return c.json({ error: "NotFound", message: "Position not found" }, 404)

    const closed = { ...pos, isOpen: false, closedAt: new Date() } as PositionRow

    const linked = await database
      .select()
      .from(portfolioTransactions)
      .where(
        and(
          eq(portfolioTransactions.userId, identity.id),
          eq(portfolioTransactions.portfolioId, portfolioId),
          eq(portfolioTransactions.positionId, positionId),
        ),
      )

    await database.transaction(async (tx) => {
      for (const existing of linked) {
        if (existing.walletId) {
          const ref = `PORTFOLIO_${existing.type}_${existing.instrumentSymbol}_${existing.id.slice(0, 8)}`
          await tx
            .delete(walletTransactions)
            .where(
              and(
                eq(walletTransactions.portfolioId, portfolioId),
                eq(walletTransactions.reference, ref),
              ),
            )

          const [wallet] = await tx
            .select()
            .from(wallets)
            .where(eq(wallets.id, existing.walletId))
            .then((rows) => rows.slice(0, 1))
          if (wallet) {
            const notional = Number(existing.totalAmount)
            const feesSettled = Number(existing.feesSettled)
            const reversal = existing.type === "BUY"
              ? notional + feesSettled
              : -(notional - feesSettled)
            const newBal = Math.round((Number(wallet.balance) + reversal) * 1e8) / 1e8
            const newAvail = Math.round((Number(wallet.availableBalance) + reversal) * 1e8) / 1e8
            await tx
              .update(wallets)
              .set({ balance: scale8(newBal), availableBalance: scale8(newAvail), updatedAt: new Date() })
              .where(eq(wallets.id, wallet.id))
          }
        }
      }

      await tx
        .delete(portfolioTransactions)
        .where(
          and(
            eq(portfolioTransactions.positionId, positionId),
            eq(portfolioTransactions.portfolioId, portfolioId),
          ),
        )
      await tx.delete(positions).where(eq(positions.id, positionId))
      await recomputePortfolioTotals(tx, identity.id, portfolioId)
    })

    return c.json(positionWire(closed, portfolio, 0))
  })

  // ── D1: GET /:id/transactions — paginated with filters + sorting ─────

  const TX_SORT_FIELDS: Record<string, string> = {
    symbol: "instrument_symbol",
    date: "executed_at",
    type: "type",
    quantity: "quantity",
    price: "price",
    fees: "fees",
    amount: "total_amount",
  }

  routes.get("/:id/transactions", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDb()!
    const portfolioId = c.req.param("id") as string

    const portfolio = await loadPortfolio(database, portfolioId, identity.id)
    if (!portfolio) return c.json({ error: "NotFound", message: "Portfolio not found" }, 404)

    const page = Math.max(1, Number(c.req.query("page")) || 1)
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 20))
    const offset = (page - 1) * limit
    const sortBy = c.req.query("sortBy") ?? "date"
    const sortOrder = (c.req.query("sortOrder") ?? "desc").toLowerCase() === "asc" ? "asc" : "desc"
    const typeFilter = c.req.query("type")
    const positionId = c.req.query("positionId")

    const conditions = [
      eq(portfolioTransactions.userId, identity.id),
      eq(portfolioTransactions.portfolioId, portfolioId),
    ]
    if (typeFilter) {
      conditions.push(eq(portfolioTransactions.type, typeFilter.toUpperCase()))
    }
    if (positionId) {
      conditions.push(eq(portfolioTransactions.positionId, positionId))
    }

    const sortCol = TX_SORT_FIELDS[sortBy] ?? "executedAt"
    const sortFn = sortOrder === "asc" ? asc : desc
    const sortExpr = sql`${sql.raw(`"${sortCol}"`)}`

    const [countRow] = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(portfolioTransactions)
      .where(and(...conditions))

    const total = countRow?.count ?? 0

    const rows = await database
      .select()
      .from(portfolioTransactions)
      .where(and(...conditions))
      .orderBy(sortFn(sortExpr))
      .limit(limit)
      .offset(offset)

    const items = rows.map(serializeTx)

    return c.json({ items, total, page, limit })
  })

  // ── D3: GET /:id/transactions/export — paginated JSON export ─────────

  routes.get("/:id/transactions/export", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDb()!
    const portfolioId = c.req.param("id") as string

    const portfolio = await loadPortfolio(database, portfolioId, identity.id)
    if (!portfolio) return c.json({ error: "NotFound", message: "Portfolio not found" }, 404)

    const page = Math.max(1, Number(c.req.query("page")) || 1)
    const limit = Math.min(500, Math.max(1, Number(c.req.query("limit")) || 100))
    const offset = (page - 1) * limit

    const [countRow] = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(portfolioTransactions)
      .where(
        and(
          eq(portfolioTransactions.userId, identity.id),
          eq(portfolioTransactions.portfolioId, portfolioId),
        ),
      )

    const total = countRow?.count ?? 0

    const rows = await database
      .select()
      .from(portfolioTransactions)
      .where(
        and(
          eq(portfolioTransactions.userId, identity.id),
          eq(portfolioTransactions.portfolioId, portfolioId),
        ),
      )
      .orderBy(desc(portfolioTransactions.executedAt))
      .limit(limit)
      .offset(offset)

    const items = rows.map((r) => ({
      id: r.id,
      portfolioId: r.portfolioId,
      positionId: r.positionId,
      type: r.type,
      instrumentSymbol: r.instrumentSymbol,
      instrumentName: r.instrumentName,
      quantity: Number(r.quantity),
      price: Number(r.price),
      totalAmount: Number(r.totalAmount),
      currency: r.currency,
      fees: r.fees != null ? Number(r.fees) : 0,
      feesSettled: Number(r.feesSettled),
      feeCurrency: r.feeCurrency,
      exchangeRate: Number(r.exchangeRate),
      rateSource: r.rateSource,
      convertedTotalAmount: Number(r.convertedTotalAmount),
      realizedGainLoss: r.realizedGainLoss != null ? Number(r.realizedGainLoss) : null,
      executedAt: r.executedAt?.toISOString?.() ?? r.executedAt,
    }))

    return c.json({ items, total, page, limit })
  })

  // ── POST /:id/positions — add position (BUY delegation, D4.2–4.4) ─────

  routes.post("/:id/positions", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDb()!
    const portfolioId = c.req.param("id") as string

    const portfolio = await loadPortfolio(database, portfolioId, identity.id)
    if (!portfolio) return c.json({ error: "NotFound", message: "Portfolio not found" }, 404)

    const parsed = PositionCreateSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: "ValidationError", message: parsed.error.issues[0]?.message }, 422)
    }
    const body = parsed.data
    const symbol = body.symbol.toUpperCase()
    // Use submitted currency when provided; fall back to portfolio base currency
    const currency = (body.currency ?? body.instrumentCurrency ?? portfolio.baseCurrency ?? "USD").toUpperCase()
    const instCurrency = (body.instrumentCurrency ?? body.currency ?? portfolio.baseCurrency ?? "USD").toUpperCase()
    const price = body.price ?? body.averageCostBasis
    if (price == null) {
      return c.json({ error: "ValidationError", message: "price or averageCostBasis is required" }, 422)
    }
    const notional = body.quantity * price

    const fx = await resolveFeeFx(
      database,
      {
        fees: body.fees,
        feesType: body.feesType,
        feeCurrency: body.feeCurrency,
        rateSource: body.rateSource,
        exchangeRate: body.exchangeRate,
        feeRateSource: body.feeRateSource,
        feeExchangeRate: body.feeExchangeRate,
      },
      currency,
      { notional },
    )
    if (!fx.ok) return c.json({ error: "ValidationError", message: fx.message }, 422)

    const executedAt =
      body.executedAt != null || body.openedAt != null
        ? new Date(body.executedAt ?? body.openedAt!)
        : new Date()

    const result = await database.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(portfolioTransactions)
        .values({
          userId: identity.id,
          portfolioId,
          positionId: null,
          walletId: body.walletId ?? null,
          type: "BUY",
          instrumentSymbol: symbol,
          instrumentName: body.instrumentName ?? null,
          sector: body.sector ?? null,
          country: body.country ?? null,
          quantity: String(body.quantity),
          price: String(price),
          currency,
          instrumentCurrency: instCurrency,
          assetType: body.assetType ?? "STOCK",
          fees: body.fees != null ? String(body.fees) : null,
          feesType: fx.fields.feesType,
          feeCurrency: fx.fields.feeCurrency,
          feesSettled: String(fx.feesSettled),
          totalAmount: String(round2(notional)),
          exchangeRate: String(fx.fields.exchangeRate),
          rateSource: fx.fields.rateSource,
          feeRateSource: fx.fields.feeRateSource,
          feeExchangeRate: fx.fields.feeExchangeRate != null ? String(fx.fields.feeExchangeRate) : null,
          convertedTotalAmount: String(round2(notional * fx.fields.exchangeRate)),
          convertedPrice: String(round2(price * fx.fields.exchangeRate)),
          convertedFees: String(round2(fx.feesSettled * fx.fields.exchangeRate)),
          displayCurrency: "USD",
          isGift: false,
          synthesizedOpeningLot: false,
          executedAt,
        })
        .returning()

      const position = await upsertPositionOnBuy(tx, identity.id, portfolioId, {
        symbol,
        instrumentName: body.instrumentName,
        quantity: body.quantity,
        price,
        currency,
        instrumentCurrency: instCurrency,
        assetType: body.assetType,
        sector: body.sector,
        country: body.country,
        walletId: body.walletId,
        feesSettled: fx.feesSettled,
        contractSize: body.contractSize,
        direction: body.direction,
        optionType: body.optionType,
        strikePrice: body.strikePrice,
        expirationDate: body.expirationDate,
        openedAt: executedAt,
      })

      if (position) {
        await tx
          .update(portfolioTransactions)
          .set({ positionId: position.id })
          .where(eq(portfolioTransactions.id, inserted.id))
      }

      await recomputePortfolioTotals(tx, identity.id, portfolioId)

      let walletLink = null
      if (body.walletId) {
        walletLink = await createWalletLink(tx, identity.id, {
          walletId: body.walletId,
          symbol,
          type: "BUY",
          quantity: body.quantity,
          price,
          currency,
          feesSettled: fx.feesSettled,
          exchangeRate: fx.fields.exchangeRate,
          transactionId: inserted.id,
          portfolioId,
        })
        if (walletLink && "error" in walletLink) return { error: walletLink.error }
      }

      return { transaction: inserted, position, walletLink }
    })

    if ("error" in result) {
      return c.json({ error: "ValidationError", message: result.error }, 422)
    }
    if (!result.position) {
      return c.json({ error: "NotFound", message: "Position not found" }, 404)
    }

    // D58: enrich with live quote so 201 response has current price/market value
    await refreshQuotes(database, identity.id, portfolioId, c.req.header("Authorization") ?? "")
    await recomputePortfolioTotals(database, identity.id, portfolioId)

    const [fresh] = await database
      .select()
      .from(positions)
      .where(eq(positions.id, result.position.id))
    const totalValue = await openPositionsValue(database, identity.id, portfolioId)

    return c.json(positionWire(fresh, portfolio, totalValue), 201)
  })

  // ── E1: GET /:id/positions — full position list (example-service wire shape) ──

  routes.get("/:id/positions", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDb()!
    const portfolioId = c.req.param("id") as string

    const portfolio = await loadPortfolio(database, portfolioId, identity.id)
    if (!portfolio) return c.json({ error: "NotFound", message: "Portfolio not found" }, 404)

    await refreshQuotes(database, identity.id, portfolioId, c.req.header("Authorization") ?? "")

    const posRows = await database
      .select()
      .from(positions)
      .where(
        and(
          eq(positions.userId, identity.id),
          eq(positions.portfolioId, portfolioId),
        ),
      )

    const totalValue = await openPositionsValue(database, identity.id, portfolioId)

    return c.json(posRows.map((p) => positionWire(p, portfolio, totalValue)))
  })

  // ── E3: GET /:id/allocation — sector/asset/currency breakdown ────────

  routes.get("/:id/allocation", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDb()!
    const portfolioId = c.req.param("id") as string

    const portfolio = await loadPortfolio(database, portfolioId, identity.id)
    if (!portfolio) return c.json({ error: "NotFound", message: "Portfolio not found" }, 404)

    await refreshQuotes(database, identity.id, portfolioId, c.req.header("Authorization") ?? "")

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
      (sum, p) => sum + (p.marketValue != null ? Number(p.marketValue) : Number(p.quantity) * Number(p.averageCostBasis)),
      0,
    )

    function sumBy(field: string) {
      const totals = new Map<string, number>()
      for (const p of posRows) {
        const key = (p as Record<string, unknown>)[field] || "Other"
        const val = p.marketValue != null ? Number(p.marketValue) : Number(p.quantity) * Number(p.averageCostBasis)
        totals.set(String(key), (totals.get(String(key)) || 0) + val)
      }
      return [...totals.entries()]
        .map(([name, value]) => ({ name, value: round2(value) }))
        .sort((a, b) => b.value - a.value)
    }

    return c.json({
      totalValue: round2(totalValue),
      bySector: sumBy("sector"),
      byAssetType: sumBy("assetType"),
      byCurrency: sumBy("instrumentCurrency"),
    })
  })

  // ── E2: GET /:id/positions/bare — minimal position list ──────────────

  routes.get("/:id/positions/bare", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDb()!
    const portfolioId = c.req.param("id") as string

    const portfolio = await loadPortfolio(database, portfolioId, identity.id)
    if (!portfolio) return c.json({ error: "NotFound", message: "Portfolio not found" }, 404)

    const posRows = await database
      .select({
        id: positions.id,
        symbol: positions.symbol,
        companyName: positions.companyName,
        quantity: positions.quantity,
        averageCostBasis: positions.averageCostBasis,
        instrumentCurrency: positions.instrumentCurrency,
        isOpen: positions.isOpen,
      })
      .from(positions)
      .where(
        and(
          eq(positions.userId, identity.id),
          eq(positions.portfolioId, portfolioId),
        ),
      )

    return c.json(posRows.map((p) => ({
      id: p.id,
      symbol: p.symbol,
      companyName: p.companyName,
      quantity: Number(p.quantity),
      avgCostBasis: Number(p.averageCostBasis),
      instrumentCurrency: p.instrumentCurrency,
      isOpen: p.isOpen,
    })))
  })

  // ── E2: GET /:id/positions/cfd-hints — CFD position suggestions ─────

  routes.get("/:id/positions/cfd-hints", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDb()!
    const portfolioId = c.req.param("id") as string

    const portfolio = await loadPortfolio(database, portfolioId, identity.id)
    if (!portfolio) return c.json({ error: "NotFound", message: "Portfolio not found" }, 404)

    await refreshQuotes(database, identity.id, portfolioId, c.req.header("Authorization") ?? "")

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

    const hints = posRows.map((p) => ({
      symbol: p.symbol,
      companyName: p.companyName,
      sector: p.sector,
      country: p.country,
      quantity: Number(p.quantity),
      avgCostBasis: Number(p.averageCostBasis),
      unrealizedPnl: p.unrealizedGainLoss != null ? Number(p.unrealizedGainLoss) : null,
      dayChange: p.dayChange != null ? Number(p.dayChange) : null,
      dayChangePercent: p.dayChangePercent != null ? Number(p.dayChangePercent) : null,
    }))

    return c.json(hints)
  })

  return routes
}

// ── D2: cross-portfolio transaction feed ──────────────────────────────────
// Separate Hono to mount at /api/portfolios/transactions without /:id collision.

const PORTFOLIO_TX_SORT: Record<string, string> = {
  symbol: "instrument_symbol",
  date: "executed_at",
  type: "type",
  quantity: "quantity",
  price: "price",
  fees: "fees",
  amount: "total_amount",
}

function serializeTx(r: typeof portfolioTransactions.$inferSelect) {
  return {
    id: r.id,
    portfolioId: r.portfolioId,
    positionId: r.positionId,
    walletId: r.walletId,
    type: r.type,
    instrumentSymbol: r.instrumentSymbol,
    instrumentName: r.instrumentName,
    sector: r.sector,
    country: r.country,
    quantity: Number(r.quantity),
    price: Number(r.price),
    fees: r.fees != null ? Number(r.fees) : 0,
    feesType: r.feesType,
    feeCurrency: r.feeCurrency,
    feesSettled: Number(r.feesSettled),
    feeRateSource: r.feeRateSource,
    feeExchangeRate: r.feeExchangeRate != null ? Number(r.feeExchangeRate) : null,
    totalAmount: Number(r.totalAmount),
    currency: r.currency,
    instrumentCurrency: r.instrumentCurrency,
    assetType: r.assetType,
    exchangeRate: Number(r.exchangeRate),
    rateSource: r.rateSource,
    convertedTotalAmount: Number(r.convertedTotalAmount),
    convertedPrice: Number(r.convertedPrice),
    convertedFees: Number(r.convertedFees),
    realizedGainLoss: r.realizedGainLoss != null ? Number(r.realizedGainLoss) : null,
    convertedRealizedGainLoss: r.realizedGainLoss != null ? Number(r.realizedGainLoss) : null,
    isGift: r.isGift,
    synthesizedOpeningLot: r.synthesizedOpeningLot,
    executedAt: r.executedAt?.toISOString?.() ?? r.executedAt,
    createdAt: r.createdAt?.toISOString?.() ?? r.createdAt,
  }
}

export function createCrossPortfolioTransactionsRoute(db?: DB) {
  const routes = new Hono()
  routes.use("*", userIdentityMiddleware)
  const getDb = () => db

  routes.get("/", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDb()!

    const page = Math.max(1, Number(c.req.query("page")) || 1)
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 10))
    const offset = (page - 1) * limit
    const sortBy = c.req.query("sortBy") ?? "date"
    const sortOrder = (c.req.query("sortOrder") ?? "desc").toLowerCase() === "asc" ? "asc" : "desc"

    const sortCol = PORTFOLIO_TX_SORT[sortBy] ?? "executed_at"
    const sortDir = sortOrder === "asc" ? sql`ASC` : sql`DESC`

    const [countRow] = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(portfolioTransactions)
      .where(sql`${portfolioTransactions.userId} = ${identity.id}`)

    const total = countRow?.count ?? 0

    const rows = await database
      .select()
      .from(portfolioTransactions)
      .where(sql`${portfolioTransactions.userId} = ${identity.id}`)
      .orderBy(sql`${sql.raw(`"${sortCol}"`)} ${sortDir}`)
      .limit(limit)
      .offset(offset)

    return c.json({ items: rows.map(serializeTx), total, page, limit })
  })

  return routes
}
