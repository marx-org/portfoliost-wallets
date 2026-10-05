 /**
 * The FIFO open-lot queue for one (portfolio, symbol), as a pure function.
 *
 * `positions` carries a single moving `averageCostBasis` per holding, so the
 * original buys are not tracked as lots — but every BUY row survives with its
 * own quantity and price, and `restatePositions` (routes/internal.ts) already
 * replays BUY/SELL in date order to rebuild the holding. This is that same walk
 * keeping a per-lot remainder instead of one running average, which is all a
 * FIFO queue is.
 *
 * It is pure and takes no DB handle so the arithmetic can be tested directly.
 *
 * ## What opens a lot and what consumes one
 *
 * Opens:    BUY, TRANSFER_IN
 * Consumes: SELL, EXPIRATION, TRANSFER_OUT
 * Ignores:  DIVIDEND
 *
 * TRANSFER_IN opens a lot because it *is* a lot on the receiving side: it carries
 * the source lot's own price, so the receiving portfolio's queue is correct
 * without re-deriving anything. TRANSFER_OUT consumes on the sending side. The
 * two legs sit in different portfolios, so neither can double-count.
 *
 * ## Restatement, and why it matters
 *
 * A lot split since it was opened has a smaller remainder than its `quantity`
 * column suggests. `originalQuantity × cumFor(executedAt)` is the figure that
 * reflects the split, and the restated price is `originalPrice / cum` — the same
 * arithmetic `restatePositions` uses (internal.ts). Drawing against the raw
 * quantity over-sells a lot that has already been split.
 *
 * ## Tiebreak
 *
 * `(executedAt, id)` — the order `restatePositions` uses. A different tiebreak
 * silently draws a different lot, so it is pinned by a test rather than left to
 * whatever the database happens to return.
 */

export type LotTx = {
  id: string
  type: string
  executedAt: Date
  quantity: string | number
  price: string | number
  originalQuantity: string | number | null
  originalPrice: string | number | null
  externalId?: string | null
}

export type OpenLot = {
  /** The transaction that opened this lot — a BUY, or a TRANSFER_IN. */
  txId: string
  /** The restated per-unit cost carried over from the source lot. */
  price: number
  /** Quantity still held from this lot. */
  remaining: number
  openedAt: Date
}

import { quantitySign } from "../transaction-types.js"

export type LotDraw = OpenLot & { quantity: number }

const QTY_EPS = 1e-8
const round8 = (n: number) => Math.round(n * 1e8) / 1e8

/** Cumulative split factor on a date; 1 when nothing has split. */
export type CumFactor = (d: Date) => number

function restated(tx: LotTx, cumFor: CumFactor): { quantity: number; price: number } {
  const q = Number(tx.quantity)
  const p = Number(tx.price)
  if (tx.originalQuantity == null || tx.originalPrice == null) return { quantity: q, price: p }
  const cum = cumFor(new Date(tx.executedAt))
  if (Math.abs(cum - 1) <= 1e-12) return { quantity: q, price: p }
  return { quantity: round8(Number(tx.originalQuantity) * cum), price: round8(Number(tx.originalPrice) / cum) }
}

/**
 * Open lots oldest-first. Consumption never goes negative: a row that asks for
 * more than is open takes everything available, and the shortfall is visible to
 * the caller as a smaller total. The transfer path needs that — it must reject
 * the whole row rather than silently move less than was asked for.
 */
export function openLots(
  rows: LotTx[],
  cumFor: CumFactor,
  /**
   * Base external ids of option-premium pairs to ignore. Neither leg is a share
   * disposal — the premium SELL's quantity is in CONTRACT units of the underlying.
   * Without this the queue drains on premium sells and a real transfer finds
   * nothing open. See {@link optionPremiumLegIds}.
   */
  ignoreExternalIds?: ReadonlySet<string>,
): OpenLot[] {
  const ordered = [...rows]
    .filter((r) => !r.externalId || !ignoreExternalIds?.has(r.externalId.replace(/#e$/, "")))
    .sort((a, b) => {
      const d = new Date(a.executedAt).getTime() - new Date(b.executedAt).getTime()
      return d !== 0 ? d : a.id.localeCompare(b.id)
    })

  const lots: OpenLot[] = []
  for (const row of ordered) {
    const { quantity, price } = restated(row, cumFor)
    const sign = quantitySign(row.type)
    if (sign > 0) {
      if (quantity > QTY_EPS) {
        lots.push({ txId: row.id, price, remaining: round8(quantity), openedAt: new Date(row.executedAt) })
      }
      continue
    }
    if (sign === 0) continue

    let left = quantity
    for (const lot of lots) {
      if (left <= QTY_EPS) break
      const take = Math.min(lot.remaining, left)
      lot.remaining = round8(lot.remaining - take)
      left = round8(left - take)
    }
  }

  return lots.filter((l) => l.remaining > QTY_EPS)
}

/** Total quantity still open across the queue. */
export const openQuantity = (lots: OpenLot[]): number =>
  round8(lots.reduce((sum, l) => sum + l.remaining, 0))

/**
 * Draw `quantity` off the queue oldest-lot-first.
 *
 * Returns the per-lot draws plus the shortfall, so a caller can refuse the whole
 * operation rather than move a partial quantity. A partial transfer is legal and
 * is just a smaller `quantity`; a shortfall means the caller asked for more than
 * exists.
 */
export function drawLots(lots: OpenLot[], quantity: number): { draws: LotDraw[]; shortfall: number } {
  const draws: LotDraw[] = []
  let left = round8(quantity)
  for (const lot of lots) {
    if (left <= QTY_EPS) break
    const take = round8(Math.min(lot.remaining, left))
    if (take <= QTY_EPS) continue
    draws.push({ txId: lot.txId, price: lot.price, remaining: lot.remaining, quantity: take, openedAt: lot.openedAt })
    left = round8(left - take)
  }
  return { draws, shortfall: left }
}