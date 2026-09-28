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

  it("§72.12: a request arriving mid-pass runs AFTER it, and is not reported done early", async () => {
    const calls: number[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))
    let secondResolved = false

    const first = enqueueBackfill("pf", async () => {
      calls.push(1)
      await gate
    })
    const second = enqueueBackfill("pf", async () => {
      calls.push(2)
    }).then(() => {
      secondResolved = true
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual([1]) // the new request waits its turn

    // The bug: `active.task.run = run; done()` resolved this immediately while
    // the work never ran, so the HTTP route answered "pending" for a rebuild
    // that would never reflect the edit that triggered it.
    expect(secondResolved).toBe(false)

    release()
    await Promise.all([first, second])
    expect(calls).toEqual([1, 2])
    expect(secondResolved).toBe(true)
  })

  it("§72.12: a mid-pass request for a DIFFERENT portfolio also waits", async () => {
    // The old branch keyed on `active.task.portfolioId === portfolioId`, so it
    // only ever swallowed same-portfolio work. Serialisation is global.
    const calls: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))

    const a = enqueueBackfill("pf-a", async () => {
      calls.push("a")
      await gate
    })
    const b = enqueueBackfill("pf-b", async () => {
      calls.push("b")
    })

    await vi.advanceTimersByTimeAsync(0)
    release()
    await Promise.all([a, b])
    expect(calls).toEqual(["a", "b"])
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
    let ranFresh = false
    await enqueueBackfill("pf", async () => {
      ranFresh = true
    })
    expect(ranFresh).toBe(true)
    void p
  })

  it("logs (never swallows) a pass that throws outside the run fn, and keeps the queue draining", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    // A run fn that rejects with a plain (non-abort) error — the defensive
    // runner catch must log it and move on, not wedge the queue (§63.1).
    const done = enqueueBackfill("pf-boom", async () => {
      throw new Error("boom outside run fn")
    })
    await done
    expect(errSpy).toHaveBeenCalled()
    expect(String(errSpy.mock.calls[0]?.[0])).toContain("pf-boom")
    expect(String(errSpy.mock.calls[0]?.[0] ?? "")).toContain("threw outside the run fn")

    // Queue still drains after the failure.
    let ran = false
    await enqueueBackfill("pf-after", async () => {
      ran = true
    })
    expect(ran).toBe(true)
    errSpy.mockRestore()
  })
})

describe("§72.12 — refreshQuotes is a queued writer, not a free one", () => {
  it("waits behind an in-flight rebuild instead of writing the row concurrently", async () => {
    // Both write TODAY's snapshot. Unserialised, a 13:00 sweep landing inside a
    // DELETE+rebuild has its row deleted out from under it — or the reverse —
    // and which survived depended on timing. That seam is the Equate+ chart.
    const order: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))

    const rebuild = enqueueBackfill("pf", async () => {
      order.push("rebuild-start")
      await gate
      order.push("rebuild-end")
    })
    const refresh = enqueueBackfill("pf", async () => {
      order.push("refresh")
    })

    await vi.advanceTimersByTimeAsync(0)
    expect(order).toEqual(["rebuild-start"])

    release()
    await Promise.all([rebuild, refresh])
    expect(order).toEqual(["rebuild-start", "rebuild-end", "refresh"])
  })

  it("holds at most one queued slot per portfolio however often it is called", async () => {
    // snapshots-sync sweeps every portfolio on a schedule; without the cap a
    // burst of mutations plus a sweep would grow the queue without bound.
    const order: number[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => (release = r))

    const first = enqueueBackfill("pf", async () => {
      order.push(1)
      await gate
    })
    const rest = [2, 3, 4].map((n) =>
      enqueueBackfill("pf", async () => {
        order.push(n)
      }),
    )

    await vi.advanceTimersByTimeAsync(0)
    release()
    await Promise.all([first, ...rest])
    // latest state wins: the three extra requests collapse to one pass
    expect(order).toEqual([1, 4])
  })
})
