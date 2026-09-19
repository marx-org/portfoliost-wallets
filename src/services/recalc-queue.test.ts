import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeHarness } from "../routes/test-utils.js"
import { portfolios } from "../db/schema.js"
import { recalcPortfolioHistory } from "./backfill.js"
import { notifyTransactionsChanged, __resetRecalcQueueForTests } from "./recalc-queue.js"

// The queue's job is scheduling/coalescing — recalcPortfolioHistory itself is
// covered by backfill.test.ts, so here it is fully mocked and controlled.
vi.mock("./backfill.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./backfill.js")>()
  return { ...actual, recalcPortfolioHistory: vi.fn() }
})

const mockedRecalc = vi.mocked(recalcPortfolioHistory)

async function seedPortfolio(db: Awaited<ReturnType<typeof makeHarness>>["db"], userId: string, name = "Queue PF") {
  const [pf] = await db
    .insert(portfolios)
    .values({ userId, name, currency: "USD", baseCurrency: "USD" })
    .returning()
  return pf
}

describe("recalc-queue (background recalc on transaction changes)", () => {
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
})