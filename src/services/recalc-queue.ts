/**
 * Recalc queue (planned in docs/proposals/benchmarks.md, 2026-09-05).
 *
 * After any transaction mutation the portfolio's value_snapshots history is
 * stale. Rather than recomputing per transaction (a broker import of thousands
 * would saturate the pod), this module coalesces changes into at most a couple
 * of background passes per portfolio:
 *
 *  - not running  → (re)arm a grace timer (RECALC_GRACE_MS, default 3000);
 *    every mutation resets it, so a continuous burst runs once, shortly after
 *    it quietens.
 *  - already running → the in-flight pass is aborted (it never commits a
 *    partial/stale series — see recalcPortfolioHistory) and a fresh pass is
 *    scheduled after the grace deadline.
 *
 * Passes execute through the global backfill runner
 * (backfill-runner.ts): at most ONE portfolio recompute in flight cluster-
 * wide, so a full import (N portfolios) drains one-by-one instead of fanning
 * out N parallel price-bar storms (2026-09-19 postgres CPU saturation).
 *
 * The module runs in a single pod replica. recalcPortfolioHistory is
 * idempotent (replace semantics), so a double run from a future multi-replica
 * deployment is harmless.
 */
import type { DB } from "../db/index.js"
import { recalcPortfolioSeries } from "./backfill.js"
import { abortActiveBackfill, enqueueBackfill, __resetBackfillRunnerForTests } from "./backfill-runner.js"

export const MAX_GRACE_MS = 60_000

export function boundedGraceMs(value: string | undefined): number {
  switch (value) {
    case "0": return 0
    case "1000": return 1000
    case "3000": return 3000
    case "5000": return 5000
    case "10000": return 10000
    case "60000": return MAX_GRACE_MS
    default: return 3000
  }
}

const GRACE_MS = boundedGraceMs(process.env.RECALC_GRACE_MS)

interface Job {
  token: string
  timer: ReturnType<typeof setTimeout> | null
}

const jobs = new Map<string, Job>()

/**
 * Fire-and-forget signal that portfolio transactions changed. Coalesces: an
 * in-flight pass for the portfolio is aborted now and a fresh one is scheduled
 * after the grace period (executed by the serialized backfill runner).
 */
export function notifyTransactionsChanged(db: DB, portfolioId: string, authToken: string): void {
  let job = jobs.get(portfolioId)
  if (!job) {
    job = { token: authToken, timer: null }
    jobs.set(portfolioId, job)
  }
  job.token = authToken
  abortActiveBackfill(portfolioId)
  if (job.timer) clearTimeout(job.timer)
  job.timer = setTimeout(() => {
    job.timer = null
    jobs.delete(portfolioId)
    const token = job.token
    // §76.3 — ADDITIVE, not `recalcPortfolioHistory`. This used to delete every
    // snapshot row and rebuild the series, 3s after the mutation route had
    // already priced the same positions through `refreshQuotes`. The two passes
    // ended in the same state, so the delete bought only the ability to drop rows
    // outside the recomputed window — a wipe-and-reimport, which has its own
    // endpoint (`POST /:id/recompute` with no `mode`). Coalescing (the grace
    // timer) and serialization (the shared runner) are unaffected: a burst of
    // transactions still collapses to ONE pass.
    void enqueueBackfill(portfolioId, (signal) =>
      recalcPortfolioSeries(db, portfolioId, token, new Date(), signal),
    )
  }, GRACE_MS)
}

/** Test-only: clear in-flight state so suites don't leak across cases. */
export function __resetRecalcQueueForTests(): void {
  for (const job of jobs.values()) {
    if (job.timer) clearTimeout(job.timer)
  }
  jobs.clear()
  __resetBackfillRunnerForTests()
}
