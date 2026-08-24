import { Hono } from "hono"
import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"
import { userIdentityMiddleware } from "../auth.js"
import { getDb, type DB } from "../db/index.js"
import { wallets, walletTransactions } from "../db/schema.js"

export const ISO_CURRENCY = /^[A-Za-z]{3}$/

export const CreateWalletSchema = z.object({
  name: z.string().min(1),
  // D18/D28: currency is mandatory — no silent USD default
  currency: z.string().regex(ISO_CURRENCY, "currency must be an ISO 4217 code"),
  // D21b: display/valuation currency; defaults from user prefs upstream (11.10)
  baseCurrency: z.string().regex(ISO_CURRENCY).optional(),
})

export const UpdateWalletSchema = z.object({
  name: z.string().min(1).optional(),
  baseCurrency: z.string().regex(ISO_CURRENCY).optional(),
  isDefault: z.boolean().optional(),
})

function serializeWallet(w: typeof wallets.$inferSelect) {
  return {
    id: w.id,
    userId: w.userId,
    name: w.name,
    currency: w.currency,
    baseCurrency: w.baseCurrency,
    balance: Number(w.balance),
    availableBalance: Number(w.availableBalance),
    reserved: Number(w.reserved),
    isDefault: w.isDefault,
    createdAt: w.createdAt.toISOString(),
    updatedAt: w.updatedAt.toISOString(),
  }
}

/**
 * Guarded delete (D18/D24): a wallet may only be deleted when it has zero
 * ledger rows (which also implies nothing references it from within the
 * wallets domain — any inbound transfer leg would itself be a row).
 */
async function assertDeletable(db: DB, walletId: string): Promise<string | null> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(walletTransactions)
    .where(
      sql`${walletTransactions.walletId} = ${walletId} or ${walletTransactions.toWalletId} = ${walletId}`,
    )
  return row && row.count === 0 ? null : "wallet has transactions"
}

export function createWalletRoutes(db?: DB) {
  const routes = new Hono()
  routes.use("*", userIdentityMiddleware)

  const getDbInstance = () => db ?? getDb()

  routes.post("/", async (c) => {
    const parsed = CreateWalletSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: "ValidationError", message: parsed.error.issues[0]?.message }, 422)
    }
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const [created] = await database
      .insert(wallets)
      .values({
        userId: identity.id,
        name: parsed.data.name,
        currency: parsed.data.currency.toUpperCase(),
        baseCurrency: (parsed.data.baseCurrency ?? "USD").toUpperCase(),
      })
      .returning()
    return c.json(serializeWallet(created), 201)
  })

  routes.get("/", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const rows = await database.select().from(wallets).where(eq(wallets.userId, identity.id))
    return c.json(rows.map(serializeWallet))
  })

  routes.patch("/:id", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const parsed = UpdateWalletSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: "ValidationError", message: parsed.error.issues[0]?.message }, 422)
    }
    const patch: Record<string, unknown> = { updatedAt: new Date() }
    if (parsed.data.name !== undefined) patch.name = parsed.data.name
    if (parsed.data.baseCurrency !== undefined)
      patch.baseCurrency = parsed.data.baseCurrency.toUpperCase()
    if (parsed.data.isDefault !== undefined) patch.isDefault = parsed.data.isDefault

    // D24: scoped by owner — foreign wallets are 404, not 403
    const [updated] = await database
      .update(wallets)
      .set(patch)
      .where(and(eq(wallets.id, c.req.param("id")), eq(wallets.userId, identity.id)))
      .returning()
    if (!updated) {
      return c.json({ error: "NotFound", message: "Wallet not found" }, 404)
    }
    return c.json(serializeWallet(updated))
  })

  routes.delete("/:id", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const id = c.req.param("id")
    const [owned] = await database
      .select({ id: wallets.id })
      .from(wallets)
      .where(and(eq(wallets.id, id), eq(wallets.userId, identity.id)))
    if (!owned) {
      return c.json({ error: "NotFound", message: "Wallet not found" }, 404)
    }
    if ((await assertDeletable(database, id)) !== null) {
      return c.json(
        { error: "Conflict", message: "Wallet has transactions and cannot be deleted" },
        409,
      )
    }
    await database.delete(wallets).where(eq(wallets.id, id))
    return c.body(null, 204)
  })

  return routes
}
