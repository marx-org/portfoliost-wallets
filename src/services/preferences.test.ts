import { afterEach, describe, expect, it, vi } from "vitest"
import { preferredBaseCurrency } from "./preferences.js"

afterEach(() => vi.unstubAllGlobals())

function stubJson(body: unknown, ok = true) {
  return vi
    .fn()
    .mockResolvedValue({ ok, status: ok ? 200 : 500, json: async () => body } as Response)
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

  it("§66.4: an UNSET preference may default, an UNREADABLE one may not", async () => {
    // genuinely unset / invalid code -> the one honest default
    vi.stubGlobal("fetch", stubJson({ uiPreferences: { baseCurrency: "NOPE" } }))
    expect(await preferredBaseCurrency({})).toBe("USD")
    vi.stubGlobal("fetch", stubJson({}))
    expect(await preferredBaseCurrency({})).toBe("USD")

    // a read failure used to return "USD" too, which silently persisted USD as a
    // portfolio's base currency and denominated the whole aggregate in USD
    vi.stubGlobal("fetch", stubJson({}, false))
    await expect(preferredBaseCurrency({})).rejects.toThrow(/preferences returned 500/)
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")))
    await expect(preferredBaseCurrency({})).rejects.toThrow(/could not read preferences/)

    // …and a caller that genuinely cannot fail (portfolio creation, sheets
    // import) opts out explicitly rather than relying on the old accident
    vi.stubGlobal("fetch", stubJson({}, false))
    expect(await preferredBaseCurrency({}, undefined, { strict: false })).toBe("USD")
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")))
    expect(await preferredBaseCurrency({}, undefined, { strict: false })).toBe("USD")
  })

  it("calls the users-auth preferences endpoint with forwarded headers", async () => {
    const fn = stubJson({ uiPreferences: { baseCurrency: "CHF" } })
    await preferredBaseCurrency({ authorization: "Bearer x", "x-user-id": "u7" }, fn as never)
    const [url, init] = fn.mock.calls[0] as [string, RequestInit]
    expect(url).toContain("/api/users/preferences")
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer x")
  })
})
