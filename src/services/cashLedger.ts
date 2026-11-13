/**
 * Plan §62 — portfolio-native cash ledger, derived by replay.
 *
 * A portfolio owns its cash as a ledger; nothing is stored. The ledger is
 * denominated in one of two ways:
 *   • `cashCurrency` set (or `cashBaseCurrencyOnly: true`) — a single balance
 *     in that currency, every effect converted at its own event date;
 *   • neither — one balance per currency, each in its own units.
 *
 * The per-currency effects come from:
 *   (a) portfolio trade rows — BUY −(notional+fees), SELL +(notional−fees),
 *       DIVIDEND +net (the §49 convention: totalAmount is net of tax) −
 *       fees; principal leg in `tx.currency`, fee leg in
 *       `tx.feeCurrency ?? tx.currency`; and
 *   (b) external rows (portfolio_cash_transactions: DEPOSIT +, WITHDRAWAL −,
 *       TRANSFER as sent — the stored amount is already the row's signed
 *       own-currency effect). INTEREST and FEE are the row's signed amount in
 *       its own currency. FX_CONVERSION is two legs: `amount` in `currency` for
 *       the leg handed over and `toAmount` in `toCurrency` for the leg received.
 *       When `toCurrency` is absent or equals `currency` the row is not an
 *       exchange but a correction of one balance, and both legs land in that
 *       currency.
 *
 * Splits/ADJUSTMENT have no cash effect. Negative balances are allowed
 * (replay fidelity — real ledgers dip negative before a deposit lands).
 *
 * **Why the settlement currency is not the display base.** A single-currency
 * broker account settles every leg into one currency and books the conversion
 * itself (IBKR's Cash Report carries `CurrencyPrimary = USD` on every row and a
 * "Net Amount in Base from Forex Trade" line for each foreign leg). Booking
 * the leg in the instrument's trading currency instead manufactures balances
 * in currencies the account never held — measured on the live IBKR portfolio
 * 2026-11-11: seven such balances, and a cash figure 7 035.81 PLN above the
 * broker's own −165.049018 USD.
 */
import { and, eq, inArray, sql } from "drizzle-orm"
import type { DB } from "../db/index.js"
import { portfolioCashTransactions, portfolioTransactions, portfolios } from "../db/schema.js"
import { TRADE_CASH_TYPES as CASH_EFFECTING_TX_TYPES, EXTERNAL_CASH_TX_TYPES, isConversionType } from "../transaction-types.js"
import { FxRateUnavailableError, fxToOnDay, resolvedFxRate } from "./instruments-fx.js"
import { debugEnabled, debugLog, fmtCcyMap, fmtCcyRateMap } from "./debug.js"

// BUY/SELL/DIVIDEND only. An in-kind transfer moves an instrument, not money, and
// must never reach tradeCashEffects — which credits anything that is not a BUY.
const TRADE_CASH_TYPES = CASH_EFFECTING_TX_TYPES

/**
 * Normalise a value that may be a Date, ISO string, or timestamptz string to
 * YYYY-MM-DD (local-day of the UTC instant).
 */
export function toDateStr(v: unknown): string | null {
  if (!v) return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  const s = String(v)
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const d = new Date(s)
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

/**
 * Signed per-currency cash effects of one portfolio trade row.
 *
 *   principal leg (tx.currency):      BUY −|totalAmount|, SELL +|totalAmount|,
 *                                     DIVIDEND +|totalAmount| (net, §49)
 *   fee leg (feeCurrency ?? currency): −|fee| for every type (a fee is always
 *       a cost the account pays)
 *
 * `feesSettled` is already materialized in the fee currency at write time
 * (D28/D29 `pct` → |notional| resolution), so replay uses it directly. A BUY
 * thus draws |notional| + |fee| from the account — matching the old wallet
 * debit — so a position funded by an equal deposit nets its currency to 0.
 * Non-trade types (SPLIT/ADJUSTMENT markers) → empty map.
 */
export function tradeCashEffects(tx: {
  type: string
  totalAmount: string | number | null
  feesSettled: string | number | null
  currency: string | null
  feeCurrency?: string | null
}): Map<string, number> {
  const out = new Map<string, number>()
  const notional = Number(tx.totalAmount ?? 0)
  const fee = Number(tx.feesSettled ?? 0)
  const principalSign = tx.type === "BUY" ? -1 : 1 // SELL / DIVIDEND credit
  if (notional !== 0 && tx.currency) {
    out.set(tx.currency.toUpperCase(), (out.get(tx.currency.toUpperCase()) ?? 0) + principalSign * Math.abs(notional))
  }
  if (fee !== 0) {
    const feeCcy = (tx.feeCurrency ?? tx.currency ?? "").toUpperCase()
    if (feeCcy) out.set(feeCcy, (out.get(feeCcy) ?? 0) - Math.abs(fee))
  }
  return out
}

/**
 * Signed per-currency legs of one `portfolio_cash_transactions` row.
 *
 * Everything except FX_CONVERSION is a single leg: the stored `amount` is already
 * the row's signed effect in its own currency. A conversion is two legs — what
 * is handed over (`amount`, signed) and what is received (`toAmount`) — and the
 * second leg is in `toCurrency`. A conversion with no second leg, or with the
 * second leg in the same currency, is a correction of one balance: the two legs
 * simply add.
 *
 * `fees` on a cash row is metadata, as it has always been: the replay reads the
 * amounts. A conversion charge is therefore netted into `toAmount` by whoever
 * writes the row, exactly as a bank wire charge is netted into a deposit's amount.
 * Splitting it out would double-count it the moment the row is also the only
 * record of the event.
 */
export function cashRowLegs(row: {
  type: string
  amount: string | number | null
  currency: string | null
  toCurrency?: string | null
  toAmount?: string | number | null
}): Map<string, number> {
  const out = new Map<string, number>()
  const add = (ccy: string, value: number) => {
    if (!ccy || value === 0) return
    out.set(ccy, (out.get(ccy) ?? 0) + value)
  }
  const from = (row.currency ?? "").toUpperCase()
  add(from, Number(row.amount ?? 0))
  if (isConversionType(row.type)) {
    const to = (row.toCurrency ?? row.currency ?? "").toUpperCase()
    add(to, Number(row.toAmount ?? 0))
  }
  return out
}

/**
 * Canonical form of a conversion row before it is written.
 *
 * `ck_pctx_amount_nonzero` forbids a zero `amount`, so the two degenerate shapes
 * have to be collapsed rather than stored:
 *   - both legs the same currency — not an exchange at all, one balance moved by
 *     the sum of the legs (IBKR's "Net Amount in Base from Forex Trade");
 *   - nothing handed over — a one-sided credit, which belongs in the currency
 *     that actually receives money.
 * Returns null when the row would change nothing at all.
 */
export function normalizeConversionLegs(row: {
  currency: string | null
  amount: string | number | null
  toCurrency?: string | null
  toAmount?: string | number | null
}): { currency: string; amount: number; toCurrency: string | null; toAmount: number | null } | null {
  const from = (row.currency ?? "").toUpperCase()
  const to = (row.toCurrency ?? row.currency ?? "").toUpperCase()
  const handed = Number(row.amount ?? 0)
  const received = Math.abs(Number(row.toAmount ?? 0))
  if (!from || !to) return null
  if (from === to) {
    const net = handed + received
    return net === 0 ? null : { currency: from, amount: net, toCurrency: to, toAmount: null }
  }
  if (handed === 0) return received === 0 ? null : { currency: to, amount: received, toCurrency: null, toAmount: null }
  return { currency: from, amount: handed, toCurrency: to, toAmount: received }
}

async function cashPolicy(db: DB, portfolioId: string) {
  const [portfolio] = await db
    .select({
      baseCurrency: portfolios.baseCurrency,
      cashBaseCurrencyOnly: portfolios.cashBaseCurrencyOnly,
      cashCurrency: portfolios.cashCurrency,
    })
    .from(portfolios)
    .where(eq(portfolios.id, portfolioId))
  return portfolio
}

/**
 * The single currency a portfolio's cash ledger is denominated in, or `null`
 * when the ledger is genuinely multi-currency.
 *
 * `cashCurrency` is the settlement currency of the account — the currency the
 * broker actually holds money in — and it is deliberately not the portfolio's
 * display base. `cashBaseCurrencyOnly: true` is exactly `cashCurrency =
 * baseCurrency`, so a portfolio that only ever sets the flag behaves the same
 * as before.
 */
export function ledgerCurrency(
  policy: { baseCurrency?: string | null; cashBaseCurrencyOnly?: boolean; cashCurrency?: string | null } | null,
): string | null {
  if (!policy) return null
  const explicit = (policy.cashCurrency ?? "").trim().toUpperCase()
  if (explicit) return explicit
  if (policy.cashBaseCurrencyOnly === true) {
    const base = (policy.baseCurrency ?? "").trim().toUpperCase()
    return base || null
  }
  return null
}

/**
 * How a portfolio's cash balances are shaped.
 *
 * - `single` — one balance, every leg converted into it (the old settlement
 *   model; `cashBaseCurrencyOnly: true`, or a settlement with no display base).
 * - `settlement+base` — the account holds the settlement currency **and** the
 *   display base: every non-base leg converts into the settlement at its event
 *   date, while base-currency legs stay native. This is IBKR's real shape
 *   (USD settlement, PLN also held), selected by `cashBaseCurrencyOnly: false`
 *   with a `cashCurrency` set.
 * - `native` — one balance per currency, no conversion.
 *
 * `cashBaseCurrencyOnly` is the switch the owner named: when it is false the base
 * is not the only available cash, so a settlement currency no longer collapses
 * the ledger to one balance. `ledgerCurrency()` still returns the settlement for
 * the cash-entry/conversion rules; it is not the balance shape.
 */
export type LedgerMode =
  | { kind: "single"; currency: string }
  | { kind: "settlement+base"; settlement: string; base: string }
  | { kind: "native" }

export function ledgerMode(
  policy: { baseCurrency?: string | null; cashBaseCurrencyOnly?: boolean; cashCurrency?: string | null } | null,
): LedgerMode {
  if (!policy) return { kind: "native" }
  const base = (policy.baseCurrency ?? "").trim().toUpperCase()
  const settlement = (policy.cashCurrency ?? "").trim().toUpperCase()
  if (policy.cashBaseCurrencyOnly === true) {
    const single = settlement || base
    return single ? { kind: "single", currency: single } : { kind: "native" }
  }
  if (settlement) {
    return base && base !== settlement
      ? { kind: "settlement+base", settlement, base }
      : { kind: "single", currency: settlement }
  }
  return { kind: "native" }
}

async function eventRateTo(
  authToken: string | null,
  from: string,
  to: string,
  day: string,
  cache: Map<string, number>,
): Promise<number> {
  const key = `${from}>${to}@${day}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  // A single-currency replay must not turn a missing historical quote into a
  // fabricated 1:1 balance. rateToBase throws when either the FX service or the
  // requested dated pair is unavailable.
  const rate = await rateToBase(authToken, from, to, day, { strict: true })
  cache.set(key, rate)
  return rate
}

function manualRate(value: string | number | null | undefined, field: string): number {
  const rate = value == null || value === "" ? Number.NaN : Number(value)
  if (!Number.isFinite(rate) || rate <= 0) {
    throw new Error(`cash replay has ${field}=manual but no positive stored rate`)
  }
  return rate
}

/**
 * Rate for one cash leg into the ledger currency.
 *
 * A stored manual rate is the sheet's own currency -> baseCurrency quote. It is
 * usable directly only when the ledger is denominated in that base; against a
 * different settlement currency the event-date pair is used instead, because
 * chaining the sheet's 2-dp rate through base would compound two independent
 * quotes into one number nobody chose.
 */
async function cashLegRateTo(
  authToken: string | null,
  currency: string,
  target: string,
  baseCurrency: string,
  day: string,
  source: string | null | undefined,
  storedRate: string | number | null | undefined,
  cache: Map<string, number>,
  field: string,
): Promise<number> {
  const from = currency.toUpperCase()
  const to = target.toUpperCase()
  if (from === to) return 1
  if (to === baseCurrency.toUpperCase() && source === "manual") return manualRate(storedRate, field)
  return eventRateTo(authToken, from, to, day, cache)
}

/**
 * Convert one trade's cash effects into the ledger currency.
 *
 * D29's trade rate is trade-currency -> baseCurrency; its manual fee rate is
 * fee-currency -> baseCurrency. Automatic foreign-currency fees keep the
 * ledger's event-date fee-currency -> ledger lookup.
 *
 * A fee already in the ledger currency needs no conversion at all: sheets-sync
 * writes `feeCurrency = <base>`, `feeExchangeRate = 1`, `feeRateSource = manual`
 * for every fee the sheet records in PLN, and feeding that identity rate through
 * the fee -> trade -> ledger chain would debit a 19 PLN commission on a GBP trade
 * as 19 GBP (#48). Against a settlement currency that is not the base (IBKR:
 * USD, base PLN) the same fee converts once, PLN -> USD, at the event date.
 */
async function tradeCashDeltaInCurrency(
  authToken: string | null,
  tx: {
    type: string
    totalAmount: string | number | null
    feesSettled: string | number | null
    currency: string | null
    feeCurrency?: string | null
    exchangeRate?: string | number | null
    rateSource?: string | null
    feeExchangeRate?: string | number | null
    feeRateSource?: string | null
  },
  ledger: string,
  baseCurrency: string,
  day: string,
  cache: Map<string, number>,
): Promise<number> {
  const base = baseCurrency.toUpperCase()
  const tradeCurrency = (tx.currency ?? "").toUpperCase()
  const feeCurrency = (tx.feeCurrency ?? tx.currency ?? "").toUpperCase()
  const notional = Number(tx.totalAmount ?? 0)
  const fee = Number(tx.feesSettled ?? 0)
  const principalSign = tx.type === "BUY" ? -1 : 1
  let tradeToLedger: number | undefined
  const getTradeToLedger = async () => {
    if (tradeToLedger === undefined) {
      tradeToLedger = await cashLegRateTo(
        authToken,
        tradeCurrency,
        ledger,
        base,
        day,
        tx.rateSource,
        tx.exchangeRate,
        cache,
        "exchangeRate",
      )
    }
    return tradeToLedger
  }
  let baseToLedger: number | undefined
  const getBaseToLedger = async () => {
    if (baseToLedger === undefined) {
      baseToLedger = await eventRateTo(authToken, base, ledger, day, cache)
    }
    return baseToLedger
  }

  let delta = 0
  if (notional !== 0 && tradeCurrency) {
    delta += principalSign * Math.abs(notional) * (await getTradeToLedger())
  }

  if (fee !== 0 && feeCurrency) {
    let feeToLedger: number
    if (feeCurrency === ledger) {
      feeToLedger = 1
    } else if (feeCurrency === tradeCurrency) {
      // Same-currency fees need no fee FX; convert them once with the principal
      // leg's trade-currency rate (manual or event-date automatic).
      feeToLedger = await getTradeToLedger()
    } else if (feeCurrency === base) {
      // #48 - the fee is already in the portfolio's base currency, so its stored
      // manual rate is the identity. Chaining it through the trade rate would
      // multiply a PLN commission by the foreign trade rate.
      feeToLedger = await getBaseToLedger()
    } else if (tx.feeRateSource === "manual") {
      const feeToBase = manualRate(tx.feeExchangeRate, "feeExchangeRate")
      feeToLedger = feeToBase * (await getBaseToLedger())
    } else {
      feeToLedger = await cashLegRateTo(
        authToken,
        feeCurrency,
        ledger,
        base,
        day,
        "automatic",
        null,
        cache,
        "feeExchangeRate",
      )
    }
    delta -= Math.abs(fee) * feeToLedger
  }
  return delta
}

/**
 * External cash-row exchangeRate is stored directly as row-currency -> base.
 * Against a different settlement currency the row converts through the
 * event-date pair instead.
 *
 * An FX_CONVERSION's second leg is quoted in a different currency, so the row's
 * stored manual rate cannot apply to it: that rate is the sheet's own-currency
 * quote, and chaining it into a second currency would compound two quotes into
 * one number nobody chose. The second leg is therefore always resolved at the
 * event date.
 */
async function cashRowDeltaInCurrency(
  authToken: string | null,
  row: {
    type: string
    amount: string | number | null
    currency: string | null
    toCurrency?: string | null
    toAmount?: string | number | null
    exchangeRate?: string | number | null
    rateSource?: string | null
  },
  ledger: string,
  baseCurrency: string,
  day: string,
  cache: Map<string, number>,
): Promise<number> {
  const legs = cashRowLegs(row)
  if (legs.size === 0) return 0
  const rowCcy = (row.currency ?? "").toUpperCase()
  let delta = 0
  for (const [ccy, amount] of legs) {
    const own = ccy === rowCcy
    delta += amount * (
      await cashLegRateTo(
        authToken,
        ccy,
        ledger,
        baseCurrency,
        day,
        own ? row.rateSource : "automatic",
        own ? row.exchangeRate : null,
        cache,
        own ? "exchangeRate" : "toCurrency",
      )
    )
  }
  return delta
}

/**
 * The settlement-currency value of a trade/row whose total was converted into
 * the settlement, with the base-currency leg(s) removed. `total` includes the
 * base leg converted at the event-date base→settlement rate; the base balance
 * must carry the native amount instead, so subtract its settlement value.
 */
async function settlementExBase(
  authToken: string | null,
  total: number,
  baseDelta: number,
  base: string,
  settlement: string,
  day: string,
  cache: Map<string, number>,
): Promise<number> {
  if (baseDelta === 0 || base === settlement) return total
  const rate = await eventRateTo(authToken, base, settlement, day, cache)
  return total - baseDelta * rate
}

/**
 * Cash balances as of `asOf` (YYYY-MM-DD; trades with `executedAt ≤ asOf
 * end-of-day`, external rows with `transaction_date ≤ asOf` — no asOf = latest).
 * A portfolio with a settlement currency returns a single balance in that
 * currency, using a stored manual rate when its source is manual and the event's
 * dated FX rate otherwise, for each trade principal, fee and external cash
 * effect. A portfolio with none returns each currency in its own units.
 */
export async function cashBalances(
  db: DB,
  authToken: string | null,
  portfolioId: string,
  asOf?: string,
): Promise<Map<string, number>> {
  const balances = new Map<string, number>()
  const policy = await cashPolicy(db, portfolioId)
  const base = policy?.baseCurrency.toUpperCase() ?? ""
  const mode = ledgerMode(policy)
  const dated = mode.kind !== "native"
  const eventRates = new Map<string, number>()
  if (mode.kind === "single") balances.set(mode.currency, 0)
  if (mode.kind === "settlement+base") {
    balances.set(mode.settlement, 0)
    if (mode.base !== mode.settlement) balances.set(mode.base, 0)
  }

  const tradeWhere = and(
    eq(portfolioTransactions.portfolioId, portfolioId),
    inArray(portfolioTransactions.type, [...TRADE_CASH_TYPES]),
    asOf ? sql`date(${portfolioTransactions.executedAt}) <= ${asOf}` : undefined,
  )
  const trades = await db
    .select({
      type: portfolioTransactions.type,
      totalAmount: portfolioTransactions.totalAmount,
      feesSettled: portfolioTransactions.feesSettled,
      currency: portfolioTransactions.currency,
      feeCurrency: portfolioTransactions.feeCurrency,
      exchangeRate: portfolioTransactions.exchangeRate,
      rateSource: portfolioTransactions.rateSource,
      feeExchangeRate: portfolioTransactions.feeExchangeRate,
      feeRateSource: portfolioTransactions.feeRateSource,
      executedAt: portfolioTransactions.executedAt,
    })
    .from(portfolioTransactions)
    .where(tradeWhere)

  for (const tx of trades) {
    const day = toDateStr(tx.executedAt)
    if (mode.kind === "single") {
      if (!day) throw new Error(`cash trade has no event date for single-currency replay`)
      const delta = await tradeCashDeltaInCurrency(authToken, tx, mode.currency, base, day, eventRates)
      balances.set(mode.currency, (balances.get(mode.currency) ?? 0) + delta)
    } else if (mode.kind === "settlement+base") {
      if (!day) throw new Error(`cash trade has no event date for settlement replay`)
      const total = await tradeCashDeltaInCurrency(authToken, tx, mode.settlement, base, day, eventRates)
      const baseDelta = tradeCashEffects(tx).get(mode.base) ?? 0
      const settlementDelta = await settlementExBase(authToken, total, baseDelta, mode.base, mode.settlement, day, eventRates)
      balances.set(mode.settlement, (balances.get(mode.settlement) ?? 0) + settlementDelta)
      if (baseDelta !== 0) balances.set(mode.base, (balances.get(mode.base) ?? 0) + baseDelta)
    } else {
      for (const [ccy, delta] of tradeCashEffects(tx)) {
        balances.set(ccy, (balances.get(ccy) ?? 0) + delta)
      }
    }
  }

  const extWhere = and(
    eq(portfolioCashTransactions.portfolioId, portfolioId),
    asOf
      ? dated
        ? sql`coalesce(${portfolioCashTransactions.transactionDate}, date(${portfolioCashTransactions.createdAt})) <= ${asOf}`
        : sql`${portfolioCashTransactions.transactionDate} <= ${asOf}`
      : undefined,
  )
  const ext = await db
    .select({
      type: portfolioCashTransactions.type,
      amount: portfolioCashTransactions.amount,
      currency: portfolioCashTransactions.currency,
      toCurrency: portfolioCashTransactions.toCurrency,
      toAmount: portfolioCashTransactions.toAmount,
      exchangeRate: portfolioCashTransactions.exchangeRate,
      rateSource: portfolioCashTransactions.rateSource,
      transactionDate: portfolioCashTransactions.transactionDate,
      createdAt: portfolioCashTransactions.createdAt,
    })
    .from(portfolioCashTransactions)
    .where(extWhere)

  for (const r of ext) {
    const day = toDateStr(r.transactionDate) ?? toDateStr(r.createdAt)
    if (mode.kind === "single") {
      if (!day) throw new Error(`cash event in ${(r.currency ?? "").toUpperCase()} has no event date for single-currency replay`)
      const delta = await cashRowDeltaInCurrency(authToken, r, mode.currency, base, day, eventRates)
      balances.set(mode.currency, (balances.get(mode.currency) ?? 0) + delta)
    } else if (mode.kind === "settlement+base") {
      if (!day) throw new Error(`cash event in ${(r.currency ?? "").toUpperCase()} has no event date for settlement replay`)
      const total = await cashRowDeltaInCurrency(authToken, r, mode.settlement, base, day, eventRates)
      const baseDelta = cashRowLegs(r).get(mode.base) ?? 0
      const settlementDelta = await settlementExBase(authToken, total, baseDelta, mode.base, mode.settlement, day, eventRates)
      balances.set(mode.settlement, (balances.get(mode.settlement) ?? 0) + settlementDelta)
      if (baseDelta !== 0) balances.set(mode.base, (balances.get(mode.base) ?? 0) + baseDelta)
    } else {
      for (const [ccy, delta] of cashRowLegs(r)) {
        balances.set(ccy, (balances.get(ccy) ?? 0) + delta)
      }
    }
  }

  // RECALC_DEBUG — the live/as-of leg of the cash replay. Pairs with
  // `cash-balance-series` below so the two can be diffed on the same day; the
  // counts make an as-of filter that silently dropped rows obvious.
  if (debugEnabled()) {
    debugLog(
      `cash-balances pf=${portfolioId} asOf=${asOf ?? "latest"} trades=${trades.length} ext=${ext.length} | ${fmtCcyMap(balances)}`,
    )
  }

  return balances
}

/** Enumerate every calendar date in [from, to] inclusive (YYYY-MM-DD). */
function enumerateDays(from: string, to: string): string[] {
  const days: string[] = []
  const start = new Date(`${from}T00:00:00Z`)
  const end = new Date(`${to}T00:00:00Z`)
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    days.push(d.toISOString().slice(0, 10))
  }
  return days
}

/**
 * Daily base-currency cash totals across [from, to]. A portfolio with no
 * settlement currency revalues each running currency balance at the day's FX
 * rate. A single-currency ledger converts each event once at its own date and
 * carries the resulting balance forward without revaluation, then revalues that
 * one balance into the display base at the day's rate — the balance is held in
 * the settlement currency, so its base-currency value does move with FX.
 * In both cases days are contiguous within the requested window.
 */
export async function cashBalanceSeries(
  db: DB,
  authToken: string | null,
  portfolioId: string,
  from: string,
  to: string,
  baseCurrency: string,
  /** §63.10 — `strict` propagates to the FX lookup so a transport/auth failure
   * aborts the historical backfill instead of valuing every foreign-currency cash
   * row 1:1. The interactive callers leave it off. */
  opts: { strict?: boolean } = {},
): Promise<Map<string, number>> {
  const policy = await cashPolicy(db, portfolioId)
  const mode = ledgerMode(policy)
  const ledger = mode.kind === "single" ? mode.currency : null
  const base = baseCurrency.toUpperCase()
  const days = enumerateDays(from, to)
  if (days.length === 0) return new Map()

  interface Event {
    day: string
    ccy: string
    delta: number
    /** Resolve FX only when this event enters the requested history window. */
    ledgerDelta?: () => Promise<number>
  }
  const events: Event[] = []
  const eventRates = new Map<string, number>()

  const trades = await db
    .select({
      type: portfolioTransactions.type,
      totalAmount: portfolioTransactions.totalAmount,
      feesSettled: portfolioTransactions.feesSettled,
      currency: portfolioTransactions.currency,
      feeCurrency: portfolioTransactions.feeCurrency,
      exchangeRate: portfolioTransactions.exchangeRate,
      rateSource: portfolioTransactions.rateSource,
      feeExchangeRate: portfolioTransactions.feeExchangeRate,
      feeRateSource: portfolioTransactions.feeRateSource,
      executedAt: portfolioTransactions.executedAt,
    })
    .from(portfolioTransactions)
    .where(and(eq(portfolioTransactions.portfolioId, portfolioId), inArray(portfolioTransactions.type, [...TRADE_CASH_TYPES])))
    .orderBy(portfolioTransactions.executedAt)

  for (const tx of trades) {
    const day = toDateStr(tx.executedAt)
    if (!day) continue
    if (mode.kind === "single") {
      events.push({
        day,
        ccy: mode.currency,
        delta: 0,
        ledgerDelta: () => tradeCashDeltaInCurrency(authToken, tx, mode.currency, base, day, eventRates),
      })
    } else if (mode.kind === "settlement+base") {
      const baseDelta = tradeCashEffects(tx).get(mode.base) ?? 0
      events.push({
        day,
        ccy: mode.settlement,
        delta: 0,
        ledgerDelta: async () => {
          const total = await tradeCashDeltaInCurrency(authToken, tx, mode.settlement, base, day, eventRates)
          return settlementExBase(authToken, total, baseDelta, mode.base, mode.settlement, day, eventRates)
        },
      })
      if (baseDelta !== 0) events.push({ day, ccy: mode.base, delta: baseDelta })
    } else {
      for (const [ccy, delta] of tradeCashEffects(tx)) events.push({ day, ccy, delta })
    }
  }

  const ext = await db
    .select({
      type: portfolioCashTransactions.type,
      amount: portfolioCashTransactions.amount,
      currency: portfolioCashTransactions.currency,
      toCurrency: portfolioCashTransactions.toCurrency,
      toAmount: portfolioCashTransactions.toAmount,
      exchangeRate: portfolioCashTransactions.exchangeRate,
      rateSource: portfolioCashTransactions.rateSource,
      transactionDate: portfolioCashTransactions.transactionDate,
      createdAt: portfolioCashTransactions.createdAt,
    })
    .from(portfolioCashTransactions)
    .where(eq(portfolioCashTransactions.portfolioId, portfolioId))
    .orderBy(portfolioCashTransactions.transactionDate)

  for (const r of ext) {
    const day = toDateStr(r.transactionDate) ?? (mode.kind !== "native" ? toDateStr(r.createdAt) : null)
    if (!day) continue
    const legs = cashRowLegs(r)
    if (legs.size === 0) continue
    if (mode.kind === "single") {
      events.push({
        day,
        ccy: mode.currency,
        delta: 0,
        ledgerDelta: () => cashRowDeltaInCurrency(authToken, r, mode.currency, base, day, eventRates),
      })
    } else if (mode.kind === "settlement+base") {
      const baseDelta = legs.get(mode.base) ?? 0
      events.push({
        day,
        ccy: mode.settlement,
        delta: 0,
        ledgerDelta: async () => {
          const total = await cashRowDeltaInCurrency(authToken, r, mode.settlement, base, day, eventRates)
          return settlementExBase(authToken, total, baseDelta, mode.base, mode.settlement, day, eventRates)
        },
      })
      if (baseDelta !== 0) events.push({ day, ccy: mode.base, delta: baseDelta })
    } else {
      for (const [ccy, delta] of legs) events.push({ day, ccy, delta })
    }
  }

  // the running-balance sweep assumes events are ordered by day
  events.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0))

  // running per-currency balances at each day's close
  const running = new Map<string, number>()
  const perDayBal = new Map<string, Map<string, number>>()
  let ei = 0
  for (const day of days) {
    while (ei < events.length && events[ei].day <= day) {
      const e = events[ei]
      // Convert once at the event's date, then carry the resulting delta forward
      // rather than applying FX again to the running balance. The day's total
      // revalues each balance into the display base below.
      const delta = e.ledgerDelta ? await e.ledgerDelta() : e.delta
      running.set(e.ccy, (running.get(e.ccy) ?? 0) + delta)
      ei += 1
    }
    perDayBal.set(day, new Map(running))
  }

  const series = new Map<string, number>()
  for (const day of days) {
    const toBase = await fxToOnDay(authToken, base, day, new Map(), opts)
    let total = 0
    const legs = new Map<string, { amount: number; rate: number }>()
    for (const [ccy, bal] of perDayBal.get(day) ?? new Map()) {
      const rate = await toBase(ccy)
      total += bal * rate
      legs.set(ccy, { amount: bal, rate })
    }
    series.set(day, total)
    // RECALC_DEBUG — the historical leg of the cash replay. The per-leg rates
    // matter: a base total with no visible FX inputs cannot be reconciled
    // against `cash-balances`, which converts at the LATEST rate instead of the
    // day's. `fx` is 1.000000 for the base currency itself.
    if (debugEnabled()) {
      debugLog(`cash-balance-series pf=${portfolioId} day=${day} base=${base} | ${fmtCcyRateMap(legs)} | total=${total.toFixed(2)}`)
    }
  }
  return series
}

/**
 * Daily net EXTERNAL flow in base currency across [from, to] (DEPOSIT +,
 * WITHDRAWAL −, TRANSFER ± its own stored leg) at that day's rate — the D50
 * replacement for the old BUY/SELL `dailyNetCashFlows` series (trades are
 * internal cash ↔ position moves, not flows).
 *
 * `portfolioId` is a filter, not an identity: §83.3 passes an ARRAY to sum the
 * flows of several portfolios into one aggregate benchmark. It owns the
 * external-only rule and the per-day historical rate, so a second flow reader
 * written for `/merged` would get both subtly wrong.
 *
 * The external-only rule is a query predicate, not a convention: INTEREST, FEE
 * and FX_CONVERSION rows move the balance but are not money crossing the
 * boundary of the account, and they are excluded here at the WHERE clause so no
 * caller has to remember to filter them.
 */
export async function dailyExternalFlows(
  db: DB,
  authToken: string | null,
  portfolioId: string | string[],
  from: string,
  to: string,
  baseCurrency: string,
  /** §63.10 — see {@link cashBalanceSeries}. */
  opts: { strict?: boolean } = {},
): Promise<Map<string, number>> {
  const base = baseCurrency.toUpperCase()
  const ids = Array.isArray(portfolioId) ? portfolioId : [portfolioId]
  if (ids.length === 0) return new Map()
  const rows = await db
    .select({
      amount: portfolioCashTransactions.amount,
      currency: portfolioCashTransactions.currency,
      transactionDate: portfolioCashTransactions.transactionDate,
    })
    .from(portfolioCashTransactions)
    .where(
      and(
        inArray(portfolioCashTransactions.type, [...EXTERNAL_CASH_TX_TYPES]),
        ids.length === 1
          ? eq(portfolioCashTransactions.portfolioId, ids[0])
          : inArray(portfolioCashTransactions.portfolioId, ids),
      ),
    )
    .orderBy(portfolioCashTransactions.transactionDate)

  if (rows.length === 0) return new Map()

  const flows = new Map<string, number>()
  for (const r of rows) {
    const day = toDateStr(r.transactionDate)
    if (!day || day < from || day > to) continue
    const ccy = (r.currency ?? base).toUpperCase()
    const toBase = await rateToBase(authToken, ccy, base, day, opts)
    flows.set(day, (flows.get(day) ?? 0) + Number(r.amount ?? 0) * toBase)
  }
  return flows
}

/**
 * §66.4 — a rate for a real currency pair, resolved with the caller's strictness.
 *
 * Both cash-ledger conversions used to inline
 * `(...)?.rate ?? 1`, which silently degraded a missing rate to 1:1 while
 * accepting — and then ignoring — the `opts` they were handed. So a
 * multi-currency portfolio's cash balance and its "money actually put in" could
 * both be wrong by an FX factor with nothing logged and nothing thrown, even on
 * the paths that explicitly asked for strict (the historical backfill).
 */
export async function rateToBase(
  authToken: string | null,
  from: string,
  base: string,
  day: string | null,
  opts: { strict?: boolean },
): Promise<number> {
  if (from === base) return 1
  const r = await resolvedFxRate(authToken, from, base, day ?? undefined, opts)
  if (r) return r.rate
  if (opts.strict) throw new FxRateUnavailableError(`${from}>${base}@${day ?? "latest"}`)
  console.warn(`[cash-ledger] no FX rate for ${from}>${base} on ${day ?? "latest"}: degrading 1:1`)
  return 1
}

/**
 * Cumulative net EXTERNAL cash flow of a portfolio in base currency (plan
 * follow-up 2026-09-27): Σ DEPOSIT − Σ WITHDRAWAL, each at its own historical
 * rate (instruments' date carry-forward). This is the "money actually put in
 * (and taken out)" number. A portfolio that is 100% invested has ~0 cash
 * *balance* but a large positive net external flow (it deposited its money).
 *
 * Trade rows (BUY/SELL/DIVIDEND) are internal cash↔position moves and are
 * excluded — only the cash-ledger external rows count, mirroring
 * {@link dailyExternalFlows}. The sign convention is the cash ledger's:
 * DEPOSIT >0, WITHDRAWAL <0. INTEREST, FEE and FX_CONVERSION are filtered out by
 * the query: they change the balance but are not money put in or taken out, so
 * letting them through here would inflate the capital basis with income and
 * costs.
 *
 * **An in-kind transfer contributes nothing here, and that is not a filter.**
 * The query admits every row whose type is external, so a `TRANSFER` row WOULD
 * count (§68.2's tests rely on that). But the in-kind transfer write path
 * deliberately writes **no** cash-ledger row — stock changing custody is not a
 * payment — so in production there is no term to sum and the basis never moved.
 * This docstring used to promise "± TRANSFER legs" and three call sites repeated
 * the claim; the promise was unfulfillable as written.
 *
 * **`total_invested` is not this number.** The capital basis that
 * `totalInvested`/`simpleReturnPercent` report adds the transferred cost, and
 * is `capitalBasisInvested()` in `transferFlows.ts` — a different module
 * because this one is imported by that one. Keep the two apart: conflating
 * "money put in" with "capital at risk" is what got `ADJUSTMENT` into trouble
 * (§89.5).
 */
export async function externalCashInvested(
  db: DB,
  authToken: string | null,
  portfolioId: string,
  baseCurrency: string,
  /** §63.10 — see {@link cashBalanceSeries}. */
  opts: { strict?: boolean } = {},
): Promise<number> {
  const base = baseCurrency.toUpperCase()
  const rows = await db
    .select({
      type: portfolioCashTransactions.type,
      amount: portfolioCashTransactions.amount,
      currency: portfolioCashTransactions.currency,
      transactionDate: portfolioCashTransactions.transactionDate,
    })
    .from(portfolioCashTransactions)
    .where(
      and(
        eq(portfolioCashTransactions.portfolioId, portfolioId),
        inArray(portfolioCashTransactions.type, [...EXTERNAL_CASH_TX_TYPES]),
      ),
    )

  let total = 0
  const legs = new Map<string, { amount: number; rate: number }>()
  for (const r of rows) {
    const day = toDateStr(r.transactionDate) ?? new Date().toISOString().slice(0, 10)
    const ccy = (r.currency ?? base).toUpperCase()
    const toBase = await rateToBase(authToken, ccy, base, day, opts)
    const amount = Number(r.amount ?? 0)
    total += amount * toBase
    const prev = legs.get(ccy) ?? { amount: 0, rate: toBase }
    prev.amount += amount
    legs.set(ccy, prev)
  }
  // RECALC_DEBUG — "money actually put in", the `invested` figure. Grouped per
  // currency at each leg's OWN historical rate, so a wrong `invested` is
  // attributable to a currency rather than to an opaque total.
  if (debugEnabled()) {
    debugLog(`cash-invested pf=${portfolioId} base=${base} rows=${rows.length} strict=${opts.strict === true} | ${fmtCcyRateMap(legs)} | total=${total.toFixed(2)}`)
  }
  return total
}
