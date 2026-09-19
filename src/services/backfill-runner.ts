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
 * re-enqueueing replaces the pending run (latest state wins). If a pass for
 * the portfolio is already active, only its run fn is replaced — the active
 * pass runs to completion (use `abortActiveBackfill` to kill a stale one).
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

  if (active && active.task.portfolioId === portfolioId) {
    active.task.run = run
    done()
    return donePromise
  }

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
      } catch {
        // Defensive: run fns swallow their own errors (status='failed'). A
        // throw here must not wedge the queue — drop the pass and move on.
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
export function __resetBackfillRunnerForTests(): void {
  active?.controller.abort()
  if (active) {
    finishTask(active.task)
    active = null
  }
  for (const t of queued) finishTask(t)
  queued.length = 0
}
