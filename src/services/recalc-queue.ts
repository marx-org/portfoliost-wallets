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
 *  - already running → AbortController.abort() kills the in-flight pass (it
 *    never commits a partial/stale series — see recalcPortfolioHistory) and a
 *    fresh pass starts after the grace deadline.
 *
 * The module runs in a single pod replica. recalcPortfolioHistory is idempotent
 * (replace semantics), so a double run from a future multi-replica deployment
 * is harmless.
 */
import type { DB } from "../db/index.js"
import { recalcPortfolioHistory } from "./backfill.js"

const GRACE_MS = Number(process.env.RECALC_GRACE_MS ?? 3000)
const MAX_RESTARTS = 10

interface Job {
  token: string
  running: boolean
  controller: AbortController | null
  timer: ReturnType<typeof setTimeout> | null
}

const jobs = new Map<string, Job>()

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Fire-and-forget signal that portfolio transactions changed. Coalesces: a
 * running pass for the portfolio is aborted and a fresh one is scheduled after
 * the grace period.
 */
export function notifyTransactionsChanged(db: DB, portfolioId: string, authToken: string): void {
  let job = jobs.get(portfolioId)
  if (!job) {
    job = { token: authToken, running: false, controller: null, timer: null }
    jobs.set(portfolioId, job)
  }
  job.token = authToken
  if (job.running && job.controller) {
    job.controller.abort()
  }
  schedule(job, db, portfolioId)
}

function schedule(job: Job, db: DB, portfolioId: string): void {
  if (job.timer) clearTimeout(job.timer)
  job.timer = setTimeout(() => {
    job.timer = null
    void run(job, db, portfolioId)
  }, GRACE_MS)
}

async function run(job: Job, db: DB, portfolioId: string): Promise<void> {
  if (job.running) return
  if (job.timer) {
    clearTimeout(job.timer)
    job.timer = null
  }
  job.running = true
  try {
    let restarts = 0
    for (;;) {
      const controller = new AbortController()
      job.controller = controller
      await recalcPortfolioHistory(db, portfolioId, job.token, new Date(), controller.signal)
      if (!controller.signal.aborted) break
      // Aborted mid-pass because new changes arrived → restart after grace.
      if (restarts >= MAX_RESTARTS) {
        // Livelock valve: stop looping; a pending/next notify re-arms the timer.
        schedule(job, db, portfolioId)
        return
      }
      restarts++
      await sleep(GRACE_MS)
    }
  } finally {
    job.running = false
    job.controller = null
    // A pending timer (armed while we ran) must be kept so the latest state is
    // recomputed — its run() will then delete the record.
    if (!job.timer) jobs.delete(portfolioId)
  }
}

/** Test-only: clear in-flight state so suites don't leak across cases. */
export function __resetRecalcQueueForTests(): void {
  for (const job of jobs.values()) {
    if (job.timer) clearTimeout(job.timer)
    job.controller?.abort()
  }
  jobs.clear()
}