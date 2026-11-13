import { and, eq, inArray } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import type { DB } from "../db/index.js"
import { portfolioTransactions, positionLabels } from "../db/schema.js"
import { LOT_QUANTITY_TYPES } from "../transaction-types.js"
import { drawLots, openLots, openQuantity, type LotTx } from "./openLots.js"
import { loadCumFactor, optionPremiumLegIds } from "./splitFactors.js"
import { transferCloseForDate } from "./backfill.js"
import { resolveServiceToken } from "./instruments-fx.js"
import { decrementTransferPosition, upsertImportPositionOnBuy } from "./positions.js"

const round2 = (n: number) => Math.round(n * 100) / 100
const scale8 = (n: number) => n.toFixed(8)

/**
 * The types that move quantity, and so participate in the FIFO queue.
 * Alias kept local so the leg builder does not depend on the importer's naming.
 */
const LOT_TYPES = LOT_QUANTITY_TYPES

/**
 * A transfer failure, in the same shape the importer reports rows in: a machine
 * code plus a message. The bulk importer wraps it in `ImportRowError` so the row
 * is attributed to its sheet id; the interactive route turns it straight into a
 * 422. Both entry points therefore reject the same situations with the same codes
 * instead of each inventing its own.
 */
export class TransferError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

export interface TransferLegInput {
  userId: string
  sourcePortfolioId: string
  targetPortfolioId: string
  symbol: string
  instrumentName: string | null
  assetType: string
  /** Quantity in CURRENT (post-restatement) units — the FIFO queue is already restated. */
  quantity: number
  executedAt: Date
  /** Currency the row is stored in. */
  txCcy: string
  /** The instrument's listing currency, when known. */
  listingCcy: string
  /** txCcy -> source portfolio base-currency rate, already resolved by the caller. */
  rate: number
  /** Provenance tag; null for a row created interactively. */
  externalSource: string | null
  /** Dedup prefix for the legs (`${row.externalId}#x{i}`); null when there is no source row. */
  externalId: string | null
  positionLabelIds: string[]
  sourceBaseCurrency: string
  targetBaseCurrency: string
  sector?: string | null
  industry?: string | null
  country?: string | null
}

/**
 * An in-kind transfer: the instrument, unchanged, moves from one portfolio to
 * another. It is NOT a sale — nothing is disposed of, so no realised P/L is
 * booked and no cash moves.
 *
 * The quantity is drawn FIFO from the sending portfolio's open lots, producing
 * one `TRANSFER_OUT` row per lot drawn at **that lot's own price**, each with a
 * derived `TRANSFER_IN` carrying the same price and quantity. A weighted average
 * would land on the same `averageCostBasis`; the difference is that these rows
 * name the lot they came from, so the receiving portfolio's FIFO queue is correct
 * without re-deriving anything.
 *
 * The whole group is one atomic unit — `tx` is the caller's transaction, and a
 * failure anywhere here must roll the entire group back. Stock that has left
 * without its counterpart having arrived is the worst state this table can hold.
 *
 * Shared by the bulk importer (which reaches it through a `TRANSFER_OUT` sheet
 * row) and `POST /api/portfolios/:id/transfers` (which reaches it from the UI).
 * Keeping it here is what stops the two from disagreeing on what a transfer is.
 */
export async function buildTransferLegs(tx: DB, input: TransferLegInput) {
  const {
    userId,
    sourcePortfolioId,
    targetPortfolioId,
    symbol,
    instrumentName,
    assetType,
    quantity,
    executedAt,
    txCcy,
    listingCcy,
    rate,
    externalSource,
    externalId,
    positionLabelIds,
    sourceBaseCurrency,
    targetBaseCurrency,
    sector,
    industry,
    country,
  } = input

  const optionLegs = await optionPremiumLegIds(tx, sourcePortfolioId)
  const cumFor = await loadCumFactor(tx, symbol)
  const rows = await tx
    .select({
      id: portfolioTransactions.id,
      type: portfolioTransactions.type,
      executedAt: portfolioTransactions.executedAt,
      quantity: portfolioTransactions.quantity,
      price: portfolioTransactions.price,
      originalQuantity: portfolioTransactions.originalQuantity,
      originalPrice: portfolioTransactions.originalPrice,
      externalId: portfolioTransactions.externalId,
    })
    .from(portfolioTransactions)
    .where(
      and(
        eq(portfolioTransactions.userId, userId),
        eq(portfolioTransactions.portfolioId, sourcePortfolioId),
        eq(portfolioTransactions.instrumentSymbol, symbol),
        inArray(portfolioTransactions.type, [...LOT_TYPES]),
      ),
    )

  const lots = openLots(rows as unknown as LotTx[], cumFor, optionLegs)
  const { draws, shortfall } = drawLots(lots, quantity)
  if (shortfall > 1e-8) {
    // Refuse the whole request rather than move less than was asked. A shortfall is
    // not a partial transfer — it means the queue disagrees with the holding.
    throw new TransferError(
      "transfer_exceeds_open_lots",
      `TRANSFER_OUT of ${quantity} exceeds ${openQuantity(lots)} open in ${symbol}`,
    )
  }

  // A transfer prices nothing, but the daily valuation grid still needs a close
  // for the symbol on the transfer date in BOTH portfolios' base currencies, or
  // the rebuilt history has a hole the snapshot series cannot fill. Checked before
  // any insert so a failure leaves nothing behind.
  const day = executedAt.toISOString().slice(0, 10)
  for (const baseCurrency of new Set([sourceBaseCurrency.toUpperCase(), targetBaseCurrency.toUpperCase()])) {
    let close: number | null
    try {
      close = await transferCloseForDate(symbol, day, resolveServiceToken(), baseCurrency, listingCcy)
    } catch (err) {
      throw new TransferError(
        "transfer_price_source_unavailable",
        `${symbol} ${day} in ${baseCurrency}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (close == null || !Number.isFinite(close) || close <= 0) {
      throw new TransferError(
        "transfer_price_missing",
        `No historical close for transfer ${symbol} on or before ${day} in ${baseCurrency}`,
      )
    }
  }

  const transferGroupId = randomUUID()
  let firstOut: typeof portfolioTransactions.$inferInsert | null = null
  let sourcePositionId: string | null = null
  let targetPositionId: string | null = null
  const legs: Array<{ out: typeof portfolioTransactions.$inferInsert; in: typeof portfolioTransactions.$inferInsert }> = []

  for (const [i, draw] of draws.entries()) {
    const total = round2(draw.quantity * draw.price)
    const [out] = await tx
      .insert(portfolioTransactions)
      .values({
        userId,
        portfolioId: sourcePortfolioId,
        type: "TRANSFER_OUT",
        instrumentSymbol: symbol,
        instrumentName,
        quantity: scale8(draw.quantity),
        price: scale8(draw.price),
        originalQuantity: scale8(draw.quantity),
        originalPrice: scale8(draw.price),
        currency: txCcy,
        instrumentCurrency: listingCcy,
        assetType,
        totalAmount: String(total),
        // Nothing was disposed of, so there is no realised P/L to book.
        realizedGainLoss: null,
        exchangeRate: String(rate),
        convertedTotalAmount: String(round2(total * rate)),
        convertedPrice: String(round2(draw.price * rate)),
        transferGroupId,
        sourceTransactionId: draw.txId,
        externalSource,
        // Indexed so a re-import produces byte-identical suffixes and the
        // insert-only sync does not orphan the previous group.
        externalId: externalId ? `${externalId}#x${i}` : null,
        executedAt,
      })
      .returning()

    const [inRow] = await tx
      .insert(portfolioTransactions)
      .values({
        userId,
        portfolioId: targetPortfolioId,
        type: "TRANSFER_IN",
        instrumentSymbol: symbol,
        instrumentName,
        quantity: scale8(draw.quantity),
        price: scale8(draw.price),
        originalQuantity: scale8(draw.quantity),
        originalPrice: scale8(draw.price),
        currency: txCcy,
        instrumentCurrency: listingCcy,
        assetType,
        totalAmount: String(total),
        realizedGainLoss: null,
        exchangeRate: String(rate),
        convertedTotalAmount: String(round2(total * rate)),
        convertedPrice: String(round2(draw.price * rate)),
        transferGroupId,
        linkedTransferId: out.id,
        sourceTransactionId: draw.txId,
        externalSource,
        externalId: externalId ? `${externalId}#xi${i}` : null,
        executedAt,
      })
      .returning()

    await tx
      .update(portfolioTransactions)
      .set({ linkedTransferId: inRow.id })
      .where(eq(portfolioTransactions.id, out.id))

    legs.push({ out, in: inRow })

    if (i === 0) {
      firstOut = out
      // Labels belong to the position the stock left, as a BUY's would.
      const pos = await decrementTransferPosition(tx, userId, sourcePortfolioId, symbol, draw.quantity)
      sourcePositionId = pos?.id ?? null
      await tx
        .update(portfolioTransactions)
        .set({ positionId: sourcePositionId })
        .where(eq(portfolioTransactions.id, out.id))
    } else {
      await decrementTransferPosition(tx, userId, sourcePortfolioId, symbol, draw.quantity)
    }

    // The receiving side takes the lot at its source cost, so the weighted
    // formula lands on exactly the FIFO composition.
    const targetPos = await upsertImportPositionOnBuy(tx, userId, targetPortfolioId, {
      symbol,
      instrumentName,
      quantity: draw.quantity,
      price: draw.price,
      currency: txCcy,
      assetType,
      feeInTransactionCurrency: 0,
      listingCurrency: listingCcy,
      executedAt,
      sector: sector ?? null,
      industry: industry ?? null,
      country: country ?? null,
    })
    targetPositionId = targetPos.id
  }

  if (positionLabelIds.length > 0 && sourcePositionId) {
    await tx.delete(positionLabels).where(eq(positionLabels.positionId, sourcePositionId))
    await tx
      .insert(positionLabels)
      .values(positionLabelIds.map((labelId) => ({ positionId: sourcePositionId, labelId })))
  }

  return {
    transferGroupId,
    legs,
    firstOut: firstOut!,
    quantity: draws.reduce((sum, d) => sum + d.quantity, 0),
    sourcePositionId,
    targetPositionId,
  }
}
