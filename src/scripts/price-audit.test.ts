import { describe, expect, it } from "vitest"
import { instrumentsAuthHeaders } from "../services/instruments-fx.js"
import {
  MAX_CARRY_DAYS,
  assessSymbol,
  deviationPct,
  fxHint,
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

describe("fxHint", () => {
  const rates = new Map([["PLN>CAD", 2.7131]])

  it("names the pair when the ratio IS that pair's rate (the CRI.WA shape)", () => {
    // Trade recorded in PLN, bar denominated in CAD: the ratio is the rate.
    expect(fxHint(2.7131, "PLN", "CAD", rates)).toBe("PLN>CAD")
  })

  it("stays quiet for ordinary market movement", () => {
    expect(fxHint(1.164, "PLN", "CAD", rates)).toBeNull()
  })

  it("stays quiet when there is no pair to compare against", () => {
    expect(fxHint(2.7131, "PLN", "CAD", new Map())).toBeNull()
  })

  it("does not hint when the trade currency is already the bar currency", () => {
    expect(fxHint(1, "CAD", "CAD", rates)).toBeNull()
  })
})

describe("assessSymbol — the two PROD shapes", () => {
  it("flags the currency signature and names the pair", () => {
    const [v] = assessSymbol(
      [trade({ tradePrice: 369, barClose: 136, tradeCurrency: "PLN", claimedCurrency: "CAD" })],
      new Map([["PLN>CAD", 2.7131]]),
    )
    // 369 / 136 = 2.7132 — the CAD→PLN factor to four figures.
    expect(v.deviation).toBeCloseTo(1.7132, 3)
    expect(v.fxHint).toBe("PLN>CAD")
  })

  it("flags the venue signature and leaves the pair unnamed", () => {
    // SRT3.DE shape: most trades agree, one is 16% out because the bar is the
    // wrong share class. No FX rate explains it — a sibling listing does.
    const [v] = assessSymbol(
      [trade({ tradePrice: 379, barClose: 325.5, tradeCurrency: "EUR", claimedCurrency: "EUR" })],
      new Map([["PLN>CAD", 2.7131]]),
    )
    expect(Math.abs(v.deviation!)).toBeGreaterThan(0.1)
    expect(v.fxHint).toBeNull()
  })

  it("leaves fxHint null when there is no bar to divide by", () => {
    const [v] = assessSymbol([trade({ barClose: null, deviation: null })])
    expect(v.fxHint).toBeNull()
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
