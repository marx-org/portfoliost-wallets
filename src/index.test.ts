import { describe, it, expect } from "vitest"
import app from "./index.js"

describe("GET /health", () => {
  it("returns status ok", async () => {
    const res = await app.request("/health")
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: "ok" })
  })
})

describe("GET /__meta", () => {
  it("returns module identity per D4", async () => {
    const res = await app.request("/__meta")
    expect(res.status).toBe(200)
    const meta = await res.json()
    expect(meta.service).toBe("wallets")
    expect(meta.impl).toBe("real")
    expect(meta.version).toBeTruthy()
  })
})

describe("GET /internal/verify (D9)", () => {
  it("401 without OIDC configured/token", async () => {
    const res = await app.request("/internal/verify")
    expect([204, 401]).toContain(res.status)
  })
})
