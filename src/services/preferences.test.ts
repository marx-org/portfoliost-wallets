import { afterEach, describe, expect, it, vi } from "vitest"
import { preferredBaseCurrency } from "./preferences.js"

afterEach(() => vi.unstubAllGlobals())

function stubJson(body: unknown, ok = true) {
  return vi.fn().mockResolvedValue({ ok, json: async () => body } as Response)
}

describe("preferredBaseCurrency (§11.10 / D21b)", () => {
  it("reads uiPreferences.baseCurrency (object form)", async () => {
    vi.stubGlobal("fetch", stubJson({ userId: "u", uiPreferences: { baseCurrency: "pln" } }))
    expect(await preferredBaseCurrency({ "x-user-id": "u" })).toBe("PLN")
  })

  it("parses stringified ui_preferences", async () => {
    vi.stubGlobal("fetch", stubJson({ uiPreferences: JSON.stringify({ baseCurrency: "EUR" }) }))
    expect(await preferredBaseCurrency({})).toBe("EUR")
  })

  it("falls back to USD on invalid codes / non-ok / network errors", async () => {
    vi.stubGlobal("fetch", stubJson({ uiPreferences: { baseCurrency: "NOPE" } }))
    expect(await preferredBaseCurrency({})).toBe("USD")

    vi.stubGlobal("fetch", stubJson({}, false))
    expect(await preferredBaseCurrency({})).toBe("USD")

    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")))
    expect(await preferredBaseCurrency({})).toBe("USD")
  })

  it("calls the users-auth preferences endpoint with forwarded headers", async () => {
    const fn = stubJson({ uiPreferences: { baseCurrency: "CHF" } })
    await preferredBaseCurrency({ authorization: "Bearer x", "x-user-id": "u7" }, fn as never)
    const [url, init] = fn.mock.calls[0] as [string, RequestInit]
    expect(url).toContain("/api/users/preferences")
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer x")
  })
})
