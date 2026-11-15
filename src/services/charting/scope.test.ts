import { describe, expect, it, beforeEach } from "vitest"
import { createTestDb } from "../../db/test-db.js"
import { labels, portfolios } from "../../db/schema.js"
import type { DB } from "../../db/index.js"
import { resolveChartScope } from "./scope.js"

let db: DB

async function addPortfolio(userId: string, name: string, isVirtual = false) {
  const [row] = await db
    .insert(portfolios)
    .values({ userId, name, baseCurrency: "USD", isVirtual })
    .returning({ id: portfolios.id })
  return row.id
}

async function addLabel(userId: string, name: string) {
  const [row] = await db.insert(labels).values({ userId, name, color: "#112233" }).returning({ id: labels.id })
  return row.id
}

beforeEach(async () => {
  ;({ db } = await createTestDb())
})

describe("resolveChartScope", () => {
  it("treats an absent filter as All", async () => {
    const scope = await resolveChartScope(db, "user-1")
    expect(scope.allAccounts).toBe(true)
    expect(scope.allLabels).toBe(true)
    expect(scope.accountIds).toEqual([])
    expect(scope.labelIds).toEqual([])
    expect(scope.currency).toBe("USD")
  })

  it("splits real and virtual accounts and drops a foreign account", async () => {
    const real = await addPortfolio("user-1", "Real")
    const virtual = await addPortfolio("user-1", "Virtual", true)
    const foreign = await addPortfolio("user-2", "Foreign")

    const scope = await resolveChartScope(db, "user-1", { accountIds: [real, virtual, foreign] })
    expect(scope.allAccounts).toBe(false)
    expect(scope.accountIds).toEqual([real])
    expect(scope.virtualAccountIds).toEqual([virtual])
    expect(scope.accountIds).not.toContain(foreign)
  })

  it("does not broaden to All when every supplied account id is malformed", async () => {
    const scope = await resolveChartScope(db, "user-1", { accountIds: ["not-a-uuid"] })
    expect(scope.allAccounts).toBe(false)
    expect(scope.accountIds).toEqual([])
    expect(scope.virtualAccountIds).toEqual([])
  })

  it("keeps only owned labels and upper-cases the currency", async () => {
    const mine = await addLabel("user-1", "Core")
    const foreign = await addLabel("user-2", "Foreign")

    const scope = await resolveChartScope(db, "user-1", { labelIds: [mine, foreign], currency: "pln" })
    expect(scope.allLabels).toBe(false)
    expect(scope.labelIds).toEqual([mine])
    expect(scope.currency).toBe("PLN")
  })

  it("treats an empty-string filter as All", async () => {
    const scope = await resolveChartScope(db, "user-1", { accountIds: [""], labelIds: [] })
    expect(scope.allAccounts).toBe(true)
    expect(scope.allLabels).toBe(true)
  })

  it("passes through the date window and metric", async () => {
    const scope = await resolveChartScope(db, "user-1", { from: "2026-01-01", to: "2026-12-31", metric: "net_gain_change" })
    expect(scope.from).toBe("2026-01-01")
    expect(scope.to).toBe("2026-12-31")
    expect(scope.metric).toBe("net_gain_change")
  })
})