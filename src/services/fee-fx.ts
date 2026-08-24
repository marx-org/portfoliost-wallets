import { desc, eq, inArray } from "drizzle-orm"
import { convert, crossRate, isValidRate, settleFee } from "@marx2/contracts/fx"
import type { DB } from "../db/index.js"
import { fxRates } from "../db/schema.js"

export interface FeeFxFields {
  feeCurrency: string
  feesType: "fixed" | "pct"
  rateSource: "automatic" | "manual"
  exchangeRate: number
  feeRateSource: "automatic" | "manual"
  feeExchangeRate: number | null
  transferFxRate: number | null
  targetAmount: number | null
}

export type FeeFxResult =
  | { ok: true; fields: FeeFxFields; feesSettled: number }
  | { ok: false; message: string }

/**
 * Latest available EUR-based table (D20): carry-forward across non-business
 * days is implicit — we simply take the most recent date that has rows.
 */
export async function latestRates(db: DB): Promise<Record<string, number> | null> {
  const [latest] = await db
    .select({ rateDate: fxRates.rateDate })
    .from(fxRates)
    .orderBy(desc(fxRates.rateDate))
    .limit(1)
  if (!latest) return null
  const rows = await db.select().from(fxRates).where(eq(fxRates.rateDate, latest.rateDate))
  const table: Record<string, number> = {}
  for (const r of rows) table[r.currency] = Number(r.rate)
  return table
}

/**
 * Resolve + validate fee/FX fields of a movement request (fees-and-custom-fx
 * D28/D29/D32), computing the settled fee in the WALLET currency.
 *
 * - `rateSource=manual` requires a positive finite `exchangeRate` (tx ccy ->
 *   wallet base ccy); `automatic` resolves from fx_rates.
 * - `pct` fees are materialized against `notional` on the fly.
 * - foreign `feeCurrency` settles via `settleFee` (manual fee rate wins).
 */
export async function resolveFeeFx(
  db: DB,
  body: Record<string, unknown>,
  walletCcy: string,
  opts: { notional: number; toWalletCcy?: string | null } = { notional: 0 },
): Promise<FeeFxResult> {
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : undefined)

  const rateSource = body.rateSource === "manual" ? "manual" : "automatic"
  const feeRateSource = body.feeRateSource === "manual" ? "manual" : "automatic"
  const feesType: "fixed" | "pct" = body.fees_type === "pct" || body.feesType === "pct" ? "pct" : "fixed"
  const feeCurrency = String(body.fee_currency ?? body.feeCurrency ?? walletCcy).toUpperCase()
  const upperWallet = walletCcy.toUpperCase()

  // main rate snapshot (tx ccy -> wallet base currency)
  let exchangeRate: number
  if (rateSource === "manual") {
    const r = num(body.exchangeRate)
    if (!isValidRate(r)) return { ok: false, message: "exchangeRate must be a positive number when rateSource is 'manual'" }
    exchangeRate = r
  } else if (upperWallet === "USD") {
    exchangeRate = 1
  } else if (upperWallet === "USD") {
    exchangeRate = 1
  } else {
    // D20/D25 degrade path: without imported rates we value 1:1 rather than
    // block cash movements; the next daily import fixes snapshots going forward
    const table = await latestRates(db)
    exchangeRate = table ? convert(1, upperWallet, "USD", table) ?? 1 : 1
  }

  // fee materialization + settlement
  const rawFees = num(body.fees) ?? 0
  const effectiveFee =
    feesType === "pct" ? ((opts.notional ?? 0) * rawFees) / 100 : rawFees > 0 ? rawFees : 0

  let feeExchangeRate: number | null = null
  if (effectiveFee > 0 && feeCurrency !== upperWallet) {
    if (feeRateSource === "manual") {
      const fr = num(body.feeExchangeRate)
      if (!isValidRate(fr)) return { ok: false, message: "feeExchangeRate must be a positive number when feeRateSource is 'manual'" }
      feeExchangeRate = fr
    } else {
      const table = await latestRates(db)
      feeExchangeRate = table ? crossRate(feeCurrency, upperWallet, table) ?? 1 : 1
    }
  }

  const feesSettled =
    effectiveFee === 0
      ? 0
      : Math.round(
          (settleFee(effectiveFee, feeCurrency, upperWallet, {}, feeExchangeRate ?? undefined) ?? 0) * 1e8,
        ) / 1e8

  // elastic transfer target leg (wallets D22)
  let transferFxRate: number | null = null
  let targetAmount: number | null = null
  if (opts.toWalletCcy) {
    const toUpper = opts.toWalletCcy.toUpperCase()
    if (body.targetAmount != null) {
      const t = num(body.targetAmount)
      if (t == null || !Number.isFinite(t) || t <= 0) {
        return { ok: false, message: "targetAmount must be a positive number" }
      }
      targetAmount = t
    }
    if (body.targetFxRate != null) {
      const r = num(body.targetFxRate)
      if (!isValidRate(r)) return { ok: false, message: "targetFxRate must be a positive number" }
      transferFxRate = r
    } else if (toUpper !== upperWallet) {
      const table = await latestRates(db)
      transferFxRate = table ? crossRate(upperWallet, toUpper, table) ?? 1 : 1
    } else {
      transferFxRate = 1
    }
    if (targetAmount == null && transferFxRate != null) {
      targetAmount = null // resolved at insert time from the debited amount
    }
  }

  return {
    ok: true,
    fields: {
      feeCurrency,
      feesType,
      rateSource,
      exchangeRate,
      feeRateSource,
      feeExchangeRate,
      transferFxRate,
      targetAmount,
    },
    feesSettled,
  }
}

/** Batch variant used by recent-transactions joins (kept for §11.6). */
export async function ratesForDates(db: DB, dates: string[]): Promise<Map<string, Record<string, number>>> {
  const map = new Map<string, Record<string, number>>()
  if (!dates.length) return map
  const rows = await db.select().from(fxRates).where(inArray(fxRates.rateDate, dates))
  for (const r of rows) {
    const t = map.get(r.rateDate) ?? {}
    t[r.currency] = Number(r.rate)
    map.set(r.rateDate, t)
  }
  return map
}
