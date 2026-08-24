import { eq } from "drizzle-orm"
import { convert } from "@marx2/contracts/fx"
import type { DB } from "../db/index.js"
import { wallets } from "../db/schema.js"
import { latestRates } from "./fee-fx.js"

export interface ValuedWallet {
  id: string
  name: string
  currency: string
  baseCurrency: string
  balance: number
  availableBalance: number
}

/** Snapshot semantics (D21): manual wins verbatim; auto resolves from fx_rates. */
export async function snapshotRate(
  db: DB,
  fromCcy: string,
  toCcy: string,
  manual?: number,
): Promise<{ rate: number; source: "automatic" | "manual" }> {
  if (fromCcy === toCcy) return { rate: 1, source: manual != null ? "manual" : "automatic" }
  if (manual != null && Number.isFinite(manual) && manual > 0) return { rate: manual, source: "manual" }
  const table = await latestRates(db)
  const rate = table ? convert(1, fromCcy, toCcy, table) : undefined
  return { rate: rate ?? 1, source: "automatic" }
}

/** Total-balance aggregation (D21b/D26): every wallet valued in ITS OWN
 * base_currency... aggregated per user preference upstream. Here: value all
 * wallets in the REQUESTED base currency (default USD) at latest rates. */
export async function totalBalance(db: DB, userId: string, baseCurrency = "USD") {
  const rows = await db.select().from(wallets).where(eq(wallets.userId, userId))
  const base = baseCurrency.toUpperCase()
  const table = await latestRates(db)

  let total = 0
  let totalAvailable = 0
  const rawBreakdown = rows.map((w) => {
    const balance = Number(w.balance)
    const available = Number(w.availableBalance)
    const rate =
      w.currency === base ? 1 : table ? convert(1, w.currency, base, table) ?? 1 : 1
    total += balance * rate
    totalAvailable += available * rate
    return {
      walletId: w.id,
      walletName: w.name,
      currency: w.currency,
      originalCurrency: w.currency,
      originalBalance: balance,
      originalAvailableBalance: available,
      convertedBalance: Math.round(balance * rate * 100) / 100,
      convertedAvailableBalance: Math.round(available * rate * 100) / 100,
      exchangeRate: Math.round(rate * 1e8) / 1e8,
      // legacy mock parity keys
      id: w.id,
      name: w.name,
      balance,
      availableBalance: available,
    }
  })

  return {
    totalBalance: Math.round(total * 100) / 100,
    totalAvailableBalance: Math.round(totalAvailable * 100) / 100,
    baseCurrency: base,
    walletBreakdown: rawBreakdown.map((r) => {
      const totalRounded = Math.round(total * 100) / 100
      return {
        ...r,
        weight:
          totalRounded > 0 ? Math.round((r.convertedBalance / totalRounded) * 1e4) / 100 : 0,
      }
    }),
  }
}
