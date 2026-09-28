/**
 * Global backfill runner (fix for the 2026-09-19 pfire-postgres CPU
 * saturation incident, plan §24.9 follow-up).
 *
 * Serializes the heavy value-snapshot recompute passes across ALL
 * portfolios: analytics-triggered backfills (runBackfill) and post-mutation
 * recalcs (recalc-queue) each fan out to every symbol's price bars, so
 * running them in parallel (a full import touches 10+ portfolios at once)
 * hammered `instruments.price_bars_all` until the node pegged at 100% CPU.
 *
 * One pass at a time, FIFO. A pass interrupted by a newer notify for the
 * same portfolio is re-queued at the front after the grace period so
 * trailing mutations settle first; MAX_AUTO_RESTARTS caps the loop — the
 * next notify's grace timer then supplies the fresh pass.
 *
 * Single-pod module (same assumption as recalc-queue): wallets runs with
 * replicas=1 in the cluster.
 */

const RESTART_DELAY_MS = Number(process.env.RECALC_GRACE_MS ?? 3000)
const MAX_AUTO_RESTARTS = 10

interface RunnerTask {
  portfolioId: string
  run: (signal: AbortSignal) => Promise<void>
  restarts: number
  /** Resolves when this enqueue's slot is finally consumed (or superseded). */
  done?: () => void
}

const queued: RunnerTask[] = []
let active: { task: RunnerTask; controller: AbortController } | null = null
let pumping = false

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Enqueue a recompute pass for a portfolio. At most one slot per portfolio:
 * re-enqueueing replaces the pending run (latest state wins), which also caps
 * the queue at one entry per portfolio.
 *
 * §72.12 — a request arriving while a pass for the SAME portfolio is ACTIVE is
 * queued behind it, rather than dropped. It used to take this branch:
 *
 *   if (active && active.task.portfolioId === portfolioId) {
 *     active.task.run = run   // reassigns a property nobody reads any more
 *     done()                  // ...and tells the caller it was handled
 *     return donePromise
 *   }
 *
 * `pump()` had already called `task.run(signal)` and was awaiting it, so the
 * reassignment changed nothing: the new work never ran. `done()` resolved all
 * the same, and the HTTP route answered `{ backfillStatus: "pending" }` — so a
 * transaction edit landing mid-rebuild was reported as accepted and silently
 * dropped, and the rebuilt series never reflected it. Worse than a slow queue:
 * the caller had no way to find out. Queueing is what "one pass at a time"
 * was always supposed to mean.
 *
 * Returns a promise that resolves once the enqueued slot has been consumed.
 */
export function enqueueBackfill(
  portfolioId: string,
  run: (signal: AbortSignal) => Promise<void>,
): Promise<void> {
  let done: () => void = () => {}
  const donePromise = new Promise<void>((resolve) => {
    done = resolve
  })

  const existing = queued.find((t) => t.portfolioId === portfolioId)
  if (existing) {
    existing.run = run
    existing.done?.()
    existing.done = done
  } else {
    queued.push({ portfolioId, run, restarts: 0, done })
  }
  void pump()
  return donePromise
}

/** Abort the ACTIVE pass for a portfolio (no-op unless it is running). */
export function abortActiveBackfill(portfolioId: string): void {
  if (active && active.task.portfolioId === portfolioId) {
    active.task.restarts++
    active.controller.abort()
  }
}

function finishTask(task: RunnerTask): void {
  task.done?.()
  task.done = undefined
}

async function pump(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    for (;;) {
      const task = queued.shift()
      if (!task) break
      const controller = new AbortController()
      active = { task, controller }
      try {
        await task.run(controller.signal)
      } catch (err) {
        // Defensive: run fns swallow their own errors (status='failed'). A
        // throw here must not wedge the queue — drop the pass and move on.
        // (2026-09-25: observed a recompute pass that vanished with no log —
        // never log-less again: §63.1)
        console.error(
          `[backfill-runner] pass for portfolio ${task.portfolioId} threw outside the run fn:`,
          err,
        )
      } finally {
        active = null
      }

      if (!controller.signal.aborted) {
        task.restarts = 0
        finishTask(task)
        continue
      }

      // Interrupted by a newer pass for the same portfolio. Re-run at the
      // front after the grace period — unless the livelock valve is hit, in
      // which case the next notify's grace timer supplies the fresh pass.
      if (task.restarts >= MAX_AUTO_RESTARTS) {
        task.restarts = 0
        finishTask(task)
        continue
      }
      await sleep(RESTART_DELAY_MS)
      if (!queued.some((t) => t.portfolioId === task.portfolioId)) {
        queued.unshift(task)
      } else {
        finishTask(task)
      }
    }
  } finally {
    pumping = false
  }
}

/** Test-only: clear queue/active so suites don't leak across cases. */
/**
 * Test-only: is any pass queued or running?
 *
 * The §72.7 hazard is the ENQUEUE, not any particular call site: a GET that
 * replaces a queued pass's run function downgrades a full recalc (which prices)
 * to a backfill (which does not). Asserting "we stopped calling runBackfill" does
 * not hold that property — a future GET could enqueue by another route and pass
 * such a test. This answers the question that actually matters.
 */
export function __backfillRunnerEnqueuedForTests(): boolean {
  return active !== null || queued.length > 0
}

export function __resetBackfillRunnerForTests(): void {
  active?.controller.abort()
  if (active) {
    finishTask(active.task)
    active = null
  }
  for (const t of queued) finishTask(t)
  queued.length = 0
}
