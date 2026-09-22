/**
 * Test helper (plan §48.3) — stand-in for the instruments FX service.
 *
 * Seeding a EUR-quoted rate table, it stubs `globalThis.fetch` so the
 * instruments client (`/api/internal/fx-rates`) resolves pair cross-rates
 * through `@marx2/contracts/fx` (D27) — the same math the real service runs.
 * Unresolvable pairs 404 (the old "pair missing from the table" behavior).
 */
import { vi } from "vitest"
import { crossRate } from "@marx2/contracts/fx"

export interface FxMockOpts {
  /** EUR-quoted table (EUR is the implicit 1). */
  table: Record<string, number>
  asOf?: string
  /** When true, every pair 404s (the "no table at all" degrade). */
  empty?: boolean
}

const INSTRUMENTS_URL = "http://instruments.test"

export function mockInstrumentsFx(opts: FxMockOpts): void {
  process.env.INSTRUMENTS_URL = INSTRUMENTS_URL
  const asOf = opts.asOf ?? "2026-09-21"
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes("/api/internal/fx-rates")) {
        const q = new URL(url).searchParams
        const from = (q.get("from") ?? "").toUpperCase()
        const to = (q.get("to") ?? "EUR").toUpperCase()
        if (from === to) return new Response(JSON.stringify({ rate: 1, asOf }), { status: 200 })
        if (opts.empty) {
          return new Response(JSON.stringify({ error: "NotFound", message: "no rate" }), { status: 404 })
        }
        const rate = crossRate(from, to, { EUR: 1, ...opts.table })
        if (rate === undefined) {
          return new Response(JSON.stringify({ error: "NotFound", message: "no rate" }), { status: 404 })
        }
        return new Response(JSON.stringify({ rate, asOf }), { status: 200 })
      }
      return new Response("not found", { status: 404 })
    }),
  )
}

/** Clear the fetch stub (call in afterEach). */
export function unmockInstrumentsFx(): void {
  vi.unstubAllGlobals()
  delete process.env.INSTRUMENTS_URL
}
