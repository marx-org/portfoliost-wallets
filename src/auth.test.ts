import { describe, expect, it, vi, afterEach } from "vitest"
import { Hono } from "hono"
import { userIdentityMiddleware } from "./auth.js"

function app() {
  const a = new Hono()
  a.post("/whoami", userIdentityMiddleware, (c) => c.json(c.get("userIdentity")))
  return a
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete process.env.AUTH_ME_URL
  delete process.env.POCKETID_ISSUER_URL
})

describe("dev identity resolution (opaque mock tokens)", () => {
  it("resolves the stable user from AUTH_ME_URL /api/auth/me", async () => {
    process.env.AUTH_ME_URL = "http://auth-provider:4010"
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ user: { id: "00000000-0000-4000-8000-000000000001", email: "m@x.dev" } }),
      }),
    )
    const res = await app().request("/whoami", {
      method: "POST",
      headers: { authorization: "Bearer 7ca31373-93f1-44c4-af76-f3316e0fe753" },
    })
    const identity = await res.json()
    expect(identity.id).toBe("00000000-0000-4000-8000-000000000001")
    expect(identity.email).toBe("m@x.dev")
  })

  it("falls back to token-derived identity when the provider is down", async () => {
    process.env.AUTH_ME_URL = "http://auth-provider:4010"
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("down")))
    const res = await app().request("/whoami", {
      method: "POST",
      headers: { authorization: "Bearer 7ca31373-93f1" },
    })
    const identity = await res.json()
    expect(identity.id).toBe("mock-7ca31373-93f")
  })

  it("does not fetch an unapproved auth provider URL", async () => {
    process.env.AUTH_ME_URL = "http://169.254.169.254/latest/meta-data"
    const fetchFn = vi.fn()
    vi.stubGlobal("fetch", fetchFn)

    const res = await app().request("/whoami", {
      method: "POST",
      headers: { authorization: "Bearer opaque-token" },
    })

    expect(res.status).toBe(200)
    expect((await res.json()).id).toBe("mock-opaque-token")
    expect(fetchFn).not.toHaveBeenCalled()
  })

  it("401 without any credentials", async () => {
    const res = await app().request("/whoami", { method: "POST" })
    expect(res.status).toBe(401)
  })
})
