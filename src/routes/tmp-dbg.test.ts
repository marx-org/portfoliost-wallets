import { it, expect } from "vitest"
import { makeHarness } from "./test-utils.js"
import { portfolios, portfolioTransactions, portfolioCashTransactions } from "../db/schema.js"
import { eq, sql } from "drizzle-orm"

it("dbg", async () => {
  const h = await makeHarness()
  const [pf] = await h.db.insert(portfolios).values({ userId: "u", name: "P", baseCurrency: "PLN" }).returning()
  const [t] = await h.db.insert(portfolioTransactions).values({
    userId: "u", portfolioId: pf.id, type: "BUY", quantity: "1", price: "1", currency: "PLN",
    externalSource: "google-sheets", externalId: "r120",
  }).returning()
  const [c] = await h.db.insert(portfolioCashTransactions).values({
    userId: "u", portfolioId: pf.id, type: "DEPOSIT", amount: "10", currency: "PLN",
    externalSource: "google-sheets", externalId: "r120#d",
  }).returning()
  console.log("tx", t.externalId, "cash", c.externalId)
  const q1 = await h.db.execute(sql`SELECT c.external_id AS ce, t.external_id AS te FROM portfolios.portfolio_cash_transactions c, portfolios.transactions t WHERE (c.external_id LIKE '%#d' OR c.external_id LIKE '%#w' OR c.external_id LIKE '%#t') AND left(c.external_id, length(c.external_id) - 2) = t.external_id`)
  console.log("match", q1.rows)
  const res = await h.db.execute(sql`UPDATE portfolios.portfolio_cash_transactions c SET linked_trade_id = t.id FROM portfolios.transactions t WHERE c.linked_trade_id IS NULL AND (c.external_id LIKE '%#d' OR c.external_id LIKE '%#w' OR c.external_id LIKE '%#t') AND left(c.external_id, length(c.external_id) - 2) = t.external_id AND c.external_source IS NOT DISTINCT FROM t.external_source`)
  console.log("updated", res.rows, (res as any).count, (res as any).affectedRows, (res as any).rowCount)
  const after = await h.db.select().from(portfolioCashTransactions).where(eq(portfolioCashTransactions.id, c.id))
  console.log("after", after[0].linkedTradeId, "want", t.id)
  expect(1).toBe(1)
})
