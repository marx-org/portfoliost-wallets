import { isValidRate, settleFee } from "@marx-org/contracts/fx"
import { resolvedFxRate } from "./instruments-fx.js"

const round2 = (n: number) => Math.round(n * 100) / 100
const round8 = (n: number) => Math.round(n * 1e8) / 1e8

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

export type TransactionFeeConversion =
  | { ok: true; feeInTransactionCurrency: number; convertedFees: number }
  | { ok: false; message: string }

/**
 * Convert an imported fee for the two outputs that are denominated differently
 * from the stored fee leg: position cost / realised P&L (transaction currency)
 * and `convertedFees` (portfolio base currency).
 *
 * `feesSettled` remains untouched and is persisted in `feeCurrency`; cash replay
 * consumes that native leg directly. D29's manual fee rate is fee-currency →
 * transaction-currency. A fee already in the portfolio base currency is a
 * special case: its base value is the original amount, so derive its
 * transaction-currency equivalent by dividing by the principal rate. This also
 * avoids multiplying a PLN fee by sheets-sync's identity fee rate of 1.
 * Percentage fees have no independent currency under D28 and are materialized
 * in the transaction currency by the importer.
 */
export async function convertTransactionFee(
  authToken: string | null,
  input: {
    amount: number
    feesType?: string | null
    feeCurrency: string
    feeRateSource?: string | null
    feeExchangeRate?: number | null
    transactionCurrency: string
    baseCurrency: string
    transactionToBaseRate: number
    date: string
  },
): Promise<TransactionFeeConversion> {
  const amount = Math.abs(Number(input.amount) || 0)
  const transactionCurrency = input.transactionCurrency.toUpperCase()
  const baseCurrency = input.baseCurrency.toUpperCase()
  const feeCurrency = input.feeCurrency.toUpperCase()
  const transactionToBaseRate = input.transactionToBaseRate

  if (!isValidRate(transactionToBaseRate)) {
    return { ok: false, message: "transactionToBaseRate must be a positive number" }
  }
  if (amount === 0) {
    return { ok: true, feeInTransactionCurrency: 0, convertedFees: 0 }
  }

  // D28: pct fees have no independent denomination; settleImportFees has
  // materialized this amount from the transaction notional in transaction ccy.
  if (input.feesType === "pct" || feeCurrency === transactionCurrency) {
    const feeInTransactionCurrency = amount
    return {
      ok: true,
      feeInTransactionCurrency,
      convertedFees: round2(feeInTransactionCurrency * transactionToBaseRate),
    }
  }

  if (feeCurrency === baseCurrency) {
    return {
      ok: true,
      feeInTransactionCurrency: round8(amount / transactionToBaseRate),
      convertedFees: round2(amount),
    }
  }

  let feeToTransactionRate: number
  if (input.feeRateSource === "manual") {
    if (!isValidRate(input.feeExchangeRate)) {
      return { ok: false, message: "feeExchangeRate must be a positive number when feeRateSource is manual" }
    }
    feeToTransactionRate = input.feeExchangeRate
  } else {
    // Preserve the transaction-date automatic lookup used by fee settlement.
    feeToTransactionRate =
      (await resolvedFxRate(authToken, feeCurrency, transactionCurrency, input.date))?.rate ?? 1
  }

  const feeInTransactionCurrency = settleFee(
    amount,
    feeCurrency,
    transactionCurrency,
    {},
    feeToTransactionRate,
  )
  if (feeInTransactionCurrency == null) {
    return { ok: false, message: `could not convert ${feeCurrency} fee to ${transactionCurrency}` }
  }

  return {
    ok: true,
    feeInTransactionCurrency: round8(feeInTransactionCurrency),
    convertedFees: round2(feeInTransactionCurrency * transactionToBaseRate),
  }
}

/**
 * Resolve + validate fee/FX fields of a movement request (fees-and-custom-fx
 * D28/D29/D32), computing the settled fee in the WALLET currency.
 *
 * - `rateSource=manual` requires a positive finite `exchangeRate` (tx ccy ->
 *   wallet base ccy); `automatic` resolves from instruments' fx_rates (plan
 *   §48.3 — the FX data moved to the instruments module).
 * - `pct` fees are materialized against `notional` on the fly.
 * - foreign `feeCurrency` settles via `settleFee` (manual fee rate wins).
 */
export async function resolveFeeFx(
  authToken: string | null,
  body: Record<string, unknown>,
  walletCcy: string,
  opts: { notional: number; toWalletCcy?: string | null; displayCcy?: string } = { notional: 0 },
): Promise<FeeFxResult> {
  const num = (v: unknown) => (typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : undefined)

  const rateSource = body.rateSource === "manual" ? "manual" : "automatic"
  const feeRateSource = body.feeRateSource === "manual" ? "manual" : "automatic"
  const feesType: "fixed" | "pct" = body.fees_type === "pct" || body.feesType === "pct" ? "pct" : "fixed"
  const feeCurrency = String(body.fee_currency ?? body.feeCurrency ?? walletCcy).toUpperCase()
  const upperWallet = walletCcy.toUpperCase()
  // #116 — conversion target is the owning portfolio base currency (the display
  // currency), not a hardcoded USD. `walletCcy` stays the transaction currency so
  // fee settlement is unchanged; only the rate used for the converted* fields
  // moves to the display currency.
  const displayCcy = (opts.displayCcy ?? "USD").toUpperCase()

  // main rate (tx ccy -> display/base currency)
  let exchangeRate: number
  if (rateSource === "manual") {
    const r = num(body.exchangeRate)
    if (!isValidRate(r)) return { ok: false, message: "exchangeRate must be a positive number when rateSource is 'manual'" }
    exchangeRate = r
  } else if (upperWallet === displayCcy) {
    exchangeRate = 1
  } else {
    // plan §48.3 / D20-D25 degrade path: when the pair cannot be resolved
    // (instruments down, no imported rate) we value 1:1 rather than block
    // cash movements; the next daily import fixes snapshots going forward.
    exchangeRate = (await resolvedFxRate(authToken, upperWallet, displayCcy))?.rate ?? 1
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
      feeExchangeRate = (await resolvedFxRate(authToken, feeCurrency, upperWallet))?.rate ?? 1
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
      transferFxRate = (await resolvedFxRate(authToken, upperWallet, toUpper))?.rate ?? 1
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
