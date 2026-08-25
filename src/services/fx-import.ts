import { sql } from "drizzle-orm"
import type { DB } from "../db/index.js"
import { fxRates, fxSyncState } from "../db/schema.js"

export const FRANKFURTER_BASE = process.env.FRANKFURTER_BASE ?? "https://api.frankfurter.dev/v1"

/** Currencies we import (EUR is the implicit base). Extending this list is what
 * grows the supported-currency registry on the next daily run (D26). */
// Full ECB/frankfurter coverage (~31 currencies). EUR is the implicit base.
export const TRACKED_CURRENCIES = [
  "USD", "PLN", "GBP", "CHF", "JPY", "CZK", "SEK", "NOK", "DKK", "HUF", "CNY",
  "AUD", "CAD", "BGN", "BRL", "HKD", "IDR", "ILS", "INR", "ISK", "KRW",
  "MXN", "MYR", "NZD", "PHP", "RON", "SGD", "THB", "TRY", "ZAR",
] as const

interface FrankfurterResponse {
  base: string
  start_date: string
  end_date: string
  rates: Record<string, Record<string, number>>
}

async function frankfurter(path: string): Promise<FrankfurterResponse> {
  const res = await fetch(`${FRANKFURTER_BASE}${path}`)
  if (!res.ok) throw new Error(`frankfurter ${res.status}: ${await res.text()}`)
  return (await res.json()) as FrankfurterResponse
}

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
}

/** Upsert a dated table of rates in one statement batch. */
export async function upsertRates(
  db: DB,
  entries: { rateDate: string; rates: Record<string, number>; source?: string }[],
) {
  let count = 0
  for (const entry of entries) {
    const values = Object.entries(entry.rates)
    if (!values.length) continue
    await db
      .insert(fxRates)
      .values(
        values.map(([currency, rate]) => ({
          rateDate: entry.rateDate,
          currency,
          rate: rate.toFixed(10),
          source: entry.source ?? "ecb",
        })),
      )
      .onConflictDoUpdate({
        target: [fxRates.rateDate, fxRates.currency],
        set: {
          rate: sql`excluded.rate`,
          source: sql`excluded.source`,
          fetchedAt: new Date(),
        },
      })
    count += values.length
  }
  return count
}

/** One-shot historical import (D25): full series since `start`. */
export async function importHistory(db: DB, opts: { start?: string } = {}) {
  const start = opts.start ?? "1999-01-04"
  const symbols = TRACKED_CURRENCIES.join(",")
  const data = await frankfurter(`/${start}..?base=EUR&symbols=${symbols}`)
  const entries = Object.entries(data.rates).map(([rateDate, rates]) => ({ rateDate, rates }))
  // frankfurter omits the end-date row sometimes; ensure newest table exists
  const count = await upsertRates(db, entries)
  await markSync(db, "import", count)
  return count
}

/** Daily incremental fetch (D20 CronJob target): recent window only. */
export async function syncDaily(db: DB) {
  const symbols = TRACKED_CURRENCIES.join(",")
  try {
    const data = await frankfurter(`/${isoDaysAgo(10)}..?base=EUR&symbols=${symbols}`)
    const entries = Object.entries(data.rates).map(([rateDate, rates]) => ({ rateDate, rates }))
    const count = await upsertRates(db, entries)
    await markSync(db, "ok", count)
    return count
  } catch (err) {
    await markSync(db, `error: ${(err as Error).message.slice(0, 200)}`, 0)
    throw err
  }
}

/** Lazy gap backfill for a single currency (D25 fallback path). */
export async function backfillCurrency(db: DB, currency: string, sinceDays = 30) {
  const data = await frankfurter(`/${isoDaysAgo(sinceDays)}..?base=EUR&symbols=${currency}`)
  const entries = Object.entries(data.rates).map(([rateDate, rates]) => ({
    rateDate,
    rates: { [currency]: rates[currency] },
  }))
  return upsertRates(db, entries)
}

async function markSync(db: DB, status: string, rowCount: number) {
  const today = new Date().toISOString().slice(0, 10)
  await db
    .insert(fxSyncState)
    .values({ id: 1, lastRateDate: today, lastRunAt: new Date(), lastStatus: status.slice(0, 200) })
    .onConflictDoUpdate({
      target: fxSyncState.id,
      set: { lastRateDate: today, lastRunAt: new Date(), lastStatus: status.slice(0, 200) },
    })
  void rowCount
}
