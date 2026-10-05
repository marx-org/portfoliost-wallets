import { and, eq } from "drizzle-orm"
import type { DB } from "../db/index.js"
import { portfolioTransactions, splitEvents } from "../db/schema.js"

/**
 * A split's `effectiveDate` is a calendar date, but the restatement arithmetic
 * compares it against a transaction instant. Anchor it at UTC midnight so the
 * comparison is unambiguous regardless of the pod's timezone.
 */
export function effectiveDateToUtc(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`)
}

/**
 * The base external ids of option-premium pairs, for a portfolio.
 *
 * An option trade arrives as a pair: a SELL of 100 at the premium, and an
 * EXPIRATION at 0 whose externalId is the SELL's plus `#e`. Neither leg is a share
 * disposal — the SELL's quantity is in CONTRACT units of the underlying, not
 * shares the holder owned.
 *
 * Both the daily valuation grid and the FIFO queue must exclude them. §72.14 is the
 * measured instance: on Equate+ (SAP.DE), 481.77 shares bought against 976 "sold",
 * netting −494.23, which `Math.max(0, cum)` clamps to zero — so the whole series
 * valued the position at 0.
 *
 * Shared so they cannot disagree. When they did, the grid excluded the legs and the
 * FIFO queue did not, so the queue drained to ~5 shares and every real transfer row
 * on that symbol failed with `transfer_exceeds_open_lots` — PROD, 2026-10-05, six
 * rows. The pair is identified by either leg's external id, base form.
 */
export async function optionPremiumLegIds(tx: DB, portfolioId: string): Promise<Set<string>> {
  const rows = await tx
    .select({ externalId: portfolioTransactions.externalId })
    .from(portfolioTransactions)
    .where(
      and(
        eq(portfolioTransactions.portfolioId, portfolioId),
        eq(portfolioTransactions.type, "EXPIRATION"),
      ),
    )
  const ids = new Set<string>()
  for (const r of rows) {
    if (r.externalId) ids.add(r.externalId.replace(/#e$/, ""))
  }
  return ids
}

/**
 * Cumulative split factor for `symbol`: the product of every event effective
 * AFTER the given instant, or 1 when nothing has split.
 *
 * Shared with `apply-split` (routes/internal.ts) so the two cannot drift — the
 * FIFO queue and the split restatement must agree on what a lot's quantity is,
 * or a transfer will draw against a quantity that no longer exists.
 */
export async function loadCumFactor(tx: DB, symbol: string) {
  const events = (
    await tx
      .select()
      .from(splitEvents)
      .where(eq(splitEvents.symbol, symbol))
      .orderBy(splitEvents.effectiveDate)
  ).map((e) => ({ factor: Number(e.factor), effectiveAt: effectiveDateToUtc(e.effectiveDate) }))

  return (executedAt: Date) =>
    events.reduce((acc, ev) => (executedAt < ev.effectiveAt ? acc * ev.factor : acc), 1)
}