import { and, eq, inArray, isNull, ne, or } from "drizzle-orm"
import type { DB } from "../db/index.js"
import { portfolioTransactions } from "../db/schema.js"
import { LOT_QUANTITY_TYPES, quantitySign } from "../transaction-types.js"
import {
  drawLots,
  openLots,
  openQuantity,
  type LotDraw,
  type LotTx,
  type OpenLot,
} from "./openLots.js"
import { loadCumFactor, optionPremiumLegIds } from "./splitFactors.js"

const QTY_EPS = 1e-8
const round2 = (n: number) => Math.round(n * 100) / 100
const round8 = (n: number) => Math.round(n * 1e8) / 1e8

/**
 * The FIFO queue for one position membership, and the sale arithmetic that
 * consumes it.
 *
 * `positions` keeps one row per position with a weighted `averageCostBasis`.
 * That number is enough to value what is still held, but not to attribute a
 * sale: two lots bought at 10 and 12 have an average of 11, and a sale at 15
 * must book 5 against the 10 lot and 3 against the 12 lot, not 4 against the
 * average. The transaction ledger already carries every opening and closing leg
 * — BUY, TRANSFER_IN, SELL, EXPIRATION, TRANSFER_OUT — so the queue is derived
 * from it. `openLots` owns the walk and the split restatement; this module adds
 * the two things the sale path needs on top:
 *
 * - **A buy's settled fee is part of the lot's cost.** The ledger stores the fee
 *   separately, and the position's `averageCostBasis` has always folded it in —
 *   the importer did, and since #82 the interactive BUY does too. Folding it into
 *   the opening lot keeps the queue consistent with the position row, so a sale
 *   that consumes a lot and a sale priced off the average agree, and the
 *   position's average stays the weighted cost of the remaining lots.
 * - **The position row is the reconciliation point.** A manual quantity edit or
 *   an imported position with no linked rows has no opening transaction, so the
 *   difference between the queue and `positions.quantity` is represented by a
 *   synthetic lot at the position's average. Without this, a sale would see a
 *   shorter queue than the position it is selling and refuse a legal quantity.
 *
 * Short-option premium lots are deliberately excluded by {@link fifoApplies}: a
 * short opening SELL is not a lot acquisition, and `openLots` models signs by
 * transaction type, not by position direction. Those keep the moving average.
 */

export type FifoPosition = {
  id: string
  userId: string
  symbol: string
  quantity: string | number
  averageCostBasis: string | number
  assetType: string | null
  direction: string | null
  openedAt: Date
}

export type FifoRow = {
  id: string
  type: string
  executedAt: Date
  quantity: string | number
  price: string | number
  originalQuantity: string | number | null
  originalPrice: string | number | null
  externalId?: string | null
  externalSource?: string | null
  feesSettled: string | number | null
  feesType: string | null
  feeCurrency: string | null
  currency: string
  convertedFees: string | number | null
  exchangeRate: string | number | null
}

/** FIFO is for long, non-option positions. Short premium lots keep the average. */
export function fifoApplies(position: Pick<FifoPosition, "assetType" | "direction">): boolean {
  const asset = (position.assetType ?? "STOCK").toUpperCase()
  const direction = (position.direction ?? "LONG").toUpperCase()
  return asset !== "OPTION" && direction !== "SHORT"
}

/**
 * The fee's value in the transaction currency, reconstructed from the stored
 * row. `feesSettled` is native (possibly another currency); `convertedFees` is
 * the same fee in the portfolio base. Dividing the base value by the trade's
 * own base rate is exactly the transaction-currency equivalent the position
 * math uses — using `feeExchangeRate` directly would be the fee -> base axis,
 * not fee -> trade, and would multiply by the trade rate a second time.
 *
 * Only an opening leg folds a fee in, and the fee is always the row's own: a
 * closing row's fee belongs to realised P/L, not to the cost of what is left.
 * `averageCostBasis` folds an opening BUY's fee in on both the interactive and
 * the import path (the interactive route was brought in line by #82), so the
 * queue has to agree or a sale would book a different basis than the average.
 */
function feeInTradeCurrency(row: FifoRow): number {
  const amount = Math.abs(Number(row.feesSettled ?? 0))
  if (!Number.isFinite(amount) || amount === 0) return 0
  if (row.feesType === "pct") return amount

  const feeCurrency = (row.feeCurrency ?? row.currency).toUpperCase()
  const tradeCurrency = row.currency.toUpperCase()
  if (feeCurrency === tradeCurrency) return amount

  const converted = Number(row.convertedFees)
  const tradeRate = Number(row.exchangeRate)
  if (Number.isFinite(converted) && Number.isFinite(tradeRate) && tradeRate > 0) {
    return round8(converted / tradeRate)
  }
  // No converted figure (an old or hand-written row): the stored amount is the
  // only value available. It is wrong for a cross-currency fee, but the row has
  // already lost the rate needed to do better.
  return amount
}

/**
 * One ledger row as `openLots` expects it, with the opening cost per unit.
 *
 * The fee is folded in before the split restatement so the arithmetic stays
 * right: a split multiplies quantity and divides price, and
 * `(q × p + fee) / (q × cum)` is the restated unit cost. Passing the raw price
 * would divide the fee by the split factor too.
 */
function toLotTx(row: FifoRow): LotTx {
  const quantity = Number(row.quantity)
  const price = Number(row.price)
  const originalQuantity = row.originalQuantity == null ? null : Number(row.originalQuantity)
  const originalPrice = row.originalPrice == null ? null : Number(row.originalPrice)
  const fee = quantitySign(row.type) > 0 ? feeInTradeCurrency(row) : 0

  const unitPrice = quantity > 0 ? (quantity * price + fee) / quantity : price
  const unitOriginalPrice =
    originalQuantity != null && originalQuantity > 0 && originalPrice != null
      ? (originalQuantity * originalPrice + fee) / originalQuantity
      : null

  return {
    id: row.id,
    type: row.type,
    executedAt: new Date(row.executedAt),
    quantity,
    price: unitPrice,
    originalQuantity,
    originalPrice: unitOriginalPrice,
    externalId: row.externalId ?? null,
  }
}

/** Build the queue from ledger rows without touching the database. */
export function lotsFromRows(
  rows: FifoRow[],
  cumFor: (executedAt: Date) => number,
  ignoreExternalIds?: ReadonlySet<string>,
): OpenLot[] {
  return openLots(rows.map(toLotTx), cumFor, ignoreExternalIds)
}

/**
 * Load the open queue for one position membership, reconciled against the
 * position row. Rows linked to the position are read, plus unlinked rows for
 * the same symbol — the legacy shape and the receiving side of an older
 * transfer, whose `position_id` was never written. The in-flight SELL is
 * excluded by id: it is inserted before `processSell` and has no position link
 * yet, so including it would consume the lot twice.
 */
export async function loadFifoLots(
  tx: DB,
  position: FifoPosition,
  portfolioId: string,
  /** The in-flight SELL row, inserted before processSell but not yet linked. */
  excludeTransactionId?: string,
): Promise<OpenLot[]> {
  const linked = or(
    eq(portfolioTransactions.positionId, position.id),
    and(
      isNull(portfolioTransactions.positionId),
      eq(portfolioTransactions.instrumentSymbol, position.symbol),
      excludeTransactionId
        ? ne(portfolioTransactions.id, excludeTransactionId)
        : undefined,
    ),
  )!

  const rows = (await tx
    .select({
      id: portfolioTransactions.id,
      type: portfolioTransactions.type,
      executedAt: portfolioTransactions.executedAt,
      quantity: portfolioTransactions.quantity,
      price: portfolioTransactions.price,
      originalQuantity: portfolioTransactions.originalQuantity,
      originalPrice: portfolioTransactions.originalPrice,
      externalId: portfolioTransactions.externalId,
      externalSource: portfolioTransactions.externalSource,
      feesSettled: portfolioTransactions.feesSettled,
      feesType: portfolioTransactions.feesType,
      feeCurrency: portfolioTransactions.feeCurrency,
      currency: portfolioTransactions.currency,
      convertedFees: portfolioTransactions.convertedFees,
      exchangeRate: portfolioTransactions.exchangeRate,
    })
    .from(portfolioTransactions)
    .where(
      and(
        eq(portfolioTransactions.userId, position.userId),
        eq(portfolioTransactions.portfolioId, portfolioId),
        linked,
        inArray(portfolioTransactions.type, [...LOT_QUANTITY_TYPES]),
      ),
    )
    .orderBy(portfolioTransactions.executedAt, portfolioTransactions.id)) as FifoRow[]

  const cumFor = await loadCumFactor(tx, position.symbol)
  const ignore = await optionPremiumLegIds(tx, portfolioId)
  const lots = lotsFromRows(rows, cumFor, ignore)
  return reconcileWithPosition(lots, position)
}

/**
 * The position row is the authority on how much exists. The ledger is the
 * authority on what each unit cost. When they disagree — a manual quantity
 * edit, or a position imported before its rows were linked — the difference is
 * one synthetic lot at the position's average, not a refusal to sell.
 */
function reconcileWithPosition(lots: OpenLot[], position: FifoPosition): OpenLot[] {
  const positionQuantity = round8(Number(position.quantity))
  const ledgerQuantity = openQuantity(lots)

  if (ledgerQuantity < positionQuantity - QTY_EPS) {
    return [
      ...lots,
      {
        txId: `position:${position.id}`,
        price: Number(position.averageCostBasis),
        remaining: round8(positionQuantity - ledgerQuantity),
        openedAt: new Date(position.openedAt),
      },
    ]
  }

  if (ledgerQuantity > positionQuantity + QTY_EPS) {
    // A manual edit reduced the holding without a closing leg. Trim the newest
    // lots first: the edit is a correction to what is held now, and the oldest
    // cost is the one FIFO is supposed to preserve.
    let excess = round8(ledgerQuantity - positionQuantity)
    for (let i = lots.length - 1; i >= 0 && excess > QTY_EPS; i--) {
      const take = Math.min(lots[i].remaining, excess)
      lots[i].remaining = round8(lots[i].remaining - take)
      excess = round8(excess - take)
    }
  }

  return lots.filter((lot) => lot.remaining > QTY_EPS)
}

/** Remove the drawn quantity from the queue and return what is left. */
export function applyDraw(lots: OpenLot[], draws: LotDraw[]): OpenLot[] {
  for (const draw of draws) {
    const lot = lots.find((candidate) => candidate.txId === draw.txId && candidate.remaining > QTY_EPS)
    if (lot) lot.remaining = round8(lot.remaining - draw.quantity)
  }
  return lots.filter((lot) => lot.remaining > QTY_EPS)
}

/** FIFO realized P/L for one sale: each unit against the lot it came from. */
export function realizedFromDraws(draws: LotDraw[], salePrice: number, saleFee: number): number {
  const gross = draws.reduce((sum, draw) => sum + draw.quantity * (salePrice - draw.price), 0)
  return round2(gross - saleFee)
}

/** Total quantity still open in a queue. */
export function quantityFromLots(lots: OpenLot[]): number {
  return openQuantity(lots)
}

/** Weighted average cost of what remains — the position's new `averageCostBasis`. */
export function averageFromLots(lots: OpenLot[]): number {
  const quantity = openQuantity(lots)
  if (quantity <= QTY_EPS) return 0
  return round8(lots.reduce((sum, lot) => sum + lot.remaining * lot.price, 0) / quantity)
}

/** Draw a sale from a queue, returning the draws and the remaining lots. */
export function drawFromLots(lots: OpenLot[], quantity: number) {
  const { draws, shortfall } = drawLots(lots, quantity)
  return { draws, shortfall, remaining: applyDraw(lots, draws) }
}