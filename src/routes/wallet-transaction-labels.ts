import { Hono } from "hono"
import { and, eq, inArray } from "drizzle-orm"
import { z } from "zod"
import { userIdentityMiddleware } from "../auth.js"
import { getDb, type DB } from "../db/index.js"
import { labels, walletTransactions } from "../db/schema.js"
import {
  assertLabelsOwned,
  serializeLabel,
  setWalletTransactionLabels,
} from "../services/labels.js"
import type { components } from "../generated/api-types.js"

type Label = components["schemas"]["Label"]

const SetLabelsSchema = z.object({
  labelIds: z.array(z.string().uuid()).max(100),
})

export function createWalletTransactionLabelRoutes(db?: DB) {
  const routes = new Hono()
  routes.use("*", userIdentityMiddleware)

  const getDbInstance = () => db ?? getDb()

  // POST /api/wallets/:walletId/transactions/:transactionId/labels
  routes.post("/:walletId/transactions/:transactionId/labels", async (c) => {
    const parse = SetLabelsSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parse.success) {
      return c.json({ error: "ValidationError", message: parse.error.issues[0]?.message }, 422)
    }
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const transactionId = c.req.param("transactionId")

    // D24: wallet transaction must be owned by the caller (foreign → 404)
    const [tx] = await database
      .select({ id: walletTransactions.id })
      .from(walletTransactions)
      .where(
        and(eq(walletTransactions.id, transactionId), eq(walletTransactions.userId, identity.id)),
      )
    if (!tx) return c.json({ error: "NotFound", message: "Transaction not found" }, 404)

    if (!(await assertLabelsOwned(database, identity.id, parse.data.labelIds))) {
      return c.json({ error: "NotFound", message: "One or more labels not found" }, 404)
    }

    await setWalletTransactionLabels(database, transactionId, parse.data.labelIds)

    const rows = parse.data.labelIds.length
      ? await database
          .select()
          .from(labels)
          .where(inArray(labels.id, parse.data.labelIds))
      : []
    const items = rows.map(serializeLabel).sort((a, b) => a.name.localeCompare(b.name))
    return c.json(items satisfies Label[])
  })

  return routes
}