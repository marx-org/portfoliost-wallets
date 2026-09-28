import { describe, expect, it } from "vitest"
import { instrumentsAuthHeaders } from "../services/instruments-fx.js"
import {
  MAX_CARRY_DAYS,
  assessSymbol,
  deviationPct,
  normaliseToBarCurrency,
  pickBar,
  resolveInstrumentsToken,
  summarise,
  type TradeVerdict,
} from "./price-audit.js"

/**
 * §72 — the rules that decide whether a symbol is reported. Pure, so the policy
 * is testable without a database or a network.
 *
 * The two shapes below are the real ones. CRI.WA is the currency signature: a
 * trade off by a factor that IS a currency pair's rate. SRT.F is the venue
 * signature: most trades agree and one is far out, and the out one is the lot
 * that decides what is still held.
 */
const bar = (d: string, c: number): Map<string, number> => new Map([[d, c]])

const trade = (o: Partial<TradeVerdict> = {}): Omit<TradeVerdict, "fxHint"> => ({
  portfolioName: "IKE Marek",
  symbol: "X",
  date: "2026-09-27",
  tradePrice: 100,
  barClose: 100,
  carriedDays: 0,
  deviation: 0,
  tradeCurrency: "PLN",
  claimedCurrency: "PLN",
  ...o,
})

describe("pickBar", () => {
  it("uses the same day's close", () => {
    expect(pickBar(bar("2026-09-27", 727), "2026-09-27")).toEqual({ close: 727, carriedDays: 0 })
  })

  it("borrows the prior close for a weekend trade, and reports the gap", () => {
    // A Sunday trade has no bar of its own and is not thereby suspicious — but
    // the gap has to be visible, so a 7-day-old close is not silently compared.
    const bars = new Map([["2026-09-25", 100]])
    expect(pickBar(bars, "2026-09-27")).toEqual({ close: 100, carriedDays: 2 })
  })

  it("picks the NEAREST prior close, not the first one", () => {
    const bars = new Map([["2026-09-01", 10], ["2026-09-24", 90], ["2026-09-25", 95]])
    expect(pickBar(bars, "2026-09-27")).toEqual({ close: 95, carriedDays: 2 })
  })

  it("refuses to borrow a close older than the limit", () => {
    const bars = new Map([["2026-09-01", 100]])
    expect(pickBar(bars, "2026-09-27")).toBeNull()
    expect(MAX_CARRY_DAYS).toBe(7)
  })

  it("never borrows forward — a future close is not evidence", () => {
    expect(pickBar(bar("2026-09-28", 500), "2026-09-27")).toBeNull()
  })
})

describe("deviationPct", () => {
  it("is signed and relative to the bar", () => {
    expect(deviationPct(110, 100)).toBeCloseTo(0.1)
    expect(deviationPct(90, 100)).toBeCloseTo(-0.1)
    expect(deviationPct(100, 100)).toBe(0)
  })

  it("is NaN, not Infinity, when there is no usable bar", () => {
    expect(Number.isNaN(deviationPct(100, 0))).toBe(true)
    expect(Number.isNaN(deviationPct(100, Number.NaN))).toBe(true)
  })
})

describe("cross-currency trades (§72.10)", () => {
  const rates = new Map([["PLN>GBP", 0.1773]])

  it("converts a trade PAID in one currency into the bar's currency", () => {
    // The PROD case: a .L listing paid in PLN. 12.91 PLN x 0.1773 = £2.29 against
    // a £2.236 bar is a 2.3% move. Compared raw it read as +477%, which is how a
    // correct trade gets reported as a defect.
    const [v] = assessSymbol(
      [trade({ tradePrice: 12.91, barClose: 2.236369, tradeCurrency: "PLN", claimedCurrency: "GBP" })],
      rates,
    )
    expect(v.deviation).toBeCloseTo(0.023, 2)
  })

  it("does NOT fall back to 1:1 when the rate is unavailable — the trade is unchecked", () => {
    // Returning the unconverted number would recreate the exact false positive
    // the conversion exists to remove.
    const [v] = assessSymbol(
      [trade({ tradePrice: 12.91, barClose: 2.236369, tradeCurrency: "PLN", claimedCurrency: "GBP" })],
      new Map(),
    )
    expect(v.deviation).toBeNull()
  })

  it("leaves a same-currency trade untouched", () => {
    const [v] = assessSymbol(
      [trade({ tradePrice: 100, barClose: 101, tradeCurrency: "EUR", claimedCurrency: "EUR" })],
      new Map(),
    )
    expect(v.deviation).toBeCloseTo(-0.0099, 3)
  })
})

describe("normaliseToBarCurrency", () => {
  it("is a no-op when the currencies already agree", () => {
    expect(normaliseToBarCurrency(100, "EUR", "EUR", 5)).toEqual({ price: 100, converted: false })
  })
  it("refuses rather than degrading to 1:1 on a missing rate", () => {
    expect(normaliseToBarCurrency(100, "PLN", "GBP", null).price).toBeNaN()
    expect(normaliseToBarCurrency(100, "PLN", "GBP", 0).price).toBeNaN()
  })
  it("refuses when the bar currency is unknown", () => {
    expect(normaliseToBarCurrency(100, "PLN", null, 0.17).price).toBeNaN()
  })
})

describe("assessSymbol — remaining shapes", () => {
  it("flags a genuine mismatch in the SAME currency (the venue signature)", () => {
    // SRT3.DE shape: same currency on both sides, so no conversion applies and
    // the real 18.9% gap survives to be reported.
    const [v] = assessSymbol(
      [trade({ tradePrice: 379, barClose: 282.3, tradeCurrency: "EUR", claimedCurrency: "EUR" })],
      new Map(),
    )
    expect(Math.abs(v.deviation!)).toBeGreaterThan(0.1)
  })
})

describe("summarise", () => {
  it("counts, ranks and separates the unverifiable", () => {
    const r = summarise(
      "CRI.WA",
      assessSymbol([
        trade({ tradePrice: 194, barClose: 188, deviation: 0.0319 }),
        trade({ tradePrice: 379, barClose: 136, deviation: 1.7868 }),
      ]),
      "PLN",
      0.1,
    )
    expect(r.checked).toBe(2)
    expect(r.unreconciled).toBe(1) // only the 178% one clears a 10% tolerance
    expect(r.worstDeviation).toBeCloseTo(1.7868, 3)
    expect(r.unverifiable).toBe(false)
    expect(r.positionCurrency).toBe("PLN")
  })

  it("marks a symbol with no bars as unverifiable rather than clean", () => {
    // Silence here would read as "reconciled", which is the opposite of the truth.
    const r = summarise("OPTAAPL", assessSymbol([trade({ barClose: null, deviation: null })]), "USD", 0.1)
    expect(r.unverifiable).toBe(true)
    expect(r.unreconciled).toBe(0)
    expect(r.worstDeviation).toBe(0)
  })

  it("honours a caller tolerance", () => {
    const v = assessSymbol([trade({ tradePrice: 118, barClose: 100, deviation: 0.18 })])
    expect(summarise("X", v, "PLN", 0.1).unreconciled).toBe(1)
    expect(summarise("X", v, "PLN", 0.25).unreconciled).toBe(0)
  })
})

describe("resolveInstrumentsToken", () => {
  it("prefers the service token when the sweep provides it", () => {
    expect(resolveInstrumentsToken({ INSTRUMENTS_SERVICE_TOKEN: "svc" } as NodeJS.ProcessEnv)).toBe("svc")
  })

  it("falls back to the caller's JWT, which is what the admin job passes", () => {
    expect(resolveInstrumentsToken({ INSTRUMENTS_AUTH_TOKEN: "Bearer jwt" } as NodeJS.ProcessEnv)).toBe("Bearer jwt")
  })

  it("trims, because a padded token is a 401 that looks like an empty series", () => {
    expect(resolveInstrumentsToken({ INSTRUMENTS_SERVICE_TOKEN: "  svc  " } as NodeJS.ProcessEnv)).toBe("svc")
  })

  it("refuses rather than proceeding with no credential", () => {
    // Every bar read would be a 401 that looks like "no data", and an audit that
    // cannot check must never report clean.
    expect(() => resolveInstrumentsToken({} as NodeJS.ProcessEnv)).toThrow(/INSTRUMENTS_SERVICE_TOKEN/)
  })
})

/**
 * §72.8 — the credential decides which HEADER the token lands in, and a wrong
 * header is a 401 that is indistinguishable from "this symbol has no data".
 *
 * `instrumentsAuthHeaders` routes on the "Bearer " prefix: Bearer goes to
 * `Authorization`, anything else is sent as `X-Service-Token` and compared
 * against INSTRUMENTS_SERVICE_TOKEN. The admin job therefore has to hand the
 * token over WITH its prefix — sheets-sync strips it because its own client
 * re-prepends, and copying that pattern here silently sent a user JWT to
 * X-Service-Token. The first PROD run then reported "every trade reconciles"
 * over 219 symbols it had checked none of.
 *
 * These use the real header builder, not a stub, because the bug lived in the
 * space between "the token is correct" and "the header is correct".
 */
describe("credential → header routing (§72.8)", () => {
  it("a caller JWT sent WITH the prefix lands in Authorization", () => {
    const h = instrumentsAuthHeaders("Bearer eyJhbGciOi.payload.sig")
    expect(h["Authorization"]).toBe("Bearer eyJhbGciOi.payload.sig")
    expect(h["X-Service-Token"]).toBeUndefined()
  })

  it("a service token lands in X-Service-Token", () => {
    const h = instrumentsAuthHeaders("a".repeat(64))
    expect(h["X-Service-Token"]).toBe("a".repeat(64))
    expect(h["Authorization"]).toBeUndefined()
  })

  it("a JWT stripped of its prefix is misrouted — the exact PROD failure", () => {
    // This is what the job passed. The JWT is perfectly valid; the header is not.
    const h = instrumentsAuthHeaders("eyJhbGciOi.payload.sig")
    expect(h["Authorization"]).toBeUndefined()
    expect(h["X-Service-Token"]).toBe("eyJhbGciOi.payload.sig")
  })
})
