/**
 * The one place the position-transaction type set is written down.
 *
 * It used to be declared in five places and the declarations disagreed:
 * `ck_ptx_type` (schema), the import Zod enum, the interactive-create Zod enum,
 * `TRADE_CASH_TYPES` in the cash ledger, and an inline array in portfolio-cash.
 * `EXPIRATION` was added to four of the five and missed from the interactive
 * create route, which then rejected a type the import accepted — found by
 * reading code, not by a failing test. `schema.test.ts` now compares the SQL
 * check against this array so that class of drift fails the build instead.
 *
 * Two axes, and conflating them is what made the old lists diverge:
 *
 * - `POSITION_TX_TYPES` — every value `transactions.type` may hold.
 * - `TRADE_CASH_TYPES` — the subset that moves cash. An in-kind transfer moves
 *   an instrument and is deliberately excluded, so a transfer must never reach
 *   `tradeCashEffects`. That function signs `tx.type === "BUY" ? -1 : 1`
 *   (cashLedger.ts), i.e. it credits anything that is not a BUY, so admitting a
 *   transfer there would invent cash out of nothing.
 */

/** Every value `portfolios.transactions.type` may hold. */
export const POSITION_TX_TYPES = [
  "BUY",
  "SELL",
  "DIVIDEND",
  "EXPIRATION",
  "TRANSFER_OUT",
  "TRANSFER_IN",
] as const

export type PositionTxType = (typeof POSITION_TX_TYPES)[number]

/**
 * The in-kind transfer pair. One sheet row emits a TRANSFER_OUT, and the server
 * derives one TRANSFER_IN per source lot it draws FIFO — so a single transfer is
 * several rows, tied together by `transfer_group_id`.
 */
export const TRANSFER_TX_TYPES = ["TRANSFER_OUT", "TRANSFER_IN"] as const

/**
 * The types whose principal leg moves cash in `tradeCashEffects`, and the only
 * ones `dailyExternalFlows`/`externalCashInvested` treat as funded trades.
 *
 * EXPIRATION is absent because it closes a position for nothing. TRANSFER_OUT
 * and TRANSFER_IN are absent because stock changing custody is not a payment —
 * see the module comment.
 */
export const TRADE_CASH_TYPES = ["BUY", "SELL", "DIVIDEND"] as const

export type TradeCashType = (typeof TRADE_CASH_TYPES)[number]

/** A transfer moves a position with no cash effect; the model to follow is EXPIRATION's. */
export function isTransferType(type: string): type is (typeof TRANSFER_TX_TYPES)[number] {
  return type === "TRANSFER_OUT" || type === "TRANSFER_IN"
}

export function isTradeCashType(type: string): type is TradeCashType {
  return (TRADE_CASH_TYPES as readonly string[]).includes(type)
}

/**
 * Which types move a position's quantity, and in which direction.
 *
 * One rule, three consumers: the FIFO queue (`openLots`), the daily valuation grid
 * (`backfill`) and the snapshot window. They disagreed once already — the grid
 * read "not a BUY means a decrement", which would have decremented a TRANSFER_IN
 * that had just arrived and driven a receiving portfolio's quantity negative.
 */
export const LOT_OPENING_TYPES = ["BUY", "TRANSFER_IN"] as const
export const LOT_CLOSING_TYPES = ["SELL", "EXPIRATION", "TRANSFER_OUT"] as const
export const LOT_QUANTITY_TYPES = [...LOT_OPENING_TYPES, ...LOT_CLOSING_TYPES] as const

/** +1 opens a lot, −1 closes one, 0 does not move quantity. */
export function quantitySign(type: string): 1 | -1 | 0 {
  if ((LOT_OPENING_TYPES as readonly string[]).includes(type)) return 1
  if ((LOT_CLOSING_TYPES as readonly string[]).includes(type)) return -1
  return 0
}
