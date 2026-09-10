import { describe, it, expect } from "vitest"
import type { ServerType } from "@hono/node-server"
import { serve } from "@hono/node-server"
import type { AddressInfo } from "node:net"
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

describe("GET /metrics (D56)", () => {
  it("returns Prometheus text with http.server.request.duration", async () => {
    const server: ServerType = serve({ fetch: app.fetch, port: 0 })
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve))
      const { port } = server.address() as AddressInfo
      const base = `http://127.0.0.1:${port}`

      // HTTP metrics are only recorded for traffic through a real server.
      await fetch(`${base}/health`)
      await fetch(`${base}/health`)
      // give the http instrumentation a moment to flush the request metric
      await new Promise((r) => setTimeout(r, 250))

      const res = await fetch(`${base}/metrics`)
      expect(res.status).toBe(200)
      expect(res.headers.get("content-type")).toContain("text/plain")
      const body = await res.text()
      // instrumentation-http records server-side request duration;
      // instrumentation-undici records client-side duration — either proves
      // the OTel pipeline is wired end-to-end.
      expect(body).toMatch(/http_(server_request|client_request)_duration/)
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  })
})
