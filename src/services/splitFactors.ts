import { eq } from "drizzle-orm"
import type { DB } from "../db/index.js"
import { splitEvents } from "../db/schema.js"

/**
 * A split's `effectiveDate` is a calendar date, but the restatement arithmetic
 * compares it against a transaction instant. Anchor it at UTC midnight so the
 * comparison is unambiguous regardless of the pod's timezone.
 */
export function effectiveDateToUtc(dateStr: string): Date {
  return new Date(`${dateStr}T00:00:00.000Z`)
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