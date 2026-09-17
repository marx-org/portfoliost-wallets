import { Hono } from "hono"
import { and, eq, sql } from "drizzle-orm"
import { z } from "zod"
import { userIdentityMiddleware } from "../auth.js"
import { getDb, type DB } from "../db/index.js"
import { wallets, walletTransactions, portfolios } from "../db/schema.js"
import { totalBalance } from "../services/valuation.js"
import { preferredBaseCurrency } from "../services/preferences.js"
import type { components } from "../generated/api-types.js"

type CashWallet = components["schemas"]["CashWallet"]
type WalletsTotalBalance = components["schemas"]["WalletsTotalBalance"]

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
 * ledger rows and is not referenced as the cash wallet of any portfolio.
 * Returns a human-readable reason string on conflict, or null when safe.
 */
async function assertDeletable(db: DB, walletId: string): Promise<string | null> {
  const [txRow] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(walletTransactions)
    .where(
      sql`${walletTransactions.walletId} = ${walletId} or ${walletTransactions.toWalletId} = ${walletId}`,
    )
  if (txRow && txRow.count > 0) return "wallet has transactions"

  const [portRow] = await db
    .select({ name: portfolios.name })
    .from(portfolios)
    .where(eq(portfolios.walletId, walletId))
    .limit(1)
  if (portRow) return `wallet is linked to portfolio "${portRow.name}"`

  return null
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
    // D21b: explicit value wins; otherwise the user's preferred base currency
    const forwardedHeaders: Record<string, string> = {}
    for (const k of ["authorization", "x-user-id", "x-user-email"]) {
      const v = c.req.header(k)
      if (v) forwardedHeaders[k] = v
    }
    const defaultBase =
      parsed.data.baseCurrency ?? (await preferredBaseCurrency(forwardedHeaders))
    try {
      const [created] = await database
        .insert(wallets)
        .values({
          userId: identity.id,
          name: parsed.data.name,
          currency: parsed.data.currency.toUpperCase(),
          baseCurrency: defaultBase.toUpperCase(),
        })
        .returning()
      return c.json(serializeWallet(created) satisfies CashWallet, 201)
    } catch (err) {
      // uq_wallets_user_name (import bootstrap natural key) — duplicate name
      if ((err as { cause?: { code?: string } }).cause?.code === "23505") {
        return c.json(
          { error: "Conflict", message: `A wallet named "${parsed.data.name}" already exists` },
          409,
        )
      }
      throw err
    }
  })

  routes.get("/", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const rows = await database.select().from(wallets).where(eq(wallets.userId, identity.id))
    return c.json(rows.map(serializeWallet) satisfies CashWallet[])
  })

  // NOTE: registered before Hono sees "/:id" — static wins in the router
  routes.get("/total-balance", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const base = (c.req.query("baseCurrency") ?? "USD").toUpperCase()
    return c.json(await totalBalance(database, identity.id, base) satisfies WalletsTotalBalance)
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
    return c.json(serializeWallet(updated) satisfies CashWallet)
  })

  routes.delete("/:id", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const id = c.req.param("id")
    const [owned] = await database
      .select({ id: wallets.id, name: wallets.name })
      .from(wallets)
      .where(and(eq(wallets.id, id), eq(wallets.userId, identity.id)))
    if (!owned) {
      return c.json({ error: "NotFound", message: "Wallet not found" }, 404)
    }
    const reason = await assertDeletable(database, id)
    if (reason !== null) {
      const walletName = owned.name ?? id
      const message = reason.startsWith("wallet is linked to portfolio")
        ? `Cannot delete "${walletName}" — it is used as the cash wallet of ${reason.replace('wallet is linked to portfolio ', 'portfolio ')}. Remove or reassign that portfolio's cash wallet first.`
        : `Cannot delete "${walletName}" — it has transactions. Delete all transactions first.`
      return c.json({ error: "Conflict", message }, 409)
    }
    await database.delete(wallets).where(eq(wallets.id, id))
    return c.body(null, 204)
  })

  return routes
}
