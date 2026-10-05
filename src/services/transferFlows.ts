import { and, eq, inArray } from "drizzle-orm"
import type { DB } from "../db/index.js"
import { portfolioTransactions } from "../db/schema.js"
import { TRANSFER_TX_TYPES } from "../transaction-types.js"
import { rateToBase } from "./cashLedger.js"
import { toDateStr } from "./cashLedger.js"

/**
 * The daily flow an in-kind transfer contributes to the **return** calculation.
 *
 * Distinct from `dailyExternalFlows`, which reads only `portfolio_cash_transactions`
 * and so counts money that actually crossed the account boundary. A transfer moves
 * no cash, so it has no business there — adding one would inflate `invested` and
 * corrupt XIRR's capital basis. This is a derived figure instead, read from the
 * transfer leg pair.
 *
 * ## Why it exists
 *
 * Return series are neutral only against flows they know about. Equate+ holding a
 * position worth 55 and transferring all of it goes `V = 55 → V = 0` with zero
 * external flow, which reads as **−100%** for the day. IBKR symmetrically reads
 * +100%. Neither happened: the asset moved.
 *
 * So each side reports a signed flow at the **market value** that moved, which
 * neutralises the day to ~0%.
 *
 * ## Cost vs market — two different quantities, deliberately
 *
 * The **capital basis** (`invested`) moves at **cost**: it is a basis, so it
 * travels with the shares, and the accrued unrealised gain is just
 * `value − invested` and follows the holding. Moving the market value instead
 * would reset the basis upward and delete real profit — five shares bought at 10
 * and sold at 12 have a true gain of 10; rebasing them at the transfer-date
 * market of 11 leaves only 5.
 *
 * This flow is the **market** value, because its job is to offset how far `value`
 * actually moved. The two coincide only when the price has not moved since
 * purchase, so the distinction is easy to miss and must not be flattened.
 *
 * ## Sign
 *
 * `TRANSFER_OUT` is negative for the sending portfolio, `TRANSFER_IN` positive for
 * the receiving one. Each leg is counted once, from its own portfolio, so the two
 * offset exactly when summed — merged `value`, `invested` and return are all
 * unchanged by a transfer, which is the property worth asserting.
 */
export async function dailyTransferFlows(
  db: DB,
  authToken: string | null,
  portfolioId: string | string[],
  from: string,
  to: string,
  baseCurrency: string,
  opts: { strict?: boolean } = {},
): Promise<Map<string, number>> {
  const base = baseCurrency.toUpperCase()
  const ids = Array.isArray(portfolioId) ? portfolioId : [portfolioId]
  if (ids.length === 0) return new Map()

  const rows = await db
    .select({
      type: portfolioTransactions.type,
      totalAmount: portfolioTransactions.totalAmount,
      convertedTotalAmount: portfolioTransactions.convertedTotalAmount,
      displayCurrency: portfolioTransactions.displayCurrency,
      currency: portfolioTransactions.currency,
      executedAt: portfolioTransactions.executedAt,
    })
    .from(portfolioTransactions)
    .where(
      and(
        inArray(portfolioTransactions.portfolioId, ids),
        inArray(portfolioTransactions.type, [...TRANSFER_TX_TYPES]),
      ),
    )
    .orderBy(portfolioTransactions.executedAt)

  if (rows.length === 0) return new Map()

  const flows = new Map<string, number>()
  for (const r of rows) {
    const day = toDateStr(r.executedAt)
    if (!day || day < from || day > to) continue
    // Prefer the stored conversion so a base-currency portfolio needs no FX call;
    // fall back to a rate only when the snapshot never wrote one.
    let amount: number
    if (r.convertedTotalAmount != null && r.displayCurrency?.toUpperCase() === base) {
      amount = Number(r.convertedTotalAmount)
    } else {
      const toBase = await rateToBase(authToken, (r.currency ?? base).toUpperCase(), base, day, opts)
      amount = Number(r.totalAmount ?? 0) * toBase
    }
    const signed = r.type === "TRANSFER_OUT" ? -Math.abs(amount) : Math.abs(amount)
    flows.set(day, (flows.get(day) ?? 0) + signed)
  }
  return flows
}

/**
 * `net_flow + transferFlow` — what a return series must be neutral against.
 *
 * Kept as its own function so the two are never added together by accident at a
 * call site: `net_flow` feeds `invested` and XIRR's capital basis and must stay
 * external-only, while the neutralising flow feeds the daily return denominator.
 * Adding the transfer into `net_flow` is the failure this separation prevents.
 */
export function neutralisingFlows(
  external: Map<string, number>,
  transfers: Map<string, number>,
): Map<string, number> {
  const out = new Map<string, number>(external)
  for (const [day, v] of transfers) out.set(day, (out.get(day) ?? 0) + v)
  return out
}

/**
 * The **cost**-valued sibling of {@link dailyTransferFlows}, for the capital basis.
 *
 * Same rows, same signs, different amount: this one uses `quantity × price` — the
 * lot's own cost — rather than the market value. It is what moves `invested`, and
 * moving `invested` at market instead would reset the basis upward and delete the
 * gain that had already accrued.
 *
 * A transfer row's `price` is the source lot's cost because the import derives it
 * FIFO, so `totalAmount` on the row already *is* the cost. No market lookup and no
 * extra price dependency.
 */
export async function dailyTransferBasis(
  db: DB,
  authToken: string | null,
  portfolioId: string | string[],
  from: string,
  to: string,
  baseCurrency: string,
  opts: { strict?: boolean } = {},
): Promise<Map<string, number>> {
  const base = baseCurrency.toUpperCase()
  const ids = Array.isArray(portfolioId) ? portfolioId : [portfolioId]
  if (ids.length === 0) return new Map()

  const rows = await db
    .select({
      type: portfolioTransactions.type,
      totalAmount: portfolioTransactions.totalAmount,
      convertedTotalAmount: portfolioTransactions.convertedTotalAmount,
      displayCurrency: portfolioTransactions.displayCurrency,
      currency: portfolioTransactions.currency,
      executedAt: portfolioTransactions.executedAt,
    })
    .from(portfolioTransactions)
    .where(
      and(
        inArray(portfolioTransactions.portfolioId, ids),
        inArray(portfolioTransactions.type, [...TRANSFER_TX_TYPES]),
      ),
    )
    .orderBy(portfolioTransactions.executedAt)

  if (rows.length === 0) return new Map()

  const flows = new Map<string, number>()
  for (const r of rows) {
    const day = toDateStr(r.executedAt)
    if (!day || day < from || day > to) continue
    let amount: number
    if (r.convertedTotalAmount != null && r.displayCurrency?.toUpperCase() === base) {
      amount = Number(r.convertedTotalAmount)
    } else {
      const toBase = await rateToBase(authToken, (r.currency ?? base).toUpperCase(), base, day, opts)
      amount = Number(r.totalAmount ?? 0) * toBase
    }
    const signed = r.type === "TRANSFER_OUT" ? -Math.abs(amount) : Math.abs(amount)
    flows.set(day, (flows.get(day) ?? 0) + signed)
  }
  return flows
}