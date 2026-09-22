import { eq } from "drizzle-orm"
import type { DB } from "../db/index.js"
import { wallets } from "../db/schema.js"
import { fxTo, resolvedFxRate } from "./instruments-fx.js"

export interface ValuedWallet {
  id: string
  name: string
  currency: string
  baseCurrency: string
  balance: number
  availableBalance: number
}

/** Snapshot semantics (D21): manual wins verbatim; auto resolves from
 * instruments' fx_rates (plan §48.3). */
export async function snapshotRate(
  authToken: string | null,
  fromCcy: string,
  toCcy: string,
  manual?: number,
): Promise<{ rate: number; source: "automatic" | "manual" }> {
  if (fromCcy === toCcy) return { rate: 1, source: manual != null ? "manual" : "automatic" }
  if (manual != null && Number.isFinite(manual) && manual > 0) return { rate: manual, source: "manual" }
  const rate = (await resolvedFxRate(authToken, fromCcy, toCcy))?.rate
  return { rate: rate ?? 1, source: "automatic" }
}

/** Total-balance aggregation (D21b/D26): every wallet valued in ITS OWN
 * base_currency... aggregated per user preference upstream. Here: value all
 * wallets in the REQUESTED base currency (default USD) at latest rates. */
export async function totalBalance(db: DB, authToken: string | null, userId: string, baseCurrency = "USD") {
  const rows = await db.select().from(wallets).where(eq(wallets.userId, userId))
  const base = baseCurrency.toUpperCase()
  // plan §48.3 — pair rates resolved via instruments, memoized per currency.
  const toBase = await fxTo(authToken, base)

  let total = 0
  let totalAvailable = 0
  const breakdown = []
  for (const w of rows) {
    const balance = Number(w.balance)
    const available = Number(w.availableBalance)
    const rate = await toBase(w.currency, 1)
    total += balance * rate
    totalAvailable += available * rate
    breakdown.push({
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
    })
  }

  return {
    totalBalance: Math.round(total * 100) / 100,
    totalAvailableBalance: Math.round(totalAvailable * 100) / 100,
    baseCurrency: base,
    walletBreakdown: breakdown.map((r) => {
      const totalRounded = Math.round(total * 100) / 100
      return {
        ...r,
        weight:
          totalRounded > 0 ? Math.round((r.convertedBalance / totalRounded) * 1e4) / 100 : 0,
      }
    }),
  }
}
