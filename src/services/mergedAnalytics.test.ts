import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { crossRate } from "@marx2/contracts/fx"
import { makeHarness } from "../routes/test-utils.js"
import { portfolioCashTransactions, portfolios } from "../db/schema.js"
import { computeSnapshotBatch, type SnapshotRow as BatchRow } from "./backfill.js"
import { __resetBackfillRunnerForTests } from "./backfill-runner.js"
import {
  buildMergedPerformance,
  sumSnapshotsByDate,
  sumSnapshotsByDateForwardFilled,
  type MergedPoint,
  type SnapshotRow,
} from "./mergedAnalytics.js"

// EUR-quoted table (D27): the rate callback resolves from→USD cross-rates the
// same way the real service does (plan §48.3 — resolved upstream, passed in).
const TABLE = { USD: 1.08, PLN: 4.3, EUR: 1 }
const RATES = (from: string): number | null => crossRate(from, "USD", TABLE) ?? null
const NULL_RATES = (_from: string): number | null => null

/**
 * §83.2 — the shape both sum functions return. The three added columns are
 * spelled out rather than defaulted at the call site so every existing
 * expectation below states what it now claims: no flow, and the withheld amounts
 * UNMEASURED (a fixture that does not supply them is a fixture from before the
 * columns existed, which is the case `null` is for).
 */
function merged(
  date: string,
  value: number,
  invested: number,
  over: Partial<MergedPoint> = {},
): MergedPoint {
  return { date, value, invested, netFlow: 0, unpricedValue: null, carriedValue: null, ...over }
}

describe("sumSnapshotsByDate (§46.1)", () => {
  it("single portfolio in its own currency == its own series, no FX", () => {
    const rows: SnapshotRow[] = [
      { baseCurrency: "USD", snapshotDate: "2026-01-01", value: 1000, invested: 900 },
      { baseCurrency: "USD", snapshotDate: "2026-01-02", value: 1100, invested: 900 },
    ]
    expect(sumSnapshotsByDate(rows, RATES, "USD")).toEqual([
      merged("2026-01-01", 1000, 900),
      merged("2026-01-02", 1100, 900),
    ])
  })

  it("sums USD + PLN portfolios into USD at known rates, grouped by date", () => {
    const rows: SnapshotRow[] = [
      { baseCurrency: "USD", snapshotDate: "2026-01-01", value: 1000, invested: 800 },
      { baseCurrency: "PLN", snapshotDate: "2026-01-01", value: 4300, invested: 4000 },
      { baseCurrency: "USD", snapshotDate: "2026-01-02", value: 1200, invested: 800 },
      { baseCurrency: "PLN", snapshotDate: "2026-01-02", value: 8600, invested: 4000 },
    ]
    // USD rate is 1 (target), PLN→USD = 1.08/4.3 = 0.25116...
    const result = sumSnapshotsByDate(rows, RATES, "USD")
    expect(result).toHaveLength(2)
    expect(result[0].date).toBe("2026-01-01")
    expect(result[0].value).toBeCloseTo(1000 + 4300 * (1.08 / 4.3), 6)
    expect(result[0].invested).toBeCloseTo(800 + 4000 * (1.08 / 4.3), 6)
    expect(result[1].date).toBe("2026-01-02")
    expect(result[1].value).toBeCloseTo(1200 + 8600 * (1.08 / 4.3), 6)
  })

  it("skips rows whose rate is unavailable — never fabricates a 1:1 rate", () => {
    const rows: SnapshotRow[] = [
      { baseCurrency: "USD", snapshotDate: "2026-01-01", value: 1000, invested: 900 },
      { baseCurrency: "ZZZ", snapshotDate: "2026-01-01", value: 5000, invested: 4000 },
    ]
    const result = sumSnapshotsByDate(rows, RATES, "USD")
    expect(result).toEqual([merged("2026-01-01", 1000, 900)])
  })

  it("with no rates table at all, only same-currency rows survive", () => {
    const rows: SnapshotRow[] = [
      { baseCurrency: "USD", snapshotDate: "2026-01-01", value: 1000, invested: 900 },
      { baseCurrency: "PLN", snapshotDate: "2026-01-01", value: 4300, invested: 4000 },
    ]
    expect(sumSnapshotsByDate(rows, NULL_RATES, "USD")).toEqual([
      merged("2026-01-01", 1000, 900),
    ])
  })

  it("empty input → empty series", () => {
    expect(sumSnapshotsByDate([], RATES, "USD")).toEqual([])
  })

  it("returns ascending by date regardless of input order", () => {
    const rows: SnapshotRow[] = [
      { baseCurrency: "USD", snapshotDate: "2026-02-01", value: 2000, invested: 1500 },
      { baseCurrency: "USD", snapshotDate: "2026-01-01", value: 1000, invested: 1500 },
    ]
    expect(sumSnapshotsByDate(rows, RATES, "USD").map((p) => p.date)).toEqual([
      "2026-01-01",
      "2026-02-01",
    ])
  })
})

describe("sumSnapshotsByDateForwardFilled (§63 follow-up)", () => {
  it("carries a portfolio's last value forward when it has no row on a date", () => {
    // B is only snapshotted on day 1 (not yet re-quoted on day 2). The naive
    // sum collapses day 2 to just A; forward-fill keeps B at its last value.
    const rows: SnapshotRow[] = [
      { portfolioId: "A", baseCurrency: "USD", snapshotDate: "2026-01-01", value: 1000, invested: 800 },
      { portfolioId: "B", baseCurrency: "USD", snapshotDate: "2026-01-01", value: 500, invested: 400 },
      { portfolioId: "A", baseCurrency: "USD", snapshotDate: "2026-01-02", value: 1200, invested: 800 },
    ]
    expect(sumSnapshotsByDate(rows, RATES, "USD")).toEqual([
      merged("2026-01-01", 1500, 1200),
      merged("2026-01-02", 1200, 800), // B dropped out
    ])
    expect(sumSnapshotsByDateForwardFilled(rows, RATES, "USD")).toEqual([
      merged("2026-01-01", 1500, 1200),
      // B carried forward — and §83.2: 0 flow, because nobody moved money into
      // B on the 2nd. Its slice of that day's return is 0, not a guess.
      merged("2026-01-02", 1700, 1200),
    ])
  })

  it("a portfolio whose first snapshot is after a date contributes 0 there", () => {
    const rows: SnapshotRow[] = [
      { portfolioId: "A", baseCurrency: "USD", snapshotDate: "2026-01-01", value: 1000, invested: 800 },
      { portfolioId: "B", baseCurrency: "USD", snapshotDate: "2026-01-02", value: 300, invested: 300 },
    ]
    expect(sumSnapshotsByDateForwardFilled(rows, RATES, "USD")).toEqual([
      merged("2026-01-01", 1000, 800),
      merged("2026-01-02", 1300, 1100),
    ])
  })

  it("converts via FX when carrying values forward", () => {
    const rows: SnapshotRow[] = [
      { portfolioId: "A", baseCurrency: "PLN", snapshotDate: "2026-01-01", value: 4300, invested: 4000 },
      { portfolioId: "B", baseCurrency: "USD", snapshotDate: "2026-01-02", value: 500, invested: 500 },
    ]
    const pln = (1.08 / 4.3)
    const result = sumSnapshotsByDateForwardFilled(rows, RATES, "USD")
    expect(result).toHaveLength(2)
    expect(result[0].value).toBeCloseTo(4300 * pln, 6)
    expect(result[1].value).toBeCloseTo(4300 * pln + 500, 6)
  })

  it("skips rows with unresolvable rates and is empty for empty input", () => {
    const rows: SnapshotRow[] = [
      { portfolioId: "A", baseCurrency: "USD", snapshotDate: "2026-01-01", value: 1000, invested: 800 },
      { portfolioId: "B", baseCurrency: "ZZZ", snapshotDate: "2026-01-02", value: 500, invested: 500 },
    ]
    expect(sumSnapshotsByDateForwardFilled(rows, RATES, "USD")).toEqual([
      merged("2026-01-01", 1000, 800),
      merged("2026-01-02", 1000, 800),
    ])
    expect(sumSnapshotsByDateForwardFilled([], RATES, "USD")).toEqual([])
  })

  it("matches the naive sum when every portfolio has a row on every date", () => {
    const rows: SnapshotRow[] = [
      { portfolioId: "A", baseCurrency: "USD", snapshotDate: "2026-01-01", value: 1000, invested: 800 },
      { portfolioId: "B", baseCurrency: "USD", snapshotDate: "2026-01-01", value: 500, invested: 400 },
      { portfolioId: "A", baseCurrency: "USD", snapshotDate: "2026-01-02", value: 1100, invested: 800 },
      { portfolioId: "B", baseCurrency: "USD", snapshotDate: "2026-01-02", value: 600, invested: 400 },
    ]
    expect(sumSnapshotsByDateForwardFilled(rows, RATES, "USD")).toEqual(sumSnapshotsByDate(rows, RATES, "USD"))
  })
})

describe("buildMergedPerformance (§46.1 money totals, §83.2 return columns)", () => {
  it("derives totalValue/totalInvested/totalReturn from the last point", () => {
    const perf = buildMergedPerformance([
      merged("2026-01-01", 1000, 800),
      merged("2026-01-02", 1200, 800),
    ])
    expect(perf.totalValue).toBe(1200)
    expect(perf.totalInvested).toBe(800)
    expect(perf.totalReturn).toBe(400)
    expect(perf.totalReturnPercent).toBeCloseTo(50, 6)
    // the "invested" line (cumulative net money-in) rides along per point
    expect(perf.timeSeries).toEqual([
      { date: "2026-01-01", value: 1000, invested: 800, cumulativeTwr: 100, unpricedValue: undefined, carriedValue: undefined },
      { date: "2026-01-02", value: 1200, invested: 800, cumulativeTwr: 120, unpricedValue: undefined, carriedValue: undefined },
    ])
  })

  it("chains the aggregate TWR off the summed value and the summed flow", () => {
    // 1200 / 1000 − 1 = +20%, 100-based index 100 → 120.
    const perf = buildMergedPerformance([
      merged("2026-01-01", 1000, 800),
      merged("2026-01-02", 1200, 800),
    ])
    expect(perf.timeWeightedReturn).toBe(20)
    expect(perf.simpleReturnPercent).toBe(20)
    // Two points and one day: §82.1's shared predicate withholds, so the
    // aggregate tile shows "—" exactly when the per-portfolio tile would.
    expect(perf.annualizedReturn).toBeNull()
    expect(perf.annualizedReturnWithheldReason).toBe("insufficient_history")
    expect(perf.monthlyReturns).toEqual([{ month: "2026-01", returnPercent: 20 }])
  })

  it("claims no return from a single point", () => {
    // One point is a LEVEL. There is no prior day to difference, so there is no
    // return to report — the old hard-null was right about this one case.
    const perf = buildMergedPerformance([merged("2026-01-01", 1000, 800)])
    expect(perf.timeWeightedReturn).toBeNull()
    expect(perf.moneyWeightedReturn).toBeNull()
    expect(perf.simpleReturnPercent).toBeUndefined()
  })

  it("empty series → zeros", () => {
    const perf = buildMergedPerformance([])
    expect(perf.totalValue).toBe(0)
    expect(perf.totalInvested).toBe(0)
    expect(perf.totalReturn).toBe(0)
    expect(perf.totalReturnPercent).toBe(0)
    expect(perf.timeSeries).toEqual([])
    expect(perf.monthlyReturns).toEqual([])
  })
})
/**
 * §63.3 — the consolidated series must be Σ positions + cash, per day.
 *
 * The unit tests above cannot make this claim: `sumSnapshotsByDate*` takes
 * `value` as an opaque number and has no idea cash exists. Cash enters one layer
 * up, in `computeSnapshotBatch` (§62.4, `totalValue += cashDay`). So the only
 * honest test of the requirement crosses the real chain — cash ledger → batch →
 * merge — and that is what this block does.
 *
 * This is the one §63.3 item that was never verified, and it is the reason the
 * headline and the chart could disagree for a session: `/total-metrics` adds the
 * live cash balance, the chart reads stored rows, and if cash were missing from
 * the stored rows the two would differ by exactly the cash balance.
 */
describe("§63.3: the consolidated series is Σ positions + cash", () => {
  beforeEach(() => {
    process.env.INSTRUMENTS_URL = "http://instruments:3000"
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.INSTRUMENTS_URL
    __resetBackfillRunnerForTests()
  })

  /** 1:1 FX everywhere; one symbol priced flat, so value moves only with cash. */
  function stubFlatPrice(symbol: string, close: number) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.includes("/api/internal/fx-rates")) {
          return new Response(JSON.stringify({ rate: 1, asOf: "2026-07-03" }), { status: 200 })
        }
        return new Response(
          JSON.stringify({
            symbol,
            dates: ["2026-07-01", "2026-07-02", "2026-07-03"],
            closes: [close, close, close],
            currency: "PLN",
            stale: false,
          }),
          { status: 200 },
        )
      }),
    )
  }

  /** Mirrors the /merged route: the batch rows carry no currency, the route
   * joins each portfolio's own `baseCurrency` on before merging. */
  function asMergedRows(rows: BatchRow[], pfId: string, ccy: string): SnapshotRow[] {
    return rows.map((r) => ({
      portfolioId: pfId,
      baseCurrency: ccy,
      snapshotDate: r.snapshotDate,
      value: Number(r.value),
      invested: Number(r.invested),
    }))
  }

  async function seedCashPortfolio(name: string, ccy = "PLN") {
    const h = await makeHarness(`633-${name}`)
    const [pf] = await h.db
      .insert(portfolios)
      .values({ userId: h.user.id, name, baseCurrency: ccy })
      .returning()
    return { h, pf }
  }

  it("a deposit raises the merged line on its own date, with no trade that day", async () => {
    // The requirement in §63.3's own words: "a deposit moves the consolidated
    // line up on that day". A cash-only portfolio makes it unambiguous — there
    // are no positions at all, so anything that moves the line came from cash.
    const { h, pf } = await seedCashPortfolio("cash-only")
    stubFlatPrice("AAA", 100)
    await h.db.insert(portfolioCashTransactions).values([
      { userId: h.user.id, portfolioId: pf.id, type: "DEPOSIT", amount: "1000", currency: "PLN", transactionDate: "2026-07-01" },
      { userId: h.user.id, portfolioId: pf.id, type: "DEPOSIT", amount: "2000", currency: "PLN", transactionDate: "2026-07-03" },
    ])

    const batch = await computeSnapshotBatch(h.db, pf.id, "Bearer t", new Date("2026-07-04T00:00:00Z"))
    const merged = buildMergedPerformance(
      sumSnapshotsByDateForwardFilled(asMergedRows(batch.rows, pf.id, "PLN"), () => 1, "PLN"),
    )

    const at = (d: string) => merged.timeSeries.find((p) => p.date === d)?.value
    expect(at("2026-07-01")).toBe(1000)
    expect(at("2026-07-02")).toBe(1000)
    // +2000 on the 03rd, from a cash row and nothing else.
    expect(at("2026-07-03")).toBe(3000)
    // And the headline the dashboard prints must equal that last point — the
    // reconciliation §63.3 was opened for.
    expect(merged.totalValue).toBe(at("2026-07-03"))
  })

  it("NEGATIVE cash reduces the consolidated line rather than being clamped or hidden", async () => {
    // XTB and IKE Beata are margin accounts and their ledgers run below zero. A
    // clamp would report a solvent fleet; dropping the day would punch a hole in
    // the chart. §62.4 says a negative balance reduces the total, which is truth.
    const { h, pf } = await seedCashPortfolio("margin")
    stubFlatPrice("AAA", 100)
    await h.db.insert(portfolioCashTransactions).values([
      { userId: h.user.id, portfolioId: pf.id, type: "DEPOSIT", amount: "5000", currency: "PLN", transactionDate: "2026-07-01" },
      { userId: h.user.id, portfolioId: pf.id, type: "WITHDRAWAL", amount: "-8000", currency: "PLN", transactionDate: "2026-07-02" },
    ])

    const batch = await computeSnapshotBatch(h.db, pf.id, "Bearer t", new Date("2026-07-04T00:00:00Z"))
    const merged = buildMergedPerformance(
      sumSnapshotsByDateForwardFilled(asMergedRows(batch.rows, pf.id, "PLN"), () => 1, "PLN"),
    )

    expect(merged.timeSeries.find((p) => p.date === "2026-07-02")?.value).toBe(-3000)
    expect(merged.totalValue).toBe(-3000)
  })

  it("the merged line equals Σ per-portfolio (positions + cash) on every date", async () => {
    // The identity the section exists to enforce, across two portfolios so the
    // merge is actually doing something.
    const a = await seedCashPortfolio("A")
    const b = await seedCashPortfolio("B")
    stubFlatPrice("AAA", 100)

    for (const { h, pf, amt } of [
      { h: a.h, pf: a.pf, amt: "1000" },
      { h: b.h, pf: b.pf, amt: "2500" },
    ]) {
      await h.db.insert(portfolioCashTransactions).values(
        [1, 2, 3].map((d) => ({
          userId: h.user.id,
          portfolioId: pf.id,
          type: "DEPOSIT" as const,
          amount: amt,
          currency: "PLN",
          transactionDate: `2026-07-0${d}`,
        })),
      )
    }

    const rowsA = (await computeSnapshotBatch(a.h.db, a.pf.id, "Bearer t", new Date("2026-07-04T00:00:00Z"))).rows
    const rowsB = (await computeSnapshotBatch(b.h.db, b.pf.id, "Bearer t", new Date("2026-07-04T00:00:00Z"))).rows
    const merged = buildMergedPerformance(
      sumSnapshotsByDateForwardFilled(
        [...asMergedRows(rowsA, a.pf.id, "PLN"), ...asMergedRows(rowsB, b.pf.id, "PLN")],
        () => 1,
        "PLN",
      ),
    )

    // Per-portfolio last points, summed, on each date.
    const lastOf = (rows: typeof rowsA) => {
      const m = new Map<string, number>()
      for (const r of rows) m.set(r.snapshotDate, Number(r.value))
      return m
    }
    const la = lastOf(rowsA)
    const lb = lastOf(rowsB)
    for (const p of merged.timeSeries) {
      expect(p.value).toBe((la.get(p.date) ?? 0) + (lb.get(p.date) ?? 0))
    }
    // Deposits accumulate day over day (3 × 1000 for A, 3 × 2500 for B), which
    // is what a real ledger does and is a stronger check than a single deposit:
    // a merge that read only the LAST row per portfolio would still pass a
    // one-deposit test.
    expect(merged.totalValue).toBe(3 * 1000 + 3 * 2500)
  })
})

/** §83.2 — the INPUT shape. `merged()` above is the sum's OUTPUT shape. */
function row(
  portfolioId: string,
  snapshotDate: string,
  value: number,
  invested: number,
  over: Partial<SnapshotRow> = {},
): SnapshotRow {
  return { portfolioId, baseCurrency: "USD", snapshotDate, value, invested, ...over }
}

/**
 * §83.2 — the aggregate's return columns are only usable if money moving does not
 * read as performance. These pin that, on the aggregate path, with the same
 * invariant §81.1 established per portfolio.
 */
describe("§83.2: the aggregate TWR ignores money moving in or between portfolios", () => {
  /** day1: A=1000, B=500 (both fully funded by their opening flow). */
  const DAY1 = [row("A", "2026-01-01", 1000, 1000, { netFlow: 1000 }), row("B", "2026-01-01", 500, 500, { netFlow: 500 })]
  const perf = (day2: SnapshotRow[]) =>
    buildMergedPerformance(sumSnapshotsByDateForwardFilled([...DAY1, ...day2], RATES, "USD"))

  const STILL = [row("A", "2026-01-02", 1000, 1000), row("B", "2026-01-02", 500, 500)]
  const DEPOSIT = [row("A", "2026-01-02", 1300, 1300, { netFlow: 300 }), row("B", "2026-01-02", 500, 500)]
  const TRANSFER = [row("A", "2026-01-02", 700, 700), row("B", "2026-01-02", 800, 800)]

  it("a deposit into one of two portfolios leaves the aggregate return unchanged", () => {
    // The test §83.2 exists for: without `net_flow` in the /merged SELECT, the
    // 1800/1500 step reads as a +20% day and the user's own deposit is reported
    // as a gain. This is the assertion that would have caught it.
    expect(perf(DEPOSIT).timeWeightedReturn).toBe(perf(STILL).timeWeightedReturn)
    expect(perf(DEPOSIT).timeWeightedReturn).toBe(0)
    // …while the money is still visibly there. "Unchanged return" must not mean
    // "deposit ignored".
    expect(perf(DEPOSIT).totalValue).toBe(1800)
    expect(perf(DEPOSIT).totalInvested).toBe(1800)
  })

  it("an internal transfer between two of the user's own portfolios leaves it unchanged", () => {
    // Both legs are external-only-excluded per portfolio (§62.4/D50), so neither
    // reaches the aggregate flow map and the aggregate value is the same number
    // either way. A transfer that moved the return would mean a portfolio's own
    // money was priced as if it were a market move.
    expect(perf(TRANSFER).timeWeightedReturn).toBe(perf(STILL).timeWeightedReturn)
    expect(perf(TRANSFER).totalValue).toBe(1500)
  })

  it("Π(1 + monthlyReturns) reconciles to the last cumulativeTwr", () => {
    const rows: SnapshotRow[] = []
    let value = 1000
    for (const [i, day] of ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"].entries()) {
      if (i > 0) value *= 1.1
      rows.push(row("A", day, value, 1000))
    }
    const p = buildMergedPerformance(sumSnapshotsByDateForwardFilled(rows, RATES, "USD"))
    const compounded = p.monthlyReturns.reduce((acc, m) => acc * (1 + m.returnPercent / 100), 1)
    const last = p.timeSeries[p.timeSeries.length - 1].cumulativeTwr!
    expect(compounded).toBeCloseTo(last / 100, 4)
    // …and the series really does span the months, or that reconciliation is
    // over one bucket and proves nothing.
    expect(p.monthlyReturns.map((m) => m.month)).toEqual(["2026-01", "2026-02", "2026-03", "2026-04"])
  })

  it("sums the withheld amounts only while every portfolio measured them", () => {
    // §78.5's rule, restated for the aggregate: `null` means "not measured", and
    // the column default is 0, so summing it as 0 would report "nothing withheld"
    // on exactly the series that most need the warning.
    const measured = sumSnapshotsByDateForwardFilled(
      [
        row("A", "2026-01-01", 1000, 1000, { unpricedValue: 40, carriedValue: 10 }),
        row("B", "2026-01-01", 500, 500, { unpricedValue: 5, carriedValue: 1 }),
      ],
      RATES,
      "USD",
    )
    expect(measured[0].unpricedValue).toBe(45)
    expect(measured[0].carriedValue).toBe(11)

    const oneUnknown = sumSnapshotsByDateForwardFilled(
      [
        row("A", "2026-01-01", 1000, 1000, { unpricedValue: 40 }),
        row("B", "2026-01-01", 500, 500, { unpricedValue: null }),
      ],
      RATES,
      "USD",
    )
    expect(oneUnknown[0].unpricedValue).toBeNull()
    expect(oneUnknown[0].carriedValue).toBeNull()
    // …and the chart sees an absent field, so it can say "unknown" rather than
    // "complete".
    expect(buildMergedPerformance(oneUnknown).timeSeries[0].unpricedValue).toBeUndefined()
  })
})

/**
 * §83.4 — the aggregate Drawdown card reads `computeRiskMetrics`, so the §81.3
 * fixture has to hold on THIS path too. The bug it caught was a deposit
 * resetting the running peak; an aggregate is where deposits are most of the
 * story, so a second, SPA-side drawdown over the summed value would have
 * reintroduced it at the largest possible scale.
 */
describe("§83.4: aggregate drawdown comes from computeRiskMetrics, not a second implementation", () => {
  it("reports −75% on the §81.3 fixture, not −50%", () => {
    // values [100, 50, 150, 75] with a 100 deposit on the 3rd day is a
    // flow-neutral index of [1, 0.5, 0.5, 0.25].
    const rows: SnapshotRow[] = [
      row("A", "2026-01-01", 100, 100, { netFlow: 100 }),
      row("A", "2026-01-02", 50, 100, { netFlow: 0 }),
      row("A", "2026-01-03", 150, 200, { netFlow: 100 }),
      row("A", "2026-01-04", 75, 200, { netFlow: 0 }),
    ]
    const perf = buildMergedPerformance(sumSnapshotsByDateForwardFilled(rows, RATES, "USD"))
    expect(perf.maxDrawdown).toBeCloseTo(-0.75, 6)
    // …and the per-point index the SPA's `currentDrawdownPercent` reads agrees
    // with it on the peak-to-trough leg: last 25 vs peak 100.
    const index = perf.timeSeries.map((p) => p.cumulativeTwr!)
    expect(Math.max(...index)).toBe(100)
    expect(index[index.length - 1]).toBeCloseTo(25, 6)
  })

  it("carries the whole Risk-tab set, and does NOT overwrite annualizedReturn's percent", () => {
    const rows: SnapshotRow[] = [1, 2, 3].map((i) =>
      row("A", `2026-01-0${i}`, 100 * (1 + i * 0.1), 100, { netFlow: i === 1 ? 100 : 0 }),
    )
    const perf = buildMergedPerformance(sumSnapshotsByDateForwardFilled(rows, RATES, "USD"))
    for (const k of ["maxDrawdown", "sharpeRatio", "sortinoRatio", "calmarRatio", "volatility", "winRate"] as const) {
      expect(typeof perf[k], k).toBe("number")
    }
    // Three points is far below the 60-point floor, so the field stays withheld
    // as a PERCENT (null), never a risk-metrics fraction of the same name.
    expect(perf.annualizedReturn).toBeNull()
    expect(perf.annualizedReturnWithheldReason).toBe("insufficient_history")
  })
})
