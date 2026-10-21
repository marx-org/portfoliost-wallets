import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeHarness } from "../routes/test-utils.js"
import { portfolios } from "../db/schema.js"
import { recalcPortfolioSeries } from "./backfill.js"
import {
  notifyTransactionsChanged,
  __resetRecalcQueueForTests,
  boundedGraceMs,
  MAX_GRACE_MS,
} from "./recalc-queue.js"

// The queue's job is scheduling/coalescing — recalcPortfolioSeries itself is
// covered by backfill.test.ts, so here it is fully mocked and controlled.
//
// §76.3 switched the queue from `recalcPortfolioHistory` (DELETE + rebuild) to
// `recalcPortfolioSeries` (additive upsert + the same pricing tail), so the
// mock follows the name the queue actually calls.
vi.mock("./backfill.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./backfill.js")>()
  return { ...actual, recalcPortfolioSeries: vi.fn() }
})

const mockedRecalc = vi.mocked(recalcPortfolioSeries)

async function seedPortfolio(db: Awaited<ReturnType<typeof makeHarness>>["db"], userId: string, name = "Queue PF") {
  const [pf] = await db
    .insert(portfolios)
    .values({ userId, name, baseCurrency: "USD" })
    .returning()
  return pf
}

describe("recalc-queue (background recalc on transaction changes)", () => {
  it("bounds the configured grace period", () => {
    expect(boundedGraceMs("999999999")).toBe(3000)
    expect(boundedGraceMs("60000")).toBe(MAX_GRACE_MS)
    expect(boundedGraceMs("-1")).toBe(3000)
    expect(boundedGraceMs("not-a-number")).toBe(3000)
  })

  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    __resetRecalcQueueForTests()
    vi.useRealTimers()
    mockedRecalc.mockReset()
  })

  it("coalesces a burst of changes into a single pass after the grace period", async () => {
    const { db, user } = await makeHarness("queue-user-1")
    const pf = await seedPortfolio(db, user.id)
    mockedRecalc.mockResolvedValue(undefined)

    // Broker-import style: many rapid mutations, one quiet tail.
    for (let i = 0; i < 1000; i++) {
      notifyTransactionsChanged(db, pf.id, "Bearer test")
    }
    expect(mockedRecalc).not.toHaveBeenCalled()

    // Mid-burst nothing fires; only after the (reset) grace does one pass run.
    await vi.advanceTimersByTimeAsync(1000)
    expect(mockedRecalc).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(2000)
    expect(mockedRecalc).toHaveBeenCalledTimes(1)

    // Map is clean: a later change behaves like a fresh burst.
    notifyTransactionsChanged(db, pf.id, "Bearer test")
    await vi.advanceTimersByTimeAsync(3000)
    expect(mockedRecalc).toHaveBeenCalledTimes(2)
  })

  it("kills an in-flight pass when new changes arrive, then restarts after grace with fresh data", async () => {
    const { db, user } = await makeHarness("queue-user-2")
    const pf = await seedPortfolio(db, user.id)

    let releaseFirst: () => void = () => {}
    const inFlight = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    mockedRecalc.mockImplementationOnce(() => inFlight).mockResolvedValue(undefined)

    notifyTransactionsChanged(db, pf.id, "Bearer test")
    await vi.advanceTimersByTimeAsync(3000)
    expect(mockedRecalc).toHaveBeenCalledTimes(1)
    const firstSignal = mockedRecalc.mock.calls[0][4] as AbortSignal | undefined
    expect(firstSignal?.aborted).toBe(false)

    // New mutation arrives while the first pass is still running.
    notifyTransactionsChanged(db, pf.id, "Bearer test")
    expect(firstSignal?.aborted).toBe(true) // in-flight pass killed

    // Let the killed pass finish its (stale) work — it must NOT be counted as
    // a second run; the queue restarts from scratch after the grace period.
    releaseFirst()
    await vi.advanceTimersByTimeAsync(0)
    expect(mockedRecalc).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(3000)
    expect(mockedRecalc).toHaveBeenCalledTimes(2)
    const restartSignal = mockedRecalc.mock.calls[1][4] as AbortSignal | undefined
    expect(restartSignal?.aborted).toBe(false) // fresh pass, uncontaminated signal
  })

  it("different portfolios both run, but serialized (one pass at a time cluster-wide)", async () => {
    const { db, user } = await makeHarness("queue-user-3")
    const pfA = await seedPortfolio(db, user.id, "Queue PF A")
    const pfB = await seedPortfolio(db, user.id, "Queue PF B")
    mockedRecalc.mockResolvedValue(undefined)

    notifyTransactionsChanged(db, pfA.id, "Bearer test")
    notifyTransactionsChanged(db, pfB.id, "Bearer test")
    await vi.advanceTimersByTimeAsync(3000)

    expect(mockedRecalc).toHaveBeenCalledTimes(2)
    expect(mockedRecalc.mock.calls[0][1]).toBe(pfA.id)
    expect(mockedRecalc.mock.calls[1][1]).toBe(pfB.id)
  })

  it("a second portfolio's pass waits for the first to finish (global concurrency 1)", async () => {
    const { db, user } = await makeHarness("queue-user-4")
    const pfA = await seedPortfolio(db, user.id, "Queue PF A")
    const pfB = await seedPortfolio(db, user.id, "Queue PF B")

    let releaseA: () => void = () => {}
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve
    })
    mockedRecalc.mockImplementationOnce(() => gateA).mockResolvedValue(undefined)

    notifyTransactionsChanged(db, pfA.id, "Bearer test")
    notifyTransactionsChanged(db, pfB.id, "Bearer test")
    await vi.advanceTimersByTimeAsync(3000)

    // A is running; B must be queued, not running in parallel.
    expect(mockedRecalc).toHaveBeenCalledTimes(1)
    expect(mockedRecalc.mock.calls[0][1]).toBe(pfA.id)

    releaseA()
    await vi.advanceTimersByTimeAsync(0)
    expect(mockedRecalc).toHaveBeenCalledTimes(2)
    expect(mockedRecalc.mock.calls[1][1]).toBe(pfB.id)
  })
  it("§76.3 — a single mutation enqueues exactly ONE pass, and it is the additive one", async () => {
    const { db, user } = await makeHarness("queue-user-5")
    const pf = await seedPortfolio(db, user.id)
    mockedRecalc.mockResolvedValue(undefined)

    notifyTransactionsChanged(db, pf.id, "Bearer test")
    await vi.advanceTimersByTimeAsync(3000)

    // One change → one pass. Not two (the old shape ran refreshQuotes AND this),
    // and not zero (the burst-coalescing must not swallow a lone edit).
    expect(mockedRecalc).toHaveBeenCalledTimes(1)
    expect(mockedRecalc).toHaveBeenCalledWith(
      db,
      pf.id,
      "Bearer test",
      expect.any(Date),
      expect.any(AbortSignal),
    )
  })

  it("§76.3 — concurrent mutations cannot interleave into a torn series", async () => {
    const { db, user } = await makeHarness("queue-user-6")
    const pf = await seedPortfolio(db, user.id)

    // Two overlapping passes attempt to start; the runner must let only one hold
    // the slot at a time, and the loser must be superseded rather than run beside
    // it — two writers on the same (portfolioId, snapshotDate) is the §63.2 race.
    const observed: string[] = []
    let concurrent = 0
    let peak = 0
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })

    mockedRecalc.mockImplementation(async (_db, id) => {
      concurrent++
      peak = Math.max(peak, concurrent)
      observed.push(`start:${id}`)
      if (observed.length === 1) await gate
      observed.push(`end:${id}`)
      concurrent--
    })

    notifyTransactionsChanged(db, pf.id, "Bearer test")
    await vi.advanceTimersByTimeAsync(3000)
    expect(observed).toEqual([`start:${pf.id}`])

    // A second mutation lands mid-pass: the in-flight one is aborted and a fresh
    // pass is queued. It must not run until the first has released the slot.
    notifyTransactionsChanged(db, pf.id, "Bearer test")
    release()
    await vi.advanceTimersByTimeAsync(0)

    // Peak concurrency must be 1 — a torn series requires two at once.
    expect(peak).toBe(1)
    // And the interleaving, if any, must be start→end, never start→start.
    for (let i = 0; i + 1 < observed.length; i += 2) {
      expect(observed[i]).toMatch(/^start:/)
      expect(observed[i + 1]).toMatch(/^end:/)
      expect(observed[i].slice(6)).toBe(observed[i + 1].slice(4))
    }
  })
})
