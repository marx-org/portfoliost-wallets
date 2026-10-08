/**
 * §72 — transaction-vs-market price audit.
 *
 * Every BUY/SELL is compared against the instrument's own close on that day, from
 * the price bars we already hold. Nothing is converted first, and that is the
 * load-bearing decision: the point is to CHECK the currency, so routing the
 * comparison through a converter would validate the converter against itself —
 * which is exactly how CRI.WA sat in the portfolio for months reading CAD while
 * every bar around it was PLN. A trade and a bar are compared as raw numbers, and
 * a wrong currency shows up AS the deviation, typically by a factor equal to that
 * pair's rate (which {@link fxHint} then names).
 *
 * `/history` is therefore called WITHOUT `?currency=`: that returns native closes
 * and reports `fxFrom: null`, i.e. no conversion happened.
 *
 * This is the check that found SRT3.DE, done by hand. Of three Sartorius trades,
 * two sat within 2% of the SRT.F closes and one sat 16.4% away — and FIFO left
 * the odd one out as the surviving holding. Across 13 symbols and 200+ trades
 * that is not repeatable by hand, which is why this exists and why it runs as a
 * job from admin.
 *
 * Run:  node dist/scripts/price-audit.js [--tolerance 0.10] [--json] [--portfolio <name>]
 *       [--exit-zero]
 *
 * `--exit-zero` is for the job path: a successful audit that FOUND problems is a
 * success with a report, not a failed Job. Without it a red failed Job per finding
 * trains people to ignore the badge. CLI/CI keeps exit 1.
 *
 * Exit: 0 clean (or forced) · 1 unreconciled symbols · 2 could not run
 */
import { sql } from "drizzle-orm"
import { getDb, closeDb } from "../db/index.js"
import type { DB } from "../db/index.js"
import { instrumentsAuthHeaders, resolvedFxRate } from "../services/instruments-fx.js"

/** Trades deviating from their bar by more than this are flagged. */
const DEFAULT_TOLERANCE = 0.1
/** How far back a weekend/holiday trade may borrow the previous close. */
export const MAX_CARRY_DAYS = 7

/**
 * §74.3/74.4 — how far either side of an order-priced trade the audit will look
 * for a bracketing bar.
 *
 * **This is an evidence-gathering radius, not a tolerance.** Nothing is declared
 * reconciled merely by being inside it, so unlike a tolerance it cannot silence a
 * genuine mismatch. PROD (§74.4) measured 102 forward / 26 backward / 36
 * same-day among the 164 of 174 TFI trades that reconcile to a bar at all, with
 * offsets reaching the edge of a ±21-day search — so the radius is set to 21
 * days, comfortably past the Polish/TSE settlement convention of T+2/T+5 and past
 * the 6-day gap in the broker's own worked example (order 2023-04-07, valuation
 * 2023-04-13), while staying far short of "any bar in the year".
 */
export const ORDER_PRICED_WINDOW_DAYS = 21
/** The ratio must sit this close to an FX rate before that pair is named. */
const FX_HINT_TOLERANCE = 0.01

/**
 * §72.22 — write the run's findings to `admin.job_run` so the admin UI can serve
 * them. Raw SQL because the wallets service does not own the `admin` schema; the
 * table and its jsonb `details` column already exist and admin already reads it.
 *
 * Best-effort by design: a failure to persist must NOT fail the audit. Losing the
 * report is unfortunate; failing a read-only audit that already ran is worse, and
 * the caller still has the full findings on stdout.
 */
async function persistReport(db: DB, payload: Record<string, unknown>): Promise<void> {
  try {
    await db.execute(sql`
      insert into admin.job_run (name, namespace, kind, status, details, started_at, updated_at)
      values ('price-audit', 'pfire', 'price_audit', ${payload.status as string}, ${JSON.stringify(payload)}::jsonb, now(), now())
      on conflict (name) do update set
        status = excluded.status,
        details = excluded.details,
        updated_at = now()
    `)
  } catch (e) {
    console.warn(
      `[price-audit] could not persist the report to admin.job_run: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
}

export interface TradeRow {
  portfolioName: string
  symbol: string
  date: string
  price: number
  currency: string
  instrumentCurrency: string | null
  type?: string
  exchangeRate?: number | null
  /**
   * §74.2 — `asset_type`, so an order-priced instrument can be identified by
   * what it IS rather than by guessing from its ticker shape.
   *
   * Measured in PROD 2026-09-30 before writing the predicate, because the plan
   * required it and because a `.TFI` suffix rule is a claim about provider
   * conventions: `asset_type` is populated on 100% of the 1960 transaction
   * rows, and every one of the 174 `*.TFI` BUY/SELL rows is `FUND`. The
   * fallback is therefore unnecessary — and a fallback that is never exercised
   * is a rule nobody can tell is dead.
   */
  assetType?: string | null
  /** §72.18 — the source row's id; a SELL sharing a base with an EXPIRATION is
   * an option premium, not a share trade. */
  externalId?: string | null
}

/**
 * §74.2 — an instrument whose orders are priced at the NAV of the VALUATION
 * date, not the order date. A PPO/PPI fund order placed on a Friday evening is
 * priced at the next business day's NAV, and the broker's own detail says so in
 * its field names: "Data zlecenia" / "Data wyceny" / "Cena Jednostki
 * Uczestnictwa z dnia wyceny".
 *
 * Keyed on `asset_type === 'FUND'`, which PROD populates for every fund row.
 */
export const ORDER_PRICED_ASSET_TYPES = new Set(["FUND"])

export function isOrderPriced(row: { assetType?: string | null }): boolean {
  const t = (row.assetType ?? "").trim().toUpperCase()
  return t !== "" && ORDER_PRICED_ASSET_TYPES.has(t)
}

export interface TradeVerdict {
  portfolioName: string
  symbol: string
  date: string
  tradePrice: number
  barClose: number | null
  carriedDays: number
  deviation: number | null
  tradeCurrency: string
  claimedCurrency: string | null
  /** The rate the IMPORT actually applied, when it applied one. */
  storedRate: number | null
  /** True when the trade row recorded two DIFFERENT currencies. */
  importConverted: boolean
  /** Trade price after conversion into the bar currency, when comparable. */
  normalisedPrice?: number | null
  /** Historical rate used for the payment-to-bar conversion. */
  conversionRate?: number | null
  /** §74.2 — the source row's asset class, for the report's provenance. */
  assetType?: string | null
  /** §74.3 — set on an order-priced trade. The deviation is left `null`. */
  orderPriced?: boolean
  /** The bracketing bars around an order-priced trade, with their offsets. */
  orderPricedPrior?: { date: string; close: number; offsetDays: number } | null
  orderPricedNext?: { date: string; close: number; offsetDays: number } | null
}

export interface SymbolReport {
  symbol: string
  checked: number
  unreconciled: number
  worstDeviation: number
  claimedCurrency: string | null
  positionCurrency: string | null
  /** No bars at all: nothing could be checked, which is itself worth saying. */
  unverifiable: boolean
  /** §74 — trades that are order-priced and therefore not deviation-judged. */
  orderPriced: number
  trades: TradeVerdict[]
}

/**
 * The close to compare a trade against: the same day, else the most recent prior
 * close within {@link MAX_CARRY_DAYS}.
 *
 * A trade on a Sunday has no bar of its own and is not thereby suspicious. A
 * trade whose nearest close is a week old IS, and reports the gap so it can be
 * judged rather than silently compared against a stale price.
 */
export function pickBar(
  bars: Map<string, number>,
  date: string,
  maxCarryDays = MAX_CARRY_DAYS,
): { close: number; carriedDays: number } | null {
  const exact = bars.get(date)
  if (exact != null) return { close: exact, carriedDays: 0 }
  let best: { date: string; close: number } | null = null
  for (const [d, close] of bars) {
    if (d >= date) continue
    if (!best || d > best.date) best = { date: d, close }
  }
  if (!best) return null
  const gap = Math.round(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${best.date}T00:00:00Z`)) / 86_400_000,
  )
  if (gap > maxCarryDays) return null
  return { close: best.close, carriedDays: gap }
}

/**
 * §74.3 — the two bars that bracket an order-priced trade, and which side each
 * one is on.
 *
 * `pickBar` carries BACKWARD, which is right for an exchange holiday and wrong
 * for a fund order priced forward: on 2023-04-07 (Good Friday) it takes
 * 2023-04-06 = 339.47, and 382.05 / 339.47 = 1.1254 — the 1.126 that §72.19 and
 * §72.20 chased across nine ING Akcji categories.
 *
 * **This returns evidence, not a verdict, and that is deliberate.** §74.4
 * measured the offsets in PROD and could not pin a window constant (see the
 * note in the plan): 164 of 174 TFI trades reconcile to *some* bar within 10%,
 * but the offsets run to the edge of the search window in both directions, so
 * any constant is a guess about a distribution that is not there. A guess would
 * also hide genuine mismatches, which the plan calls out as worse than the
 * defect. So the audit reports the bracketing bars and declines to compute a
 * deviation for a fund trade.
 */
export function pickOrderPricedBar(
  bars: Map<string, number>,
  date: string,
  windowDays = ORDER_PRICED_WINDOW_DAYS,
): {
  prior: { date: string; close: number; offsetDays: number } | null
  next: { date: string; close: number; offsetDays: number } | null
} {
  const at = (d: string) => Date.parse(`${d}T00:00:00Z`)
  const target = at(date)
  const day = 86_400_000
  let prior: { date: string; close: number; offsetDays: number } | null = null
  let next: { date: string; close: number; offsetDays: number } | null = null
  for (const [d, close] of bars) {
    const delta = Math.round((at(d) - target) / day)
    if (delta === 0 || Math.abs(delta) > windowDays) continue
    if (delta < 0 && (!prior || d > prior.date)) prior = { date: d, close, offsetDays: delta }
    if (delta > 0 && (!next || d < next.date)) next = { date: d, close, offsetDays: delta }
  }
  return { prior, next }
}

/**
 * Put a trade's price in the BAR's currency before comparing.
 *
 * A trade has two currencies: the one it was PAID in (`currency`) and the one the
 * instrument TRADES in. They are routinely different, and legitimately so: a
 * broker will sell a GBP-listed stock priced in PLN and convert internally, so a
 * Chesnara buy lands as 12.91 PLN against a £2.236 bar. Compared raw that reads
 * as +477% and is nonsense — the number was never wrong.
 *
 * So the comparison converts, at the trade date's rate, from the payment currency
 * into the bar's own currency. Two things this deliberately does NOT do:
 *   - it does not fall back to 1:1. A missing rate means the comparison cannot be
 *     made, and returning the unconverted number would recreate the exact false
 *     positive this fixes. The trade is reported as unchecked instead.
 *   - it does not use the position's `instrument_currency`. That field is one of
 *     the things under suspicion (CRI.WA read CAD on a Warsaw listing), so
 *     trusting it here would let a corrupt value launder itself into a "clean"
 *     comparison. The bar's own currency is the independent reference.
 *
 * This is why §72.6 does the pricing from bars rather than from
 * `instrument_currency`: the two must not be able to confirm each other.
 */
export function normaliseToBarCurrency(
  tradePrice: number,
  tradeCurrency: string,
  barCurrency: string | null,
  rateToBar: number | null,
): { price: number; converted: boolean } {
  const from = (tradeCurrency ?? "").trim().toUpperCase()
  const to = (barCurrency ?? "").trim().toUpperCase()
  if (!from) return { price: Number.NaN, converted: false }
  // No bar currency: we cannot tell whether the trade's currency is the bar's,
  // so the comparison cannot be verified. Returning the raw number would compare
  // a possibly-foreign price to the bar — the false positive this whole function
  // exists to remove. An unknown bar currency makes the trade UNCHECKED, and the
  // summary reports how many that is.
  if (!to) return { price: Number.NaN, converted: false }
  if (from === to) return { price: tradePrice, converted: false }
  if (rateToBar == null || !Number.isFinite(rateToBar) || !(rateToBar > 0)) {
    return { price: Number.NaN, converted: false }
  }
  return { price: tradePrice * rateToBar, converted: true }
}

/** Signed relative difference: +0.05 means the trade was 5% above the bar. */
export function deviationPct(tradePrice: number, barClose: number): number {
  if (!(barClose > 0)) return Number.NaN
  return tradePrice / barClose - 1
}

/**
 * Attach the FX hint, and DERIVE the deviation from the two prices.
 *
 * The deviation is computed here rather than accepted from the caller: a
 * caller-supplied deviation that disagrees with its own tradePrice/barClose is
 * exactly the kind of quiet inconsistency this audit exists to catch, and
 * accepting one would make it capable of hiding a finding.
 */
export function assessSymbol(
  trades: TradeVerdict[],
  rates: Map<string, number> = new Map(),
): TradeVerdict[] {
  return trades.map((t) => {
    // §72.10 — the rate to put the PAYMENT currency into the bar's currency.
    // Absent, we cannot compare rather than compare wrongly.
    // §72.11 — the trade row already carries the rate the IMPORT applied, and it
    // is the authority when the import actually converted: it is what the user
    // paid, including any custom or manual rate.
    //
    // It is NOT usable when the import recorded one currency twice. All 1193
    // trades carry an `exchange_rate`, but for CSN.L 2025-01-22 — a .L listing
    // paid in PLN — `currency` and `instrument_currency` are both PLN, so the
    // stored rate is 1.0 by construction and encodes the mis-recording rather
    // than a conversion. Trusting it there compares 12.91 "GBP" to a £2.236 bar
    // and reproduces the 477% the conversion exists to remove. Hence: honour the
    // stored rate only when the two currencies actually differ.
    const rateToBar = t.importConverted
      ? t.storedRate
      : t.claimedCurrency
        ? rates.get(`${t.tradeCurrency}>${t.claimedCurrency}>${t.date}`) ??
          rates.get(`${t.tradeCurrency}>${t.claimedCurrency}`) ?? null
        : null
    const norm = normaliseToBarCurrency(t.tradePrice, t.tradeCurrency, t.claimedCurrency, rateToBar)
    const usable = t.barClose != null && Number.isFinite(norm.price)
    // §74.3 — an order-priced fund trade is NOT deviation-judged. Its executed
    // price belongs to a later valuation date by construction, so any ratio
    // against a bar is a statement about the calendar rather than about the
    // data, and reporting one manufactures findings that are true about the
    // fund and false about the pipeline. `deviation: null` is what makes
    // `summarise` skip it — the trade is still present in the report, with its
    // bracketing bars, so nothing is hidden.
    if (t.orderPriced) return { ...t, deviation: null, normalisedPrice: norm.price, conversionRate: rateToBar }
    const deviation = usable ? deviationPct(norm.price, t.barClose!) : null
    // The hint stays on the RAW ratio: an unconverted gap that IS an FX rate is
    return { ...t, deviation, normalisedPrice: Number.isFinite(norm.price) ? norm.price : null, conversionRate: rateToBar }
  })
}

/**
 * §74/§72.8 — does this trade have any evidence behind it?
 *
 * Evidence is either a bar the trade was compared against, or the bracketing
 * bars an order-priced trade was shown instead (an order price is never
 * deviation-judged, so its bar read is suppressed on purpose). Keying on
 * `orderPriced` instead of the brackets would let a fund with NO bars at all
 * count as "checked": exactly the §71.6/§72.8 failure where a failed bar read
 * passes as clean and CHECKED NOTHING never fires.
 */
export function hasBarEvidence(v: TradeVerdict): boolean {
  return v.barClose != null || v.orderPricedPrior != null || v.orderPricedNext != null
}

/** Per-symbol roll-up, worst deviation first at the call site. */
export function summarise(
  symbol: string,
  verdicts: TradeVerdict[],
  positionCurrency: string | null,
  tolerance: number,
): SymbolReport {
  const devs = verdicts
    .map((v) => v.deviation)
    .filter((d): d is number => d != null && Number.isFinite(d))
  const worst = devs.reduce((a, b) => (Math.abs(b) > Math.abs(a) ? b : a), 0)
  return {
    symbol,
    checked: verdicts.length,
    // §74 — an order-priced trade is counted as checked (it WAS compared against
    // the bracketing bars) but never as unreconciled, because the ratio between
    // an order price and a valuation-date NAV is not a defect.
    orderPriced: verdicts.filter((v) => v.orderPriced).length,
    unreconciled: verdicts.filter((v) => v.deviation != null && Math.abs(v.deviation) > tolerance).length,
    worstDeviation: worst,
    claimedCurrency: verdicts[0]?.claimedCurrency ?? null,
    positionCurrency,
    // §74/§72.8 — evidence is the bar the trade was compared against, or the
    // bracketing bars an order-priced trade was shown instead (its barClose is
    // suppressed on purpose: an order price against a valuation-date NAV is not
    // a defect). Keying on `orderPriced` rather than the brackets would let a
    // fund whose bar read FAILED count as checked — the §71.6/§72.8 failure
    // where no data reads as clean.
    unverifiable: verdicts.every((v) => !hasBarEvidence(v)),
    trades: verdicts,
  }
}

/**
 * §72 — the instruments credential, whichever kind this run was given.
 *
 * The scheduled sweep has the shared secret; the admin job has the triggering
 * user's JWT (the same one wipe-&-reimport passes). Both are accepted, and
 * `instrumentsAuthHeaders` routes each to the header the service actually reads —
 * Bearer in `Authorization`, service token in `X-Service-Token`. Getting this
 * wrong is a silent 401, not an error: see the §71 note on `quotes.ts`, where the
 * token was sent in the wrong header and the sweep reported "priced" twice a day
 * while writing nothing.
 */
export function resolveInstrumentsToken(env: NodeJS.ProcessEnv = process.env): string {
  const svc = env.INSTRUMENTS_SERVICE_TOKEN?.trim()
  if (svc) return svc
  const user = env.INSTRUMENTS_AUTH_TOKEN?.trim()
  if (user) return user
  throw new Error(
    "neither INSTRUMENTS_SERVICE_TOKEN nor INSTRUMENTS_AUTH_TOKEN is set. The sweep has " +
      "no user identity and needs the service token; the admin price-audit job passes the " +
      "caller's JWT as INSTRUMENTS_AUTH_TOKEN. Without one, every bar read is a 401 that " +
      "looks like an empty series.",
  )
}

export function logAuditProgress(asJson: boolean, message: string): void {
  if (!asJson) console.log(`[price-audit] progress: ${message}`)
}

/** Canonical native closes keyed by YYYY-MM-DD. No `?currency=` — that would convert. */
export function priceAuditBarsUrl(base: string, symbol: string, from: string, to: string): string {
  const q = new URLSearchParams({ from, to })
  return `${base.replace(/\/$/, "")}/api/instruments/${encodeURIComponent(symbol)}/price-bars?${q}`
}

async function fetchNativeBars(
  symbol: string,
  from: string,
  to: string,
  authToken: string,
): Promise<{ bars: Map<string, number>; claimedCurrency: string | null }> {
  const base = (process.env.INSTRUMENTS_URL ?? process.env.API_INSTRUMENTS_URL ?? "").replace(/\/$/, "")
  if (!base) throw new Error("INSTRUMENTS_URL is not set — cannot read price bars")
  const res = await fetch(priceAuditBarsUrl(base, symbol, from, to), {
    headers: instrumentsAuthHeaders(authToken),
  })
  if (!res.ok) return { bars: new Map(), claimedCurrency: null }
  const body = (await res.json()) as {
    dates?: string[]
    closes?: Array<number | null>
    baseCurrency?: string | null
    currency?: string | null
  }
  const bars = new Map<string, number>()
  for (let i = 0; i < (body.dates?.length ?? 0); i++) {
    const close = body.closes?.[i]
    if (close == null || !(close > 0)) continue
    bars.set(body.dates![i], close)
  }
  // price-bars is the canonical local/provider series. Its baseCurrency is the
  // resolved instrument currency; currency is retained as a fallback for older
  // instruments responses.
  const claimed = body.baseCurrency ?? body.currency ?? null
  return { bars, claimedCurrency: typeof claimed === "string" ? claimed.toUpperCase() : null }
}

async function main() {
  const argv = process.argv.slice(2)
  const tIdx = argv.indexOf("--tolerance")
  const tolerance = tIdx >= 0 ? Number(argv[tIdx + 1]) : DEFAULT_TOLERANCE
  const asJson = argv.includes("--json")
  const exitZero = argv.includes("--exit-zero")
  const pIdx = argv.indexOf("--portfolio")
  const only = pIdx >= 0 ? argv[pIdx + 1] : null

  const db = await getDb()
  try {
    const token = resolveInstrumentsToken()
    let trades = (await db.execute(sql`
      select pf.name as "portfolioName",
             t.instrument_symbol as symbol,
             to_char(t.executed_at at time zone 'UTC', 'YYYY-MM-DD') as date,
             t.price::float8 as price, t.currency as currency,
             t.instrument_currency as "instrumentCurrency",
             t.exchange_rate::float8 as "exchangeRate",
             t.external_id as "externalId",
             t.asset_type as "assetType",   -- §74.2: the rule keys on this
             t.type as type
      from portfolios.transactions t
      join portfolios.portfolios pf on pf.id = t.portfolio_id
      where t.type in ('BUY','SELL') and t.price is not null and t.price <> 0
        and t.instrument_symbol is not null
        ${only ? sql`and pf.name = ${only}` : sql``}
       order by t.instrument_symbol, t.executed_at`)) as unknown as TradeRow[]
    const unsupportedTrades = trades.filter((t) => (t.assetType ?? "").trim().toUpperCase() === "BOND")
    trades = trades.filter((t) => (t.assetType ?? "").trim().toUpperCase() !== "BOND")
    if (!asJson && unsupportedTrades.length > 0) {
      console.log(
        `[price-audit] skipped ${unsupportedTrades.length} BOND trade(s): fixed-income trades ` +
          `require bond valuation data, not equity price bars.`,
      )
    }
    logAuditProgress(asJson, `loaded ${trades.length} auditable BUY/SELL trades`)

    // §72.18 — an option premium is not a share trade, and comparing it with a
    // share price is a guaranteed false positive.
    //
    // A SELL of 100 at 1.04-1.30 with a sibling EXPIRATION at 0 whose
    // externalId is the SELL's plus "#e" is the premium leg of an option, not a
    // disposal of 100 shares. The share bar for the same day is ~150, so the
    // audit read -99.3% on five SAP.DE rows and reported them as price
    // mismatches. Equate+ has five such pairs.
    //
    // This is the same pairing §72.14 uses to stop them disposing of the equity
    // lot, read from the other end: there the leg was wrongly counted as shares,
    // here the leg was wrongly counted as a share-sized trade.
    const optionLegIds = new Set<string>()
    const expRows = (await db.execute(sql`
      select t.external_id as "externalId"
      from portfolios.transactions t
      ${only ? sql`join portfolios.portfolios pf on pf.id = t.portfolio_id` : sql``}
      where t.type = 'EXPIRATION' and t.external_id is not null
        ${only ? sql`and pf.name = ${only}` : sql``}`)) as unknown as Array<{ externalId: string }>
    for (const r of expRows) optionLegIds.add(r.externalId.replace(/#e$/, ""))

    // One history call per symbol, reused across every trade in it.
    const symbols = [...new Set(trades.map((t) => t.symbol))]
    const from = trades.reduce((min, t) => (t.date < min ? t.date : min), trades[0]?.date ?? "")
    const to = trades.reduce((max, t) => (t.date > max ? t.date : max), trades[0]?.date ?? "")
    const barCache = new Map<string, Awaited<ReturnType<typeof fetchNativeBars>>>()
    logAuditProgress(asJson, `fetching canonical price bars for ${symbols.length} symbols (${from} to ${to})`)
    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i]
      logAuditProgress(asJson, `fetching ${i + 1}/${symbols.length}: ${sym}`)
      const bars = await fetchNativeBars(sym, from, to, token)
      barCache.set(sym, bars)
      logAuditProgress(asJson, `fetched ${i + 1}/${symbols.length}: ${sym} (${bars.bars.size} bars${bars.claimedCurrency ? `, ${bars.claimedCurrency}` : ""})`)
    }

    const bySymbol = new Map<string, Array<Omit<TradeVerdict, "fxHint">>>()
    let optionLegsSkipped = 0
    for (const t of trades) {
      // §72.18 — skip option premium legs; they have no share price to compare.
      if (t.type === "SELL" && t.externalId && optionLegIds.has(t.externalId)) {
        optionLegsSkipped++
        continue
      }
      const { bars, claimedCurrency } = barCache.get(t.symbol)!
      // §74.2/74.3 — an order-priced instrument is judged against the bars that
      // BRACKET the order, not against the prior close, and is not given a
      // deviation at all. `pickBar` is untouched for everything else.
      const orderPriced = isOrderPriced(t)
      const bracket = orderPriced ? pickOrderPricedBar(bars, t.date) : null
      const hit = orderPriced ? null : pickBar(bars, t.date)
      const list = bySymbol.get(t.symbol) ?? []
      list.push({
        portfolioName: t.portfolioName,
        symbol: t.symbol,
        date: t.date,
        tradePrice: t.price,
        barClose: hit?.close ?? null,
        carriedDays: hit?.carriedDays ?? 0,
        deviation: hit ? deviationPct(t.price, hit.close) : null,
        assetType: t.assetType ?? null,
        orderPriced,
        orderPricedPrior: bracket?.prior ?? null,
        orderPricedNext: bracket?.next ?? null,
        tradeCurrency: (t.currency ?? "").toUpperCase(),
        claimedCurrency,
        storedRate: t.exchangeRate ?? null,
        importConverted: Boolean(
          t.instrumentCurrency &&
            (t.currency ?? "").toUpperCase() !== t.instrumentCurrency.toUpperCase(),
        ),
      })
      bySymbol.set(t.symbol, list)
    }

    // §72.10 — resolve the FX rate at EACH TRADE's DATE, from the currency the
    // trade was paid in to the currency the bar is denominated in. They are
    // usually different (a .L listing paid in PLN), and keying on a single
    // latest rate made historical trades look wrong by the pair's long-term
    // move (USD>GBP at 0.76 instead of 2020's ~0.80, EUR>USD at 4.29 instead of
    // ~1.09). The rate is resolved per trade date so the comparison uses the
    // rate that was actually in force.
    const rates = new Map<string, number>()
    const rateKeys = new Set<string>()
    for (const [, list] of bySymbol) {
      for (const t of list) {
        const from = t.tradeCurrency
        const to = t.claimedCurrency ?? ""
        if (!from || !to || from === to) continue
        // a trade the IMPORT itself converted already carries its rate as
        // `storedRate`, and that is the authority; only the un-converted rows
        // need the hint resolved here.
        if (t.importConverted) continue
        rateKeys.add(`${from}>${to}>${t.date}`)
      }
    }
    logAuditProgress(asJson, `resolving ${rateKeys.size} historical FX rates`)
    let resolvedCount = 0
    for (const key of rateKeys) {
      const [from, to, date] = key.split(">")
      const r = await resolvedFxRate(token, from, to, date)
      if (r) rates.set(key, r.rate)
      resolvedCount++
      if (resolvedCount % 50 === 0 || resolvedCount === rateKeys.size) {
        logAuditProgress(asJson, `resolved ${resolvedCount}/${rateKeys.size} historical FX rates`)
      }
    }

    const reports: SymbolReport[] = []
    logAuditProgress(asJson, `assessing ${bySymbol.size} symbols`)
    for (const [sym, list] of bySymbol) {
      const posCcy = (list[0] ? trades.find((t) => t.symbol === sym)?.instrumentCurrency : null) ?? null
      reports.push(summarise(sym, assessSymbol(list, rates), (posCcy ?? "").toUpperCase() || null, tolerance))
    }
    reports.sort((a, b) => Math.abs(b.worstDeviation) - Math.abs(a.worstDeviation))
    const flagged = reports.filter((r) => r.unreconciled > 0)
    const unverifiable = reports.filter((r) => r.unverifiable)
    const orderPricedReports = reports.filter((r) => r.orderPriced > 0)
    const orderPricedTotal = orderPricedReports.reduce((n, r) => n + r.orderPriced, 0)
    // §74/§72.8 — count trades with EVIDENCE: a judged bar, or the bracketing
    // bars an order-priced trade was shown. Keying on `orderPriced` alone would
    // count a fund whose bar read failed and weaken the CHECKED NOTHING guard;
    // keying on `barClose` alone would drop the bracketed fund trades from this
    // total while §74 prints their brackets below.
    const checked = reports.reduce((n, r) => n + r.trades.filter(hasBarEvidence).length, 0)

    if (asJson) {
      console.log(JSON.stringify({ tolerance, flagged: flagged.length, reports }, null, 2))
    } else {
      console.log(
        `[price-audit] ${trades.length} BUY/SELL trades across ${symbols.length} symbols ` +
          `(tolerance ${(tolerance * 100).toFixed(0)}%)\n`,
      )
      // §72.8 — a missing credential 401s, and a 401 is indistinguishable from
      // "this symbol has no bars". The first PROD run therefore reported
      // "every trade reconciles" over 219 symbols it had checked NONE of, and
      // "0 symbols need a fix" — a clean bill of health for a run that measured
      // nothing. Never claim reconciliation without saying what was compared.
      if (checked === 0) {
        console.log(
          `[price-audit] CHECKED NOTHING: 0 of ${trades.length} trades had a price bar. ` +
            `That is not a clean result — it means every bar read failed. Check the ` +
            `credential (INSTRUMENTS_AUTH_TOKEN must arrive as "Bearer <jwt>" so it is ` +
            `sent in Authorization; anything else goes as X-Service-Token and is rejected).\n`,
        )
      } else if (unverifiable.length > 0) {
        if (optionLegsSkipped > 0) {
          console.log(
            `[price-audit] ${optionLegsSkipped} option premium leg(s) skipped ` +
              `(SELLs sharing a base with an EXPIRATION — §72.18).\n`,
          )
        }
        console.log(
          `[price-audit] WARNING: ${unverifiable.length} symbol(s) have no bars and were NOT checked ` +
            `(${unverifiable.reduce((n, r) => n + r.checked, 0)} trades). ` +
            `A symbol with no data is unverified, not clean.\n`,
        )
      }
      if (flagged.length === 0 && checked > 0) {
        console.log(
          `[price-audit] all ${checked} checked trades reconcile with their bar` +
            (optionLegsSkipped > 0
              ? ` (${optionLegsSkipped} option premium leg(s) skipped — not share trades)`
              : "") +
            `\n`,
        )
      }
      // §74 — the order-priced trades are REPORTED, not hidden. "Every NN TFI
      // trade is a false positive" was true of the old comparison and false of
      // the data; saying so requires showing the reader the evidence rather than
      // dropping the trades, which is what §71.6 was about for the audit above.
      if (orderPricedReports.length > 0) {
        console.log(
          `[price-audit] ${orderPricedTotal} order-priced fund trade(s) across ` +
            `${orderPricedReports.length} symbol(s) not deviation-judged (§74): a PPO/PPI ` +
            `order is priced at the VALUATION date's NAV, so any ratio to a bar is a statement ` +
            `about the calendar. The executed price and the bracketing bars are below.\n`,
        )
        for (const r of orderPricedReports) {
          for (const v of r.trades.filter((t) => t.orderPriced)) {
            const p = v.orderPricedPrior
            const n = v.orderPricedNext
            console.log(
              `  ${v.symbol.padEnd(12)} ${v.date} ${v.portfolioName}: ${v.tradePrice} ${v.tradeCurrency}` +
                (p ? ` · prior bar ${p.date} ${p.close} (${p.offsetDays}d)` : " · no prior bar") +
                (n ? ` · next bar ${n.date} ${n.close} (+${n.offsetDays}d)` : " · no next bar"),
            )
          }
        }
        console.log("")
      }
      for (const r of flagged) {
        console.log(
          `  ${r.symbol.padEnd(12)} ${r.unreconciled}/${r.checked} off · worst ${(r.worstDeviation * 100).toFixed(1)}% · ` +
            `bar ccy ${r.claimedCurrency ?? "?"} vs position ${r.positionCurrency ?? "?"}`,
        )
        for (const v of r.trades.filter((t) => t.deviation != null && Math.abs(t.deviation) > tolerance)) {
          console.log(
            `      ${v.date} ${v.portfolioName}: trade ${v.tradePrice} ${v.tradeCurrency} vs bar ${v.barClose}` +
              ` (${(v.deviation! * 100).toFixed(1)}%${v.carriedDays ? `, close is ${v.carriedDays}d older` : ""})` +
              (v.tradeCurrency !== v.claimedCurrency
                ? `  [${v.tradePrice} ${v.tradeCurrency} → ${v.normalisedPrice ?? "?"} ${v.claimedCurrency} at ${v.conversionRate ?? "?"}]`
                : ""),
          )
        }
        console.log("")
      }
      if (unverifiable.length > 0) {
        console.log(
          `[price-audit] ${unverifiable.length} symbol(s) have no bars and could not be checked: ` +
            unverifiable.map((r) => r.symbol).join(", "),
        )
      }
      console.log(
        `[price-audit] ${flagged.length} symbol(s) have residual price deviations after ` +
          `trade-date currency normalization. Nothing was modified.`,
      )
    }
    // §72.22 — persist the report so it is readable from the admin UI.
    //
    // The findings used to exist only in this process's stdout, which meant the
    // Data quality card could start an audit and confirm it finished but could not
    // show what it found — the one thing worth knowing. `admin.job_run.details` is
    // already jsonb and admin already reads that table (the stooq job writes
    // `latest_date`/`rows_deleted` into the same row), so the report lands beside
    // the pod counts with no schema change and no migration.
    //
    // Scope note: this writes to job_run and to NOTHING else. The audit stays
    // read-only with respect to portfolio data — that is what makes it safe to run
    // against PROD unattended, and it would be a poor trade to give that up for a
    // convenience feature.
    await persistReport(db, {
      status: "Succeeded",
      trades: trades.length,
      symbols: reports.length,
      checked,
      flagged: flagged.map((r) => r.symbol),
      unverifiable: unverifiable.map((r) => r.symbol),
      optionLegsSkipped,
      reports: reports.map((r) => ({
        symbol: r.symbol,
        unreconciled: r.unreconciled,
        unverifiable: r.unverifiable,
        trades: r.trades,
      })),
    })
    process.exit(flagged.length > 0 && !exitZero ? 1 : 0)
  } catch (e) {
    console.error(`[price-audit] could not run: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(2)
  } finally {
    await closeDb()
  }
}

if (process.argv[1]?.endsWith("price-audit.js") || process.argv[1]?.endsWith("price-audit.ts")) {
  void main()
}
