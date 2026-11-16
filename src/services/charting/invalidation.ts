import { and, eq, max, sql } from "drizzle-orm"
import type { DB } from "../../db/index.js"
import { chartEventFacts, chartPositionDaily, chartProjectionState, portfolios } from "../../db/schema.js"
import { buildChartFacts, type BuildChartFactsOptions, type BuildChartFactsResult } from "./projection.js"
import { toDateStr } from "../cashLedger.js"

/**
 * Charting invalidation and recompute (feature #253/#254).
 *
 * Mutations mark a portfolio's projection stale (earliest affected date +
 * bumped version) so a reader can tell a rebuild is pending. Rebuilds run in
 * the existing refresh/recompute lifecycle — never on a chart read — and write
 * a fresh generation, leaving the previous one readable until the new one is
 * published.
 */

/**
 * Days of already-published history re-priced on every refresh pass. FX for a
 * fresh date is unknown until the ECB publish (~16:00 CET) and can still shift a
 * converted value, so the tail is recomputed rather than only appended — the same
 * reasoning `snapshots-sync` uses for `value_snapshots`.
 */
export const CHART_TAIL_DAYS = 2

/** Shift a YYYY-MM-DD date by `days` (negative allowed) without touching the TZ. */
function shiftDay(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number)
  return toDateStr(new Date(Date.UTC(y, m - 1, d + days))) ?? day
}

/** Mark a portfolio's charting projection stale (idempotent, coalescing). */
export async function markChartingDirty(db: DB, portfolioId: string, fromDate?: string | null): Promise<void> {
  await db
    .insert(chartProjectionState)
    .values({ portfolioId, generation: 0, version: 1, status: "stale", dirtyFrom: fromDate ?? null, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: chartProjectionState.portfolioId,
      set: {
        status: "stale",
        // Coalesce to the EARLIEST affected date: a mutation on 2026-01-01
        // followed by one on 2026-06-01 must still restate January. A null means
        // "affected date unknown", which is strictly worse than any known date,
        // so null wins and forces a full rebuild.
        dirtyFrom: fromDate
          ? sql`case when ${chartProjectionState.dirtyFrom} is null then ${fromDate}
                 else least(${chartProjectionState.dirtyFrom}, ${fromDate}) end`
          : null,
        version: sql`${chartProjectionState.version} + 1`,
        updatedAt: new Date(),
      },
    })
}

/** The next generation for a portfolio (max current + 1, or 1). */
export async function nextChartGeneration(db: DB, portfolioId: string): Promise<number> {
  const [row] = await db
    .select({ generation: chartProjectionState.generation })
    .from(chartProjectionState)
    .where(eq(chartProjectionState.portfolioId, portfolioId))
    .limit(1)
  return (row?.generation ?? 0) + 1
}

/**
 * Rebuild one portfolio's charting facts at a fresh generation, over the whole
 * history (or the given window). Reads the current generation, builds the next,
 * and publishes it atomically inside buildChartFacts. Never runs on a chart read.
 */
export async function recomputeChartingForPortfolio(
  db: DB,
  portfolioId: string,
  authToken: string,
  opts: Omit<BuildChartFactsOptions, "generation"> = {},
): Promise<void> {
  const generation = await nextChartGeneration(db, portfolioId)
  await buildChartFacts(db, portfolioId, authToken, { ...opts, generation })
}

/**
 * The slice of facts a refresh pass must recompute for one portfolio, and the
 * generation it is written to.
 *
 *  - never projected → the whole history, generation 1 (the bootstrap);
 *  - dirty since `dirtyFrom` → everything from that date, at the SAME generation,
 *    because days before it are unaffected by the mutation;
 *  - clean → a trailing window: the last published day plus the re-pricing tail,
 *    which is what makes the charts grow day by day. Without this, a portfolio
 *    bootstrapped once stays `complete` forever and never gains a row for a new
 *    day.
 */
export interface ChartFactsWindow {
  generation: number
  /** null = whole history */
  from: string | null
  to: string
}

export async function chartFactsWindow(db: DB, portfolioId: string, now: Date = new Date()): Promise<ChartFactsWindow> {
  const to = toDateStr(now) ?? toDateStr(new Date())!
  const [state] = await db
    .select({ generation: chartProjectionState.generation, dirtyFrom: chartProjectionState.dirtyFrom })
    .from(chartProjectionState)
    .where(eq(chartProjectionState.portfolioId, portfolioId))
    .limit(1)

  if (!state || state.generation <= 0) return { generation: (state?.generation ?? 0) + 1, from: null, to }

  if (state.dirtyFrom) return { generation: state.generation, from: state.dirtyFrom, to }

  const [lastPos] = await db
    .select({ d: max(chartPositionDaily.day) })
    .from(chartPositionDaily)
    .where(and(eq(chartPositionDaily.portfolioId, portfolioId), eq(chartPositionDaily.generation, state.generation)))
  const [lastEvent] = await db
    .select({ d: max(chartEventFacts.eventDate) })
    .from(chartEventFacts)
    .where(and(eq(chartEventFacts.portfolioId, portfolioId), eq(chartEventFacts.generation, state.generation)))
  const days = [lastPos?.d, lastEvent?.d].filter((d): d is string => !!d)
  if (days.length === 0) return { generation: state.generation, from: null, to }

  const lastPublishedDay = [...days].sort().at(-1)!
  return { generation: state.generation, from: shiftDay(lastPublishedDay, -CHART_TAIL_DAYS), to }
}

/**
 * Refresh one portfolio's facts: bootstrap when it has never been projected,
 * otherwise recompute the window returned by `chartFactsWindow` at the published
 * generation. Bounded: it fetches prices only for that window.
 */
export async function refreshChartingFacts(
  db: DB,
  portfolioId: string,
  authToken: string,
  opts: Omit<BuildChartFactsOptions, "generation"> = {},
): Promise<BuildChartFactsResult & { generation: number; windowFrom: string | null }> {
  const window = await chartFactsWindow(db, portfolioId, opts.now ?? new Date())
  const result = await buildChartFacts(db, portfolioId, authToken, {
    ...opts,
    generation: window.generation,
    from: opts.from ?? window.from,
    to: opts.to ?? window.to,
  })
  return { ...result, generation: window.generation, windowFrom: window.from }
}

/**
 * Refresh every real (non-virtual) portfolio's chart facts — the pass the
 * scheduled job runs. Each portfolio is bootstrapped or extended by its own
 * window, so the fleet's charts grow daily without re-fetching history for
 * accounts that did not change. A portfolio whose rebuild throws is counted as
 * failed and keeps its last complete generation; the next pass picks it up again.
 */
export async function refreshFleetChartingFacts(
  db: DB,
  authToken: string,
  opts: Omit<BuildChartFactsOptions, "generation"> = {},
): Promise<{ refreshed: number; bootstrapped: number; failed: number }> {
  const rows = await db
    .select({ id: portfolios.id })
    .from(portfolios)
    .where(eq(portfolios.isVirtual, false))
    .orderBy(portfolios.name)

  let refreshed = 0
  let bootstrapped = 0
  let failed = 0
  for (const p of rows) {
    const projected = await db
      .select({ generation: chartProjectionState.generation })
      .from(chartProjectionState)
      .where(eq(chartProjectionState.portfolioId, p.id))
      .limit(1)
    try {
      const res = await refreshChartingFacts(db, p.id, authToken, opts)
      refreshed += 1
      if (res.generation === 1 && projected.length === 0) bootstrapped += 1
    } catch {
      failed += 1
    }
  }
  return { refreshed, bootstrapped, failed }
}
