import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  InstrumentsUnavailableError,
  instrumentsAuthHeaders,
  resolvedFxRate,
} from "./instruments-fx.js"

/**
 * §63.10 — how wallets authenticates to instruments, and what it does when
 * instruments cannot answer.
 *
 * The credential split matters because the two callers are different kinds of
 * thing: the SPA is a user, the scheduled snapshot sweep is not (it iterates
 * every portfolio of every user). And the failure split matters more — a
 * transport rejection used to look exactly like "this symbol has no price
 * history", which is how a 401 became cash-only snapshots for the whole fleet.
 */

const prevUrl = process.env.INSTRUMENTS_URL

afterEach(() => {
  vi.unstubAllGlobals()
  if (prevUrl === undefined) delete process.env.INSTRUMENTS_URL
  else process.env.INSTRUMENTS_URL = prevUrl
})

describe("instrumentsAuthHeaders", () => {
  it("sends a Bearer credential as Authorization (the browser / interactive path)", () => {
    expect(instrumentsAuthHeaders("Bearer abc.def.ghi")).toEqual({ Authorization: "Bearer abc.def.ghi" })
  })

  it("sends an opaque credential as X-Service-Token (the scheduled sweep)", () => {
    expect(instrumentsAuthHeaders("s3cr3t")).toEqual({ "X-Service-Token": "s3cr3t" })
  })

  it("sends nothing without a credential", () => {
    expect(instrumentsAuthHeaders("")).toEqual({})
    expect(instrumentsAuthHeaders(null)).toEqual({})
    expect(instrumentsAuthHeaders(undefined)).toEqual({})
  })
})

describe("resolvedFxRate — strict vs degrade", () => {
  beforeEach(() => {
    process.env.INSTRUMENTS_URL = "http://instruments.test"
  })

  const fxOk = (rate: unknown) =>
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ rate, asOf: "2026-09-16" }) }))

  it("returns the rate when instruments answers", async () => {
    fxOk(1.075)
    await expect(resolvedFxRate("t", "PLN", "USD")).resolves.toEqual({ rate: 1.075, asOf: "2026-09-16" })
  })

  it("degrades to 'no rate' (null) when the pair is genuinely unresolvable", async () => {
    // 200 but no numeric rate — a real miss, not a transport problem.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }))
    await expect(resolvedFxRate("t", "PLN", "USD")).resolves.toBeNull()
    await expect(resolvedFxRate("t", "PLN", "USD", undefined, { strict: true })).resolves.toBeNull()
  })

  it("THROWS on 401 in strict mode, so the backfill cannot value 1:1", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }))
    await expect(resolvedFxRate("t", "PLN", "USD", undefined, { strict: true })).rejects.toBeInstanceOf(
      InstrumentsUnavailableError,
    )
  })

  it("degrades to null on 401 in the default (interactive) mode", async () => {
    // A transient instruments blip must not fail a user's deposit.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({}) }))
    await expect(resolvedFxRate("t", "PLN", "USD")).resolves.toBeNull()
  })

  it("THROWS on 5xx and on an unreachable host in strict mode", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({}) }))
    await expect(resolvedFxRate("t", "PLN", "USD", undefined, { strict: true })).rejects.toBeInstanceOf(
      InstrumentsUnavailableError,
    )
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")))
    await expect(resolvedFxRate("t", "PLN", "USD", undefined, { strict: true })).rejects.toBeInstanceOf(
      InstrumentsUnavailableError,
    )
  })

  it("sends the credential the caller was given", async () => {
    const spy = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ rate: 1, asOf: "x" }) })
    vi.stubGlobal("fetch", spy)
    await resolvedFxRate("s3cr3t", "PLN", "USD")
    expect((spy.mock.calls[0][1] as { headers: Record<string, string> }).headers).toEqual({
      "X-Service-Token": "s3cr3t",
    })
    await resolvedFxRate("Bearer jwt", "PLN", "USD")
    expect((spy.mock.calls[1][1] as { headers: Record<string, string> }).headers).toEqual({
      Authorization: "Bearer jwt",
    })
  })
})
