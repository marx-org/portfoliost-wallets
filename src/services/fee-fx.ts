import { isValidRate, settleFee } from "@marx-org/contracts/fx"
import { resolvedFxRate } from "./instruments-fx.js"

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
