import { Hono } from "hono"
import { userIdentityMiddleware, requireGroup } from "../auth.js"
import { getDb, type DB } from "../db/index.js"
import { fxRates } from "../db/schema.js"
import { sql, asc, desc, and, gte, lte, eq } from "drizzle-orm"

export function createAdminRoutes(db?: DB) {
  const admin = new Hono()
  admin.use("*", userIdentityMiddleware, requireGroup("portfoliost_admin"))

  admin.get("/fx-rates", async (c) => {
    const d = db ?? getDb()
    const page = Math.max(1, parseInt(c.req.query("page") ?? "1", 10))
    const perPage = Math.min(200, Math.max(1, parseInt(c.req.query("per_page") ?? "50", 10)))
    const sortBy = c.req.query("sort_by") ?? "date"
    const sortDir = c.req.query("sort_dir") === "asc" ? "asc" : "desc"
    const baseCurrency = c.req.query("base_currency")
    const quoteCurrency = c.req.query("quote_currency")
    const dateFrom = c.req.query("date_from")
    const dateTo = c.req.query("date_to")

    const conditions = []
    if (baseCurrency) conditions.push(eq(fxRates.currency, baseCurrency.toUpperCase()))
    if (dateFrom) conditions.push(gte(fxRates.rateDate, dateFrom))
    if (dateTo) conditions.push(lte(fxRates.rateDate, dateTo))

    const where = conditions.length > 0 ? and(...conditions) : undefined

    // Count total
    const countResult = await d.execute(
      sql`SELECT COUNT(*) as count FROM wallets.fx_rates ${where ? sql`WHERE ${where}` : sql``}`
    )
    const countRows = (Array.isArray(countResult) ? countResult : (countResult as unknown as { rows: { count: string }[] }).rows) as { count: string }[]
    const total = parseInt(countRows[0]?.count ?? "0", 10)
    const totalPages = Math.ceil(total / perPage)

    // Sort column mapping
    const sortColumn = sortBy === "base_currency" ? fxRates.currency
      : sortBy === "rate" ? fxRates.rate
      : fxRates.rateDate
    const orderFn = sortDir === "asc" ? asc : desc

    const offset = (page - 1) * perPage
    const rows = await d.execute(
      sql`SELECT rate_date, currency, rate FROM wallets.fx_rates
          ${where ? sql`WHERE ${where}` : sql``}
          ORDER BY ${orderFn(sortColumn)}
          LIMIT ${perPage} OFFSET ${offset}`
    )
    const items = (Array.isArray(rows) ? rows : (rows as unknown as { rows: Record<string, unknown>[] }).rows).map((r) => ({
      date: String(r.rate_date),
      baseCurrency: "EUR",
      quoteCurrency: String(r.currency),
      rate: parseFloat(String(r.rate)),
    }))

    // Filter quote_currency in-memory (it's EUR-based, quote = currency code)
    const filtered = quoteCurrency
      ? items.filter((i) => i.quoteCurrency === quoteCurrency.toUpperCase())
      : items

    return c.json({
      items: filtered,
      pagination: { total, page, per_page: perPage, total_pages: totalPages },
    })
  })

  return admin
}
