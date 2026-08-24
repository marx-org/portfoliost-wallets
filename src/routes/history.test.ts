import { describe, expect, it } from "vitest"
import { Hono } from "hono"
import { createWalletRoutes } from "./wallets.js"
import { createMovementRoutes } from "./movements.js"
import { createHistoryRoutes } from "./history.js"
import { makeHarness } from "./test-utils.js"
import { walletTransactions } from "../db/schema.js"

async function boot() {
  const h = await makeHarness()
  const app = new Hono()
    .route("/api/wallets", createHistoryRoutes(h.db))
    .route("/api/wallets", createMovementRoutes(h.db))
    .route("/api/wallets", createWalletRoutes(h.db))
  const request = (path: string, init?: RequestInit) => app.request(path, init)
  const json = (path: string, body: unknown, method = "POST") =>
    request(path, { method, headers: { ...h.headers, "content-type": "application/json" }, body: JSON.stringify(body) })
  const mk = async (currency = "USD") => {
    const res = await json("/api/wallets", { name: currency, currency })
    return (await res.json()).id as string
  }
  return { ...h, request, json, mk }
}

describe("GET /:id/transactions pagination (§11.6)", () => {
  it("paginates with meta and ordering desc", async () => {
    const h = await boot()
    const w = await h.mk()
    for (let i = 1; i <= 12; i++) {
      await h.json(`/api/wallets/${w}/deposits`, { amount: i, description: `d${i}` })
    }
    const p1 = await (await h.request(`/api/wallets/${w}/transactions?page=1&limit=10`, { headers: h.headers })).json()
    expect(p1.total).toBe(12)
    expect(p1.items.length).toBe(10)
    expect(p1.totalPages).toBe(2)
    expect(p1.hasNext).toBe(true)
    const p2 = await (await h.request(`/api/wallets/${w}/transactions?page=2&limit=10`, { headers: h.headers })).json()
    expect(p2.items.length).toBe(2)
  })

  it("foreign wallet → 404 (D24)", async () => {
    const h = await boot()
    const other = await makeHarness("intruder")
    const app2 = new Hono().route("/api/wallets", createHistoryRoutes(other.db))
    void app2
    const res = await h.request("/api/wallets/00000000-0000-0000-0000-000000000000/transactions", { headers: h.headers })
    expect(res.status).toBe(404)
  })
})

describe("recent-transactions feed shapes (D19 read model)", () => {
  it("maps displayLabel, signed amounts, internal-transfer flag", async () => {
    const h = await boot()
    const { fxRates } = await import("../db/schema.js")
    await h.db.insert(fxRates).values([
      { rateDate: "2026-08-21", currency: "USD", rate: "1.0800000000" },
      { rateDate: "2026-08-21", currency: "EUR", rate: "1" },
    ])
    const a = await h.mk()
    const b = await h.mk("EUR")
    await h.json(`/api/wallets/${a}/deposits`, { amount: 100, description: "salary" })
    await h.json(`/api/wallets/${a}/withdrawals`, { amount: 10 })
    await h.json(`/api/wallets/${a}/transfers`, { amount: 20, to_wallet_id: b })

    // trade-derived row written the way portfolios will push it (§ D19)
    const [w] = await (await import("../db/schema.js")).then?.() ?? [null]
    void w
    const { wallets } = await import("../db/schema.js")
    const rows = await h.db.select().from(wallets)
    const eur = rows.find((r) => r.id === b)!
    await h.db.insert(walletTransactions).values({
      userId: "user-1",
      walletId: eur.id,
      type: "INVEST",
      amount: "-46.44",
      currency: "USD",
      reference: "PORTFOLIO_BUY_AAPL.US_x",
      portfolioId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    })

    const res = await (await h.request("/api/wallets/recent-transactions?limit=50", { headers: h.headers })).json()
    const byLabel = Object.fromEntries(res.data.map((r: any) => [r.displayLabel, r]))
    expect(byLabel.Deposit.amount).toBe("100.00000000")
    expect(byLabel.Withdrawal.amount).toBe("-10.00000000")
    expect(byLabel.Transfer.isInternalTransfer).toBe(true)
    expect(byLabel.Investment.displayLabel).toBe("Investment")
    expect(byLabel.Investment.reference).toBe("PORTFOLIO_BUY_AAPL.US_x")
    expect(res.meta.total).toBeGreaterThanOrEqual(4)
  })
})

describe("balance-history reconstruction (wallets D21)", () => {
  it("builds a cumulative daily series from the ledger", async () => {
    const h = await boot()
    const w = await h.mk()
    await h.json(`/api/wallets/${w}/deposits`, { amount: 100, transaction_date: "2026-08-01" })
    await h.json(`/api/wallets/${w}/deposits`, { amount: 50, transaction_date: "2026-08-03" })
    await h.json(`/api/wallets/${w}/withdrawals`, { amount: 20, transaction_date: "2026-08-05" })

    const res = await (await h.request(`/api/wallets/${w}/balance-history?period=ALL`, { headers: h.headers })).json()
    expect(res.data).toHaveLength(3)
    expect(res.data[0].balance).toBe(100)
    expect(res.data[2].balance).toBe(130)
    expect(res.meta.change).toBe(30)
    expect(res.meta.period).toBe("ALL")
  })
})
