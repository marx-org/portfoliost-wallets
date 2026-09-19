import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  abortActiveBackfill,
  enqueueBackfill,
  __resetBackfillRunnerForTests,
} from "./backfill-runner.js"

const GRACE_MS = Number(process.env.RECALC_GRACE_MS ?? 3000)
const MAX_AUTO_RESTARTS = 10 // must match backfill-runner.ts

afterEach(() => {
  __resetBackfillRunnerForTests()
  vi.useRealTimers()
})

beforeEach(() => {
  vi.useFakeTimers()
})

/** A run fn that holds until the gate resolves or the signal aborts. */
function gatedRun(gate: Promise<void>, onAbort: () => void) {
  return (signal: AbortSignal) =>
    Promise.race([
      gate.then(() => undefined),
      new Promise<void>((_, rej) =>
        signal.addEventListener("abort", () => {
          onAbort()
          rej(new Error("aborted"))
        }),
      ),
    ])
}

describe("backfill-runner (serialized recompute passes)", () => {
  it("runs passes one at a time, FIFO across portfolios", async () => {
    const order: string[] = []
    let releaseA: () => void = () => {}
    const gateA = new Promise<void>((r) => (releaseA = r))

    const a = enqueueBackfill("pf-a", async () => {
      order.push("a-start")
      await gateA
      order.push("a-end")
    })
    const b = enqueueBackfill("pf-b", async () => {
      order.push("b-start")
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual(["a-start"]) // B waits behind A

    releaseA()
    await Promise.all([a, b])
    expect(order).toEqual(["a-start", "a-end", "b-start"])
  })

  it("re-enqueue while active replaces the run fn without starting a second pass", async () => {
    const calls: number[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))

    const first = enqueueBackfill("pf", async () => {
      calls.push(1)
      await gate
    })
    const second = enqueueBackfill("pf", async () => {
      calls.push(2)
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual([1])

    release()
    await Promise.all([first, second])
    expect(calls).toEqual([1]) // completed pass is not re-run automatically
  })

  it("abortActiveBackfill re-runs the replaced pass after the grace period", async () => {
    const calls: number[] = []
    const gate1 = new Promise<void>(() => {}) // never resolves — pass 1 is killed

    const first = enqueueBackfill("pf", gatedRun(gate1, () => calls.push(1)))
    await vi.advanceTimersByTimeAsync(0)

    // A newer pass replaces the run fn, and the stale pass is aborted.
    const second = enqueueBackfill("pf", async () => {
      calls.push(2)
    })
    abortActiveBackfill("pf")

    // The aborted pass restarts after the grace delay, using the new run fn.
    await vi.advanceTimersByTimeAsync(GRACE_MS)
    expect(calls).toEqual([1, 2])

    await Promise.all([first, second])
    expect(calls).toEqual([1, 2])
  })

  it("caps auto-restarts: the valve stops the abort/restart loop", async () => {
    let runs = 0
    const gate = new Promise<void>(() => {}) // never resolves

    const p = enqueueBackfill("pf", async (signal) => {
      runs++
      await Promise.race([
        gate,
        new Promise<void>((_, rej) => signal.addEventListener("abort", () => rej(new Error("aborted")))),
      ])
    })

    // Abort the active pass, let the grace period settle — repeat. After
    // MAX_AUTO_RESTARTS the valve stops the auto-requeue (no livelock).
    for (let i = 0; i < 12; i++) {
      await vi.advanceTimersByTimeAsync(0)
      abortActiveBackfill("pf")
      await vi.advanceTimersByTimeAsync(GRACE_MS)
    }

    expect(runs).toBe(MAX_AUTO_RESTARTS) // initial + 9 restarts, valve on 10th abort

    // Queue is idle — no further re-runs on their own.
    await vi.advanceTimersByTimeAsync(GRACE_MS * 3)
    expect(runs).toBe(MAX_AUTO_RESTARTS)

    // A fresh enqueue runs immediately.
    let ran = false
    await enqueueBackfill("pf", async () => {
      ran = true
    })
    expect(ran).toBe(true)
    void p
  })
})
