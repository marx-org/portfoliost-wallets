import { Hono, type Context } from "hono"
import { and, eq } from "drizzle-orm"
import { z } from "zod"
import { userIdentityMiddleware } from "../auth.js"
import { getDb, type DB } from "../db/index.js"
import { wallets, portfolios } from "../db/schema.js"
import { preferredBaseCurrency } from "../services/preferences.js"
import { ISO_CURRENCY } from "./wallets.js"
import type { components } from "../generated/api-types.js"

type ImportWalletBootstrapResponse = components["schemas"]["ImportWalletBootstrapResponse"]
type ImportPortfolioBootstrapResponse = components["schemas"]["ImportPortfolioBootstrapResponse"]

const ExternalSourceSchema = z.object({ externalSource: z.string().min(1) })

const ImportWalletSchema = z
  .object({
    name: z.string().min(1),
    currency: z.string().regex(ISO_CURRENCY, "currency must be an ISO 4217 code"),
    baseCurrency: z.string().regex(ISO_CURRENCY).optional(),
  })
  .strict()

export const ImportWalletBootstrapRequestSchema = ExternalSourceSchema.extend({
  wallets: z.array(ImportWalletSchema).min(1),
}).strict()

export const ImportPortfolioBootstrapRequestSchema = ExternalSourceSchema.extend({
  name: z.string().min(1),
  currency: z.string().regex(ISO_CURRENCY, "currency must be an ISO 4217 code"),
  baseCurrency: z.string().regex(ISO_CURRENCY).optional(),
}).strict()

function validationError(c: Context, parsed: { error?: { issues?: { message?: string }[] } }) {
  return c.json({ error: "ValidationError", message: parsed.error?.issues?.[0]?.message }, 422)
}

/**
 * Import bootstrap (§23.3). Idempotently ensures wallets/portfolios exist,
 * matched on the unique (userId, name) natural key. `external_source` is set
 * on INSERT only — re-bootstrapping an existing row never re-tags it, so the
 * wipe endpoint (23.5) only ever removes what this importer created.
 */
export function createImportRoutes(db?: DB) {
  const routes = new Hono()
  routes.use("*", userIdentityMiddleware)

  const getDbInstance = () => db ?? getDb()

  routes.post("/wallets/bootstrap", async (c) => {
    const parsed = ImportWalletBootstrapRequestSchema.safeParse(
      await c.req.json().catch(() => ({})))
    if (!parsed.success) return validationError(c, parsed)
    const identity = c.get("userIdentity")
    const database = getDbInstance()

    const forwardedHeaders: Record<string, string> = {}
    for (const k of ["authorization", "x-user-id", "x-user-email"]) {
      const v = c.req.header(k)
      if (v) forwardedHeaders[k] = v
    }
    const defaultBase = await preferredBaseCurrency(forwardedHeaders)

    const items: NonNullable<ImportWalletBootstrapResponse["wallets"]> = []
    for (const w of parsed.data.wallets) {
      const baseCurrency = (w.baseCurrency ?? defaultBase).toUpperCase()
      const [inserted] = await database
        .insert(wallets)
        .values({
          userId: identity.id,
          name: w.name,
          currency: w.currency.toUpperCase(),
          baseCurrency,
          externalSource: parsed.data.externalSource,
        })
        .onConflictDoNothing({ target: [wallets.userId, wallets.name] })
        .returning()

      const [row] = inserted
        ? [inserted]
        : await database
            .select()
            .from(wallets)
            .where(and(eq(wallets.userId, identity.id), eq(wallets.name, w.name)))
            .limit(1)

      items.push({
        id: row.id,
        name: row.name,
        currency: row.currency,
        baseCurrency: row.baseCurrency,
        created: Boolean(inserted),
      })
    }

    return c.json({ wallets: items } satisfies ImportWalletBootstrapResponse)
  })

  routes.post("/portfolios/bootstrap", async (c) => {
    const parsed = ImportPortfolioBootstrapRequestSchema.safeParse(
      await c.req.json().catch(() => ({})))
    if (!parsed.success) return validationError(c, parsed)
    const identity = c.get("userIdentity")
    const database = getDbInstance()

    const forwardedHeaders: Record<string, string> = {}
    for (const k of ["authorization", "x-user-id", "x-user-email"]) {
      const v = c.req.header(k)
      if (v) forwardedHeaders[k] = v
    }
    const defaultBase = await preferredBaseCurrency(forwardedHeaders)
    const baseCurrency = (parsed.data.baseCurrency ?? defaultBase).toUpperCase()

    const [inserted] = await database
      .insert(portfolios)
      .values({
        userId: identity.id,
        name: parsed.data.name,
        currency: parsed.data.currency.toUpperCase(),
        baseCurrency,
        externalSource: parsed.data.externalSource,
      })
      .onConflictDoNothing({ target: [portfolios.userId, portfolios.name] })
      .returning()

    const [row] = inserted
      ? [inserted]
      : await database
          .select()
          .from(portfolios)
          .where(and(eq(portfolios.userId, identity.id), eq(portfolios.name, parsed.data.name)))
          .limit(1)

    return c.json({
      id: row.id,
      name: row.name,
      currency: row.currency,
      baseCurrency: row.baseCurrency,
      created: Boolean(inserted),
    } satisfies ImportPortfolioBootstrapResponse)
  })

  return routes
}