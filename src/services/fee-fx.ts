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
  | {
      ok: true
      fields: FeeFxFields
      /** the fee in its own currency — the native cash leg */
      feesSettled: number
      /** fee revalued to the portfolio base currency */
      feeInBase: number
      /** fee revalued to the transaction currency, for position math */
      feeInTransaction: number
    }
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
 * consumes that native leg directly.
 *
 * The manual fee rate is the fee currency's rate to the portfolio **base**
 * currency — the sheet's col 32 "Kurs waluty opłaty" — not fee → transaction
 * currency. Production proves it: workbook row 233 books a 1.25 USD commission
 * on a EUR SAP.DE sale at 4.44, the PLN/USD quote of 2022-06-20, while the trade
 * rate on the same row is 4.67 (EUR → PLN). Treating 4.44 as USD per EUR debits
 * the position 5.55 EUR instead of 1.1884 EUR.
 *
 * So the fee's base value is `amount × feeToBaseRate`, and its value in the
 * transaction currency is that divided by the trade's own base rate. A fee
 * already in the base currency is the same rule with rate 1, which is why
 * sheets-sync's identity fee rate must not be chained through the trade rate
 * (#48). Percentage fees have no independent denomination under D28 and are
 * materialized in the transaction currency by the importer.
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

  let feeToBaseRate: number
  if (feeCurrency === baseCurrency) {
    // The stored manual rate for a base-currency fee is the identity 1; the
    // base value is the amount itself (#48).
    feeToBaseRate = 1
  } else if (input.feeRateSource === "manual") {
    if (!isValidRate(input.feeExchangeRate)) {
      return { ok: false, message: "feeExchangeRate must be a positive number when feeRateSource is manual" }
    }
    feeToBaseRate = input.feeExchangeRate
  } else {
    // Preserve the transaction-date automatic lookup used by fee settlement.
    feeToBaseRate = (await resolvedFxRate(authToken, feeCurrency, baseCurrency, input.date))?.rate ?? 1
  }

  const feeInBase = settleFee(amount, feeCurrency, baseCurrency, {}, feeToBaseRate)
  if (feeInBase == null) {
    return { ok: false, message: `could not convert ${feeCurrency} fee to ${baseCurrency}` }
  }

  return {
    ok: true,
    feeInTransactionCurrency: round8(feeInBase / transactionToBaseRate),
    convertedFees: round2(feeInBase),
  }
}

/**
 * Resolve + validate fee/FX fields of a movement request (fees-and-custom-fx
 * D28/D29/D32).
 *
 * - `rateSource=manual` requires a positive finite `exchangeRate` (tx ccy ->
 *   wallet base ccy); `automatic` resolves from instruments' fx_rates (plan
 *   §48.3 — the FX data moved to the instruments module).
 * - `pct` fees are materialized against `notional` on the fly and, having no
 *   independent denomination (D28), take the transaction currency as their fee
 *   currency.
 * - `feesSettled` is the fee **in its own currency** — the native cash leg the
 *   ledger replays. `feeExchangeRate` is the fee currency's rate to the
 *   portfolio base currency, the same axis the importer writes (sheet col 32
 *   "Kurs waluty opłaty"); it is not fee → transaction currency.
 * - `feeInBase` and `feeInTransaction` are the two derived denominations the
 *   position math and the base-currency display need.
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
  const upperWallet = walletCcy.toUpperCase()
  // #116 — conversion target is the owning portfolio base currency (the display
  // currency), not a hardcoded USD. `walletCcy` stays the transaction currency so
  // the transaction leg is unchanged; only the fee denominations move to it.
  const displayCcy = (opts.displayCcy ?? "USD").toUpperCase()
  let feeCurrency = String(body.fee_currency ?? body.feeCurrency ?? upperWallet).toUpperCase()

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

  // fee materialization
  const rawFees = num(body.fees) ?? 0
  const effectiveFee =
    feesType === "pct" ? ((opts.notional ?? 0) * rawFees) / 100 : rawFees > 0 ? rawFees : 0

  // D28: a percentage is a share of the notional, so it is denominated in the
  // transaction currency. The import path does the same (import.ts).
  if (feesType === "pct") feeCurrency = upperWallet

  // fee -> base rate. It is not stored when no independent rate is needed:
  // a fee already in the base currency is its own base value, and a fee in the
  // transaction currency rides the trade's own rate.
  let feeExchangeRate: number | null = null
  let feeInBase = 0
  if (effectiveFee > 0) {
    if (feeCurrency === displayCcy) {
      feeInBase = round8(effectiveFee)
    } else if (feeCurrency === upperWallet) {
      feeInBase = round8(effectiveFee * exchangeRate)
    } else {
      if (feeRateSource === "manual") {
        const fr = num(body.feeExchangeRate)
        if (!isValidRate(fr)) return { ok: false, message: "feeExchangeRate must be a positive number when feeRateSource is 'manual'" }
        feeExchangeRate = fr
      } else {
        feeExchangeRate = (await resolvedFxRate(authToken, feeCurrency, displayCcy))?.rate ?? 1
      }
      feeInBase = round8(settleFee(effectiveFee, feeCurrency, displayCcy, {}, feeExchangeRate) ?? 0)
    }
  }
  const feeInTransaction =
    effectiveFee === 0 ? 0 : feeCurrency === upperWallet ? effectiveFee : round8(feeInBase / exchangeRate)

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
    feesSettled: effectiveFee,
    feeInBase,
    feeInTransaction,
  }
}
