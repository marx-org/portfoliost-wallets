import { and, eq, inArray } from "drizzle-orm"
import type { DB } from "../db/index.js"
import { portfolioTransactions } from "../db/schema.js"
import { TRANSFER_TX_TYPES } from "../transaction-types.js"
import { rateToBase } from "./cashLedger.js"
import { toDateStr } from "./cashLedger.js"
import { externalCashInvested } from "./cashLedger.js"

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

export class MissingTransferPriceError extends Error {
  constructor(readonly symbol: string, readonly day: string) {
    super(`No historical close for transfer ${symbol} on or before ${day}`)
  }
}

/**
 * The market-valued neutralising flow, computed from the daily grid.
 *
 * The market figure exists only where the price bars do, which is the grid — hence
 * this function taking the price maps rather than querying anything itself. The
 * bars are already fetched converted to base, so `qty × close` is already base and
 * needs no FX step here.
 */
export function marketValuedTransferFlows(
  transfersByDay: Map<string, { symbol: string; quantity: number }[]>,
  priceMaps: Map<string, Map<string, number>>,
): Map<string, number> {
  const flows = new Map<string, number>()
  for (const [day, moves] of transfersByDay) {
    let total = 0
    for (const move of moves) {
      const close = priceMaps.get(move.symbol)?.get(day)
      if (close == null || !Number.isFinite(close) || close <= 0) {
        throw new MissingTransferPriceError(move.symbol, day)
      }
      total += move.quantity * close
    }
    flows.set(day, total)
  }
  return flows
}

/**
 * The **cost**-valued sibling of {@link marketValuedTransferFlows}, for the capital basis.
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

/**
 * The CAPITAL BASIS — what `portfolios.total_invested` and therefore
 * `simpleReturnPercent` must report: cumulative net external cash **plus** the
 * cost of whatever has been transferred in or out, signed.
 *
 * Two quantities, deliberately not conflated (#30, and §89.5 where conflating
 * them is what got `ADJUSTMENT` into trouble):
 *
 * - {@link externalCashInvested} — "money actually put in". Unaffected by a
 *   transfer, and it must stay that way.
 * - this — capital at risk in this portfolio. A transfer moves the basis with
 *   the shares, **at cost**: `invested` is a basis, so the accrued unrealised
 *   gain is just `value − invested` and follows whichever account holds the
 *   stock. Rebasing at the transfer-date market would delete real profit — five
 *   shares bought at 10 and sold at 12 gained 10; rebased at 11 they gain 5.
 *
 * The two legs cancel across a portfolio pair, so `/merged` and every aggregate
 * are unchanged by the transfer either way. That invariance is exactly why the
 * omission went unnoticed: only the per-portfolio figures were wrong.
 *
 * PROD: `externalCashInvested`'s own docstring promised "± TRANSFER legs" while
 * the transfer write path deliberately writes no `portfolio_cash_transactions`
 * row, so the promise was unfulfilled and the basis never moved. IBKR read
 * +203.76 % where +11.87 % was correct; Equate+ read −94.56 % where +131.75 %
 * was. The daily grid (`backfill.ts`) already added {@link dailyTransferBasis}
 * to its own accumulator, so the chart and the live card disagreed.
 *
 * Lives here rather than in `cashLedger.ts` because that module is imported by
 * this one; composing it there would be a cycle.
 */
export async function capitalBasisInvested(
  db: DB,
  authToken: string | null,
  portfolioId: string,
  baseCurrency: string,
  opts: { strict?: boolean } = {},
): Promise<number> {
  const external = await externalCashInvested(db, authToken, portfolioId, baseCurrency, opts)
  // All history: the basis is cumulative, and a transfer predating any window
  // still has to count. Same sentinel bounds `backfill.ts` uses for its
  // pre-window seeding, compared as strings so no date parsing is involved.
  const flows = await dailyTransferBasis(
    db, authToken, portfolioId, "0000-01-01", "9999-12-31", baseCurrency, opts,
  )
  let transferBasis = 0
  for (const amount of flows.values()) transferBasis += amount
  return external + transferBasis
}