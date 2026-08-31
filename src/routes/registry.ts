import { Hono, type Context } from "hono"
import { sql } from "drizzle-orm"
import { CURRENCIES } from "@marx2/contracts/currencies"
import { crossRate } from "@marx2/contracts/fx"
import { userIdentityMiddleware } from "../auth.js"
import { getDb, type DB } from "../db/index.js"
import { fxRates } from "../db/schema.js"
import type { components } from "../generated/api-types.js"

type CurrenciesResponse = components["schemas"]["CurrenciesResponse"]

/**
 * Available-currencies registry (fees-and-custom-fx D26): availability SoT is
 * the fx_rates table — we support exactly the currencies we import rates for;
 * the set refreshes automatically on every daily import. Display metadata
 * comes from the contracts catalog.
 */
export async function currenciesPayload(db: DB) {
  const result = await db.execute(
    sql`select distinct currency from wallets.fx_rates order by currency`,
  )
  const list = (Array.isArray(result) ? result : (result as unknown as { rows: { currency: string }[] }).rows) as {
    currency: string
  }[]
  const codes = new Set<string>(["EUR", ...list.map((r) => String(r.currency))])
  return {
    currencies: [...codes].map((code) => {
      const meta = CURRENCIES.find((c) => c.code === code)
      return {
        code,
        name: meta?.name ?? code,
        symbol: meta?.symbol ?? code,
        minorUnits: meta?.minorUnits ?? 2,
        popular: meta?.popular ?? false,
      }
    }),
  }
}

/** Internal cross-module rate lookup (D20): ?date=&from=&to= */
async function internalRate(c: Context, db: DB) {
  const from = String(c.req.query("from") ?? "").toUpperCase()
  const to = String(c.req.query("to") ?? "EUR").toUpperCase()
  const date = c.req.query("date")
  if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) {
    return c.json({ error: "ValidationError", message: "from/to must be ISO 4217 codes" }, 422)
  }

  const buildTable = async (d: string): Promise<Record<string, number>> => {
    const rows = await db.select().from(fxRates).where(sql`${fxRates.rateDate} = ${d}`)
    const t: Record<string, number> = {}
    for (const r of rows) t[r.currency] = Number(r.rate)
    return t
  }

  // carry-forward: walk back over dated tables until the pair is quotable
  // (D39/D20 — weekends, holidays and sync gaps resolve to the last known rate)
  const walkBack = async (fromDate: string, window = 10) => {
    const dated = await db
      .select({ rateDate: sql<string>`distinct ${fxRates.rateDate}` })
      .from(fxRates)
      .where(sql`${fxRates.rateDate} <= ${fromDate}`)
      .orderBy(sql`${fxRates.rateDate} desc`)
    for (const d of dated.slice(0, window)) {
      const rate = crossRate(from, to, await buildTable(d.rateDate))
      if (rate !== undefined) return { rate, asOf: d.rateDate }
    }
    return null
  }

  if (date) {
    const found = await walkBack(date)
    if (!found) return c.json({ error: "NotFound", message: `No rate ${from}->${to} on or before ${date}` }, 404)
    return c.json(found)
  }

  const found = await walkBack(new Date().toISOString().slice(0, 10))
  if (!found) return c.json({ error: "NotFound", message: `No rate ${from}->${to} within staleness window` }, 404)
  return c.json(found)
}

export function createRegistryRoutes(db?: DB) {
  const routes = new Hono()
  const getDbInstance = () => db ?? getDb()

  routes.get("/currencies", async (c) => {
    return c.json(await currenciesPayload(getDbInstance()) satisfies CurrenciesResponse)
  })

  // SPA-facing resolved rate (fees-and-custom-fx D28/D30 UI): automatic value
  // shown in dialogs, custom inputs pre-filled from it.
  routes.get("/fx/latest", userIdentityMiddleware, async (c) => internalRate(c, getDbInstance()))

  // service-to-service (D20/D19 consumers later: portfolios)
  routes.get("/internal/fx-rates", userIdentityMiddleware, async (c) =>
    internalRate(c, getDbInstance()),
  )

  return routes
}
