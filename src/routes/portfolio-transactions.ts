import { Hono, type Context } from "hono"
import { and, eq, sql, asc, desc, inArray, type SQL } from "drizzle-orm"
import { z } from "zod"
import { userIdentityMiddleware } from "../auth.js"
import { POSITION_TX_TYPES } from "../transaction-types.js"
import { getDb as resolveDb, type DB } from "../db/index.js"
import {
  portfolios,
  positions,
  portfolioTransactions,
  portfolioCashTransactions,
  positionLabels,
  transactionLabels,
} from "../db/schema.js"
import { resolveFeeFx } from "../services/fee-fx.js"
import { externalCashInvested } from "../services/cashLedger.js"
import { fxTo, resolveRates } from "../services/instruments-fx.js"
import {
  labelsForPositions,
  labelsForTransactions,
  labelFilterIds,
  attachLabelCondition,
} from "../services/labels.js"
import { convert } from "@marx2/contracts/fx"
import { refreshQuotes } from "../services/quotes.js"
import { notifyTransactionsChanged } from "../services/recalc-queue.js"
import type { components } from "../generated/api-types.js"

type Label = components["schemas"]["Label"]

const scale8 = (n: number) => n.toFixed(8)
const round2 = (n: number) => Math.round(n * 100) / 100

/**
 * The types this route can actually build. Deliberately narrower than
 * `POSITION_TX_TYPES`, and the divergence is the point: the schema validates the
 * full set so a valid type is never a *validation* failure, and this list turns the
 * unsupported ones into an explicit 422 instead of a silently wrong row.
 */
const INTERACTIVE_TX_TYPES = ["BUY", "SELL", "DIVIDEND"] as const

export const TransactionCreateSchema = z.object({
  type: z.enum(POSITION_TX_TYPES),
  symbol: z.string().min(1).max(20),
  instrumentName: z.string().optional(),
  quantity: z.number().positive(),
  price: z.number().positive(),
  currency: z.string().length(3),
  instrumentCurrency: z.string().length(3).optional(),
  assetType: z.string().optional(),
  sector: z.string().optional(),
  industry: z.string().optional(),
  country: z.string().optional(),
  fees: z.number().nonnegative().optional(),
  feesType: z.enum(["fixed", "pct"]).optional(),
  feeCurrency: z.string().length(3).optional(),
  rateSource: z.enum(["automatic", "manual"]).optional(),
  exchangeRate: z.number().positive().optional(),
  feeRateSource: z.enum(["automatic", "manual"]).optional(),
  feeExchangeRate: z.number().positive().optional(),
  taxes: z.number().nonnegative().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  positionId: z.string().uuid().optional(),
  executedAt: z.string().optional(),
  isGift: z.boolean().optional(),
  /**
   * §87.5 — also create the external cash leg for this trade: a DEPOSIT funding a BUY,
   * a WITHDRAWAL taking out a SELL's proceeds, in the row currency, linked to the
   * trade through `linked_trade_id` so both deletes follow.
   *
   * The SPA pre-ticks this from the portfolio's `cashLegOnTrade` flag and the user
   * can still untick it per transaction; OMITTED means "no cash leg", so an
   * existing caller that never sends it behaves exactly as before.
   */
  cashLeg: z.boolean().optional(),
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
  taxes: z.number().nonnegative().nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
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
  authToken: string | null,
  userId: string,
  portfolioId: string,
) {
  // 2026-09-27 — invested = cumulative net EXTERNAL cash flow (deposits −
  // withdrawals ± transfer legs), not BUY-row cost basis.
  const [pf] = await tx
    .select({ baseCurrency: portfolios.baseCurrency })
    .from(portfolios)
    .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)))
  // §66.4 — a missing portfolio must not silently value as USD.
  if (!pf) throw new Error(`portfolio ${portfolioId} not found while recomputing invested`)
  const totalInvested = await externalCashInvested(tx, authToken, portfolioId, pf.baseCurrency)

  await tx
    .update(portfolios)
    .set({
      totalInvested: totalInvested.toFixed(8),
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
    industry?: string
    country?: string
    positionId?: string
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
        industry: body.industry ?? pos.industry,
        country: body.country ?? pos.country,
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
      industry: body.industry ?? "Other",
      country: body.country ?? "Other",
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
  fees: z.number().nonnegative().optional(),
  feesType: z.enum(["fixed", "pct"]).optional(),
  feeCurrency: z.string().length(3).optional(),
  rateSource: z.enum(["automatic", "manual"]).optional(),
  exchangeRate: z.number().positive().optional(),
  /**
   * §87.5 — same UI-only cash leg as `TransactionCreateSchema.cashLeg`: a new
   * position IS a BUY, so funding it gets a linked DEPOSIT for the same reason.
   * Omitted ⇒ no cash row, so existing callers are unaffected.
   */
  cashLeg: z.boolean().optional(),
  feeRateSource: z.enum(["automatic", "manual"]).optional(),
  feeExchangeRate: z.number().positive().optional(),
  openedAt: z.string().optional(),
  executedAt: z.string().optional(),
})

type PositionRow = typeof positions.$inferSelect

/** Example service wire shape for a single position (GET list / create / edit / remove). */
/**
 * The one place a `Position` becomes wire shape.
 *
 * §83.5 — exported so `GET /api/portfolios/positions` (the all-portfolios list)
 * renders through the SAME function as `GET /:id/positions`. Two copies of this
 * mapper is how the cumulative Performance tab's performer cards end up
 * disagreeing with the per-portfolio tab about the same holding.
 */
export function positionWire(
  p: PositionRow,
  portfolio: { id: string; baseCurrency: string },
  totalValue: number,
  fxRates: Map<string, number | null> = new Map(),
  labels: Label[] = [],
) {
  const avg   = Number(p.averageCostBasis)
  const qty   = Number(p.quantity)
  const price = p.currentPrice != null ? Number(p.currentPrice) : null
  const mv    = p.marketValue   != null ? Number(p.marketValue)  : price != null ? price * qty : null
  const ugl   = p.unrealizedGainLoss != null ? Number(p.unrealizedGainLoss) : null
  const pct   = price != null && avg > 0 ? ((price - avg) / avg) * 100 : null

  // Instrument native currency (e.g. PLN for KRU.WA)
  const instrCcy = p.instrumentCurrency ?? portfolio.baseCurrency

  // Convert native → displayCurrency using the resolved pair rates (plan
  // §48.3 — resolved via instruments; unresolvable pair → null, as before).
  function toDisplay(nativeValue: number | null): number | null {
    if (nativeValue == null) return null
    if (instrCcy === portfolio.baseCurrency) return nativeValue
    const rate = fxRates.get(instrCcy.toUpperCase())
    return rate != null ? round2(nativeValue * rate) : null
  }

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
    instrumentCurrency: instrCcy,
    quantity: qty,
    // native (instrument currency) cost basis — historical approximation via current FX
    averageCostBasis:    avg,
    totalCostBasis:      round2(avg * qty),
    // converted to displayCurrency
    convertedAverageCostBasis:  toDisplay(avg),
    convertedTotalCostBasis:    toDisplay(avg * qty),
    convertedCurrentPrice:      toDisplay(price),
    convertedMarketValue:       toDisplay(mv),
    convertedUnrealizedGainLoss: toDisplay(ugl),
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
    unrealizedGainLoss: ugl,
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
    labels,
    // §83.5 — the owning portfolio's NAME, for the all-portfolios list only.
    // Undefined on this route, so it serialises as absent and the per-portfolio
    // response is byte-identical to before (the contract field is nullable, not
    // required — see openapi.yaml `Position.portfolioName`).
    portfolioName: undefined,
  }
}

/**
 * §83.5 — open positions for one portfolio, keyed by `portfolioId`, so a route
 * that spans portfolios can hand each `positionWire` call the same denominator
 * its per-portfolio twin would have used.
 *
 * Same fallback as `openPositionsValue` (`quantity × averageCostBasis` when
 * `marketValue` is null) on purpose: a different denominator here would make
 * `percentOfPortfolio` mean something else on the aggregate list.
 */
export async function openPositionsValueByPortfolio(
  db: DB,
  userId: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({ portfolioId: positions.portfolioId, marketValue: positions.marketValue, quantity: positions.quantity, averageCostBasis: positions.averageCostBasis })
    .from(positions)
    .where(and(eq(positions.userId, userId), eq(positions.isOpen, true)))
  const totals = new Map<string, number>()
  for (const p of rows) {
    const v = p.marketValue != null ? Number(p.marketValue) : Number(p.quantity) * Number(p.averageCostBasis)
    totals.set(p.portfolioId, (totals.get(p.portfolioId) ?? 0) + v)
  }
  return totals
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

  const getDb = () => db ?? resolveDb()

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
    // The interactive route can only express a trade. `TRANSFER_OUT` expands into a
    // FIFO group with a derived receiving leg, and `EXPIRATION` needs the option
    // direction — neither is expressible here, and this route's cash leg treats
    // anything that is not BUY as a WITHDRAWAL, so accepting them would book a cash
    // payment for an event that moved no cash. Rejected loudly rather than
    // half-handled; the importer is what produces both.
    if (!(INTERACTIVE_TX_TYPES as readonly string[]).includes(body.type)) {
      return c.json(
        {
          error: "UnsupportedTransactionType",
          message: `${body.type} cannot be created here — it needs the import path, which derives the receiving leg`,
        },
        422,
      )
    }
    const symbol = body.symbol.toUpperCase()
    const txCcy = body.currency.toUpperCase()
    const instCcy = (body.instrumentCurrency ?? body.currency).toUpperCase()
    const notional = body.quantity * body.price

    // example-service convention (§49): for DIVIDEND, taxes is the withholding tax and
    // totalAmount is the NET (gross − taxes); wallet is credited the net.
    const taxes = body.taxes ?? null
    if (taxes != null && taxes > notional) {
      return c.json({ error: "ValidationError", message: "taxes cannot exceed the gross amount (quantity × price)" }, 422)
    }
    const isDividend = body.type === "DIVIDEND"
    const netAmount = isDividend ? round2(notional - (taxes ?? 0)) : round2(notional)

    const fx = await resolveFeeFx(c.req.header("Authorization") ?? "", body, txCcy, { notional })
    if (!fx.ok) return c.json({ error: "ValidationError", message: fx.message }, 422)

    const executedAt = body.executedAt ? new Date(body.executedAt) : new Date()

    const result = await database.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(portfolioTransactions)
        .values({
          userId: identity.id,
          portfolioId,
          positionId: body.positionId ?? null,
          type: body.type,
          instrumentSymbol: symbol,
          instrumentName: body.instrumentName ?? null,
          sector: body.sector ?? null,
          country: body.country ?? null,
          quantity: String(body.quantity),
          price: String(body.price),
          originalQuantity: String(body.quantity),
          originalPrice: String(body.price),
          currency: txCcy,
          instrumentCurrency: instCcy,
          assetType: body.assetType ?? "STOCK",
          fees: body.fees != null ? String(body.fees) : null,
          feesType: fx.fields.feesType,
          feeCurrency: fx.fields.feeCurrency,
          feesSettled: String(fx.feesSettled),
          taxes: taxes != null ? String(taxes) : null,
          notes: body.notes ?? null,
          totalAmount: String(netAmount),
          exchangeRate: String(fx.fields.exchangeRate),
          rateSource: fx.fields.rateSource,
          feeRateSource: fx.fields.feeRateSource,
          feeExchangeRate: fx.fields.feeExchangeRate != null ? String(fx.fields.feeExchangeRate) : null,
          convertedTotalAmount: String(round2(netAmount * fx.fields.exchangeRate)),
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

      // §87.5 — the external cash leg, in the SAME transaction as the trade so a
      // partial write cannot leave one leg without the other. Deliberately NOT
      // gated on the portfolio's `cashLegOnTrade` flag: that flag is the form's
      // DEFAULT (the SPA reads it and pre-ticks the box), and the per-transaction
      // untick has to reach here, so the request is the single source of truth for
      // what the user asked for.
      let cashLeg = null
      if (body.cashLeg && (body.type === "BUY" || body.type === "SELL")) {
        // The amount mirrors the importer's `rowCcyCash`: what the trade actually
        // moved, i.e. the net amount (notional − taxes for a dividend, though a
        // dividend never gets a leg) PLUS the settled fees, which the replay effect
        // subtracts from the wallet. Fees are in `fx.feeCurrency`, so a fee in
        // another currency is converted with the rate this trade already resolved.
        const feesInRowCcy =
          (fx.feesSettled || 0) * (fx.fields.feeCurrency === txCcy ? 1 : fx.fields.feeExchangeRate ?? 1)
        const gross = round2(Math.abs(netAmount) + feesInRowCcy)
        const [cash] = await tx
          .insert(portfolioCashTransactions)
          .values({
            userId: identity.id,
            portfolioId,
            type: body.type === "BUY" ? "DEPOSIT" : "WITHDRAWAL",
            // DEPOSIT stores +|amount| and WITHDRAWAL −|amount| (the sign is the
            // row's, not the caller's — same convention as the import clamp).
            amount: String(body.type === "BUY" ? gross : -gross),
            currency: txCcy,
            description: `${body.type === "BUY" ? "Buy" : "Withdrawal"}: ${body.instrumentName ?? symbol}`,
            transactionDate: executedAt.toISOString().slice(0, 10),
            linkedTradeId: inserted.id,
          })
          .returning()
        cashLeg = cash
      }

      await recomputePortfolioTotals(tx, c.req.header("Authorization") ?? null, identity.id, portfolioId)

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
          taxes,
          notes: body.notes ?? null,
          totalAmount: netAmount,
          feesSettled: fx.feesSettled,
          exchangeRate: fx.fields.exchangeRate,
          rateSource: fx.fields.rateSource,
          convertedTotalAmount: round2(netAmount * fx.fields.exchangeRate),
          convertedPrice: round2(body.price * fx.fields.exchangeRate),
          convertedFees,
          realizedGainLoss,
        },
        position,
        cashLeg,
      }
    })

    if ("error" in result) {
      return c.json({ error: "ValidationError", message: result.error }, 422)
    }

    notifyTransactionsChanged(database, portfolioId, c.req.header("Authorization") ?? "")
    return c.json(
      { ...result.transaction, position: result.position ?? null, cashLeg: result.cashLeg ?? null },
      201,
    )
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

    const taxes = body.taxes !== undefined
      ? body.taxes
      : existing.taxes != null ? Number(existing.taxes) : null
    if (taxes != null && taxes > notional) {
      return c.json({ error: "ValidationError", message: "taxes cannot exceed the gross amount (quantity × price)" }, 422)
    }
    const isDividend = existing.type === "DIVIDEND"
    const netAmount = isDividend
      ? round2(notional - (taxes ?? 0))
      : round2(notional)
    const notes = body.notes !== undefined ? body.notes : existing.notes

    const fx = await resolveFeeFx(c.req.header("Authorization") ?? "", merged, txCcy, { notional })
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
          taxes: taxes != null ? String(taxes) : null,
          notes,
          totalAmount: String(netAmount),
          exchangeRate: String(fx.fields.exchangeRate),
          rateSource: fx.fields.rateSource,
          feeRateSource: fx.fields.feeRateSource,
          feeExchangeRate: fx.fields.feeExchangeRate != null ? String(fx.fields.feeExchangeRate) : null,
          convertedTotalAmount: String(round2(netAmount * fx.fields.exchangeRate)),
          convertedPrice: String(round2(price * fx.fields.exchangeRate)),
          convertedFees: String(round2(fx.feesSettled * fx.fields.exchangeRate)),
          executedAt: body.executedAt ? new Date(body.executedAt) : existing.executedAt,
          updatedAt: new Date(),
        })
        .where(eq(portfolioTransactions.id, txId))
        .returning()

      await recomputePortfolioTotals(tx, c.req.header("Authorization") ?? null, identity.id, portfolioId)

      return {
        ...updated,
        quantity,
        price,
        fees,
        taxes,
        notes,
        feesSettled: fx.feesSettled,
        totalAmount: netAmount,
        exchangeRate: fx.fields.exchangeRate,
        rateSource: fx.fields.rateSource,
        convertedTotalAmount: round2(netAmount * fx.fields.exchangeRate),
        convertedPrice: round2(price * fx.fields.exchangeRate),
        convertedFees: round2(fx.feesSettled * fx.fields.exchangeRate),
      }
    })

    notifyTransactionsChanged(database, portfolioId, c.req.header("Authorization") ?? "")
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

      await recomputePortfolioTotals(tx, c.req.header("Authorization") ?? null, identity.id, portfolioId)
    })

    notifyTransactionsChanged(database, portfolioId, c.req.header("Authorization") ?? "")
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

    await recomputePortfolioTotals(database, c.req.header("Authorization") ?? null, identity.id, portfolioId)

    const [updated] = await database
      .select()
      .from(positions)
      .where(eq(positions.id, positionId))
    if (!updated) return c.json({ error: "NotFound", message: "Position not found" }, 404)

    const totalValue = await openPositionsValue(database, identity.id, portfolioId)
    const fxRates = await resolveRates(c.req.header("Authorization") ?? "", portfolio.baseCurrency, [updated.instrumentCurrency])
    return c.json(positionWire(updated, portfolio, totalValue, fxRates))
  })

  // DELETE /:id/positions/:positionId — remove position + its transactions
  // (cash effect is derived by replay, plan §62), mock parity:
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

    await database.transaction(async (tx) => {
      await tx
        .delete(portfolioTransactions)
        .where(
          and(
            eq(portfolioTransactions.positionId, positionId),
            eq(portfolioTransactions.portfolioId, portfolioId),
          ),
        )
      await tx.delete(positions).where(eq(positions.id, positionId))
      await recomputePortfolioTotals(tx, c.req.header("Authorization") ?? null, identity.id, portfolioId)
    })

    notifyTransactionsChanged(database, portfolioId, c.req.header("Authorization") ?? "")
    return c.json(positionWire(closed, portfolio, 0, await resolveRates(c.req.header("Authorization") ?? "", portfolio.baseCurrency, [closed.instrumentCurrency])))
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

  // Typed Drizzle column refs for safe sorting (no sql.raw ambiguity with JOIN)
  const TX_SORT_COLS: Record<string, unknown> = {
    symbol:   portfolioTransactions.instrumentSymbol,
    date:     portfolioTransactions.executedAt,
    type:     portfolioTransactions.type,
    quantity: portfolioTransactions.quantity,
    price:    portfolioTransactions.price,
    fees:     portfolioTransactions.fees,
    amount:   portfolioTransactions.totalAmount,
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
    const instrumentSymbol = c.req.query("instrumentSymbol")
    const labelsFilter = labelFilterIds(c.req.query("labels"))

    const conditions: SQL[] = [
      eq(portfolioTransactions.userId, identity.id),
      eq(portfolioTransactions.portfolioId, portfolioId),
    ]
    if (typeFilter) conditions.push(eq(portfolioTransactions.type, typeFilter.toUpperCase()))
    if (positionId) conditions.push(eq(portfolioTransactions.positionId, positionId))
    if (instrumentSymbol) {
      conditions.push(
        sql`upper(${portfolioTransactions.instrumentSymbol}) = upper(${instrumentSymbol})`,
      )
    }
    attachLabelCondition(
      conditions,
      portfolioTransactions.id,
      transactionLabels.transactionId,
      transactionLabels.labelId,
      transactionLabels,
      database,
      labelsFilter,
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sortColExpr = (TX_SORT_COLS[sortBy] ?? portfolioTransactions.executedAt) as any
    const sortFn      = sortOrder === "asc" ? asc : desc

    const [countRow] = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(portfolioTransactions)
      .where(and(...conditions))

    const total = countRow?.count ?? 0

    // LEFT JOIN positions to coalesce sector/country from the live profile
    // snapshot when the transaction row has them as null (they are only set
    // at write time if the caller supplies them; the profile refresh only
    // updates the position row, not old transaction rows).
    const rows = await database
      .select({ tx: portfolioTransactions, pos: positions })
      .from(portfolioTransactions)
      .leftJoin(positions, eq(portfolioTransactions.positionId, positions.id))
      .where(and(...conditions))
      .orderBy(sortFn(sortColExpr))
      .limit(limit)
      .offset(offset)

    const labelMap = await labelsForTransactions(
      database,
      rows.map(({ tx }) => tx.id),
    )
    const items = rows.map(({ tx, pos }) => ({
      ...serializeTx(tx, labelMap.get(tx.id) ?? []),
      sector:  tx.sector  ?? pos?.sector  ?? null,
      country: tx.country ?? pos?.country ?? null,
    }))

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
    const currency = (body.currency ?? body.instrumentCurrency ?? portfolio.baseCurrency).toUpperCase()
    const instCurrency = (body.instrumentCurrency ?? body.currency ?? portfolio.baseCurrency).toUpperCase()
    const price = body.price ?? body.averageCostBasis
    if (price == null) {
      return c.json({ error: "ValidationError", message: "price or averageCostBasis is required" }, 422)
    }
    const notional = body.quantity * price

    const fx = await resolveFeeFx(
      c.req.header("Authorization") ?? "",
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
          type: "BUY",
          instrumentSymbol: symbol,
          instrumentName: body.instrumentName ?? null,
          sector: body.sector ?? null,
          country: body.country ?? null,
          quantity: String(body.quantity),
          price: String(price),
          originalQuantity: String(body.quantity),
          originalPrice: String(price),
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

      // §87.5 — see the same block in POST /:id/transactions. A new position is a
      // BUY, so its funding leg is a DEPOSIT of the same gross the replay debits:
      // notional + the settled fees, converted into the row currency with the
      // rate this request already resolved.
      let cashLeg = null
      if (body.cashLeg) {
        const feesInRowCcy =
          (fx.feesSettled || 0) * (fx.fields.feeCurrency === currency ? 1 : fx.fields.feeExchangeRate ?? 1)
        const gross = round2(notional + feesInRowCcy)
        const [cash] = await tx
          .insert(portfolioCashTransactions)
          .values({
            userId: identity.id,
            portfolioId,
            type: "DEPOSIT",
            amount: String(gross),
            currency,
            description: `Buy: ${body.instrumentName ?? symbol}`,
            transactionDate: executedAt.toISOString().slice(0, 10),
            linkedTradeId: inserted.id,
          })
          .returning()
        cashLeg = cash
      }

      await recomputePortfolioTotals(tx, c.req.header("Authorization") ?? null, identity.id, portfolioId)

      return { transaction: inserted, position, cashLeg }
    })

    if ("error" in result) {
      return c.json({ error: "ValidationError", message: result.error }, 422)
    }
    if (!result.position) {
      return c.json({ error: "NotFound", message: "Position not found" }, 404)
    }

    // D58: enrich with live quote so 201 response has current price/market value
    await refreshQuotes(database, identity.id, portfolioId, c.req.header("Authorization") ?? "")
    await recomputePortfolioTotals(database, c.req.header("Authorization") ?? null, identity.id, portfolioId)

    const [fresh] = await database
      .select()
      .from(positions)
      .where(eq(positions.id, result.position.id))
    const totalValue = await openPositionsValue(database, identity.id, portfolioId)
    const fxRates = await resolveRates(c.req.header("Authorization") ?? "", portfolio.baseCurrency, [fresh.instrumentCurrency])

    notifyTransactionsChanged(database, portfolioId, c.req.header("Authorization") ?? "")
    return c.json(positionWire(fresh, portfolio, totalValue, fxRates), 201)
  })

  // ── E1: GET /:id/positions — full position list (example-service wire shape) ──

  routes.get("/:id/positions", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDb()!
    const portfolioId = c.req.param("id") as string

    const portfolio = await loadPortfolio(database, portfolioId, identity.id)
    if (!portfolio) return c.json({ error: "NotFound", message: "Portfolio not found" }, 404)

    // §76.1 — this route used to `await refreshQuotes(...)`, so *opening* a
    // portfolio wrote prices, today's snapshot and current_value through three
    // tables. Prices now come from the twice-daily cron and from writes; a read
    // prices nothing. Do not reintroduce the call here — §76.1's route tests
    // assert value_snapshots/current_value/price_as_of are unchanged by a GET.
    const labelsFilter = labelFilterIds(c.req.query("labels"))
    const conditions: SQL[] = [
      eq(positions.userId, identity.id),
      eq(positions.portfolioId, portfolioId),
    ]
    attachLabelCondition(
      conditions,
      positions.id,
      positionLabels.positionId,
      positionLabels.labelId,
      positionLabels,
      database,
      labelsFilter,
    )

    const posRows = await database
      .select()
      .from(positions)
      .where(and(...conditions))

    const totalValue = await openPositionsValue(database, identity.id, portfolioId)
    const fxRates = await resolveRates(c.req.header("Authorization") ?? "", portfolio.baseCurrency, posRows.map((p) => p.instrumentCurrency))
    const labelMap = await labelsForPositions(
      database,
      posRows.map((p) => p.id),
    )

    return c.json(
      posRows.map((p) =>
        positionWire(p, portfolio, totalValue, fxRates, labelMap.get(p.id) ?? []),
      ),
    )
  })

  // ── E3: GET /:id/allocation — sector/asset/currency breakdown ────────

  routes.get("/:id/allocation", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDb()!
    const portfolioId = c.req.param("id") as string

    const portfolio = await loadPortfolio(database, portfolioId, identity.id)
    if (!portfolio) return c.json({ error: "NotFound", message: "Portfolio not found" }, 404)

    // §76.1 — no refresh: this is a read (see GET /:id/positions above).

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

    // §66.3 — `positions.marketValue` is denominated in the POSITION's own
    // instrument currency (see quotes.ts: "market value is denominated in the
    // quote's currency (live) or the instrument currency (fallback)"). This
    // route used to add those raw numbers together, so totalValue and the
    // sector/asset-type breakdowns were a sum of EUR + USD + PLN — not a number
    // in any currency, which is why the tab could not be given a currency label.
    //
    // Convert every position into the portfolio's base currency first. byCurrency
    // is deliberately left unconverted: it groups BY instrument currency, so
    // each row is already internally consistent and its `name` is the currency.
    const toBase = await fxTo(c.req.header("Authorization") ?? "", portfolio.baseCurrency, new Map(), { strict: true })
    const baseValue = async (p: (typeof posRows)[number]): Promise<number> => {
      const raw = p.marketValue != null ? Number(p.marketValue) : Number(p.quantity) * Number(p.averageCostBasis)
      return raw * (await toBase(p.instrumentCurrency ?? ""))
    }

    let totalValue = 0
    for (const p of posRows) totalValue += await baseValue(p)

    async function sumByBase(field: string) {
      const totals = new Map<string, number>()
      for (const p of posRows) {
        const key = (p as Record<string, unknown>)[field] || "Other"
        totals.set(String(key), (totals.get(String(key)) || 0) + (await baseValue(p)))
      }
      return [...totals.entries()]
        .map(([name, value]) => ({ name, value: round2(value) }))
        .sort((a, b) => b.value - a.value)
    }

    function sumByOwnCurrency(field: string) {
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
      currency: portfolio.baseCurrency,
      totalValue: round2(totalValue),
      bySector: await sumByBase("sector"),
      byAssetType: await sumByBase("assetType"),
      byCurrency: sumByOwnCurrency("instrumentCurrency"),
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

    // §76.1 — no refresh: this is a read (see GET /:id/positions above). The
    // endpoint and its response shape are unchanged; only the write is gone.

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

function serializeTx(r: typeof portfolioTransactions.$inferSelect, labels: Label[] = []) {
  return {
    id: r.id,
    portfolioId: r.portfolioId,
    positionId: r.positionId,
    type: r.type,
    instrumentSymbol: r.instrumentSymbol,
    instrumentName: r.instrumentName,
    sector: r.sector,
    country: r.country,
    labels,
    quantity: Number(r.quantity),
    price: Number(r.price),
    fees: r.fees != null ? Number(r.fees) : 0,
    taxes: r.taxes != null ? Number(r.taxes) : null,
    notes: r.notes ?? null,
    feesType: r.feesType,
    feeCurrency: r.feeCurrency,
    feesSettled: Number(r.feesSettled),
    feeRateSource: r.feeRateSource,
    feeExchangeRate: r.feeExchangeRate != null ? Number(r.feeExchangeRate) : null,
    totalAmount: Number(r.totalAmount),
    currency: r.currency,
    instrumentCurrency: r.instrumentCurrency,
    displayCurrency: r.displayCurrency ?? r.currency,
    priceCurrency: r.currency,
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
  const getDb = () => db ?? resolveDb()

  routes.get("/", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDb()!

    const page = Math.max(1, Number(c.req.query("page")) || 1)
    const limit = Math.min(100, Math.max(1, Number(c.req.query("limit")) || 10))
    const offset = (page - 1) * limit
    const sortBy = c.req.query("sortBy") ?? "date"
    const sortOrder = (c.req.query("sortOrder") ?? "desc").toLowerCase() === "asc" ? "asc" : "desc"
    const labelsFilter = labelFilterIds(c.req.query("labels"))
    const instrumentSymbol = c.req.query("instrumentSymbol")

    const conditions: SQL[] = [sql`${portfolioTransactions.userId} = ${identity.id}`]
    if (instrumentSymbol) {
      conditions.push(
        sql`upper(${portfolioTransactions.instrumentSymbol}) = upper(${instrumentSymbol})`,
      )
    }
    attachLabelCondition(
      conditions,
      portfolioTransactions.id,
      transactionLabels.transactionId,
      transactionLabels.labelId,
      transactionLabels,
      database,
      labelsFilter,
    )

    const [countRow] = await database
      .select({ count: sql<number>`count(*)::int` })
      .from(portfolioTransactions)
      .where(and(...conditions))

    const total = countRow?.count ?? 0

    // Map sort key to the actual Drizzle column on portfolioTransactions
    const SORT_COL_MAP: Record<string, unknown> = {
      symbol: portfolioTransactions.instrumentSymbol,
      date: portfolioTransactions.executedAt,
      type: portfolioTransactions.type,
      quantity: portfolioTransactions.quantity,
      price: portfolioTransactions.price,
      fees: portfolioTransactions.fees,
      amount: portfolioTransactions.totalAmount,
    }
    const sortColumn = SORT_COL_MAP[sortBy] ?? portfolioTransactions.executedAt
    const sortFn = sortOrder === "asc" ? asc : desc

    const rows = await database
      .select({
        tx: portfolioTransactions,
        portfolioName: portfolios.name,
        positionRow: positions,
      })
      .from(portfolioTransactions)
      .leftJoin(portfolios, eq(portfolioTransactions.portfolioId, portfolios.id))
      .leftJoin(positions, eq(portfolioTransactions.positionId, positions.id))
      .where(and(...conditions))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .orderBy(sortFn(sortColumn as any))
      .limit(limit)
      .offset(offset)

    const labelMap = await labelsForTransactions(
      database,
      rows.map((r) => r.tx.id),
    )

    return c.json({
      items: rows.map((r) => ({
        ...serializeTx(r.tx, labelMap.get(r.tx.id) ?? []),
        portfolioName: r.portfolioName ?? "",
        sector:  r.tx.sector  ?? r.positionRow?.sector  ?? null,
        country: r.tx.country ?? r.positionRow?.country ?? null,
      })),
      total,
      page,
      limit,
    })
  })

  return routes
}
