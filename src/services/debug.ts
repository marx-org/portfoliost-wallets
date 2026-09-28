/**
 * Gated valuation debug logging (`RECALC_DEBUG=1`).
 *
 * The two cash replays — `cashBalances` (the live/as-of path) and
 * `cashBalanceSeries` (the historical backfill path) — disagreed on PROD while
 * both looked correct in isolation, and neither one logged what it decided.
 * Reconciling them then meant hand-writing throwaway queries in `psql` and
 * re-deriving the arithmetic outside the process, which is slow, lossy, and
 * gone the next investigation.
 *
 * So every step that feeds a portfolio total now narrates itself here: which
 * per-currency balances were replayed, which FX rate each conversion used and
 * whether it was date-resolved or a 1:1 degrade, and which cash figure joined
 * which instrument figure. `RECALC_DEBUG=1` on the pod turns that into a diff
 * you can read straight out of `kubectl logs`.
 *
 * Deliberately `console.log` (not a logger): it must work identically in the
 * API pod, in `snapshots-sync`, in `snapshots-sync-postfx`, and in a
 * `kubectl exec` one-off — those are the only four places these functions run.
 * Per-symbol price noise is capped by the caller, which logs day-0 only.
 */

/**
 * Whether verbose valuation debug logging is on.
 *
 * Read from the environment on every call rather than cached, so tests can flip
 * it per case. The call sites are once-per-portfolio or once-per-day, not
 * once-per-row, so the repeated read is not on any hot path.
 */
export function debugEnabled(): boolean {
  return process.env.RECALC_DEBUG === "1"
}

/** Build a callback that logs only when debugging is on (pass to an optional observer). */
export function debugObserver(): ((line: string) => void) | undefined {
  if (!debugEnabled()) return undefined
  return (line: string) => console.log(`[recalc-debug] ${line}`)
}

/** Log one line under the shared `[recalc-debug]` prefix; a no-op when disabled. */
export function debugLog(line: string): void {
  if (debugEnabled()) console.log(`[recalc-debug] ${line}`)
}

/** `EUR -2883.46 GBP -3154.49` — compact, stable-ordered currency breakdown. */
export function fmtCcyMap(map: Map<string, number>, digits = 2): string {
  if (map.size === 0) return "(none)"
  return [...map]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([c, v]) => `${c} ${v.toFixed(digits)}`)
    .join(" ")
}

/** `EUR -2883.46@1.2345` — each leg with the rate it was converted at. */
export function fmtCcyRateMap(map: Map<string, { amount: number; rate: number }>, digits = 2): string {
  if (map.size === 0) return "(none)"
  return [...map]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([c, { amount, rate }]) => `${c} ${amount.toFixed(digits)}@${rate.toFixed(6)}`)
    .join(" ")
}
