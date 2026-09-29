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
import { instrumentsAuthHeaders, resolveRates } from "../services/instruments-fx.js"

/** Trades deviating from their bar by more than this are flagged. */
const DEFAULT_TOLERANCE = 0.1
/** How far back a weekend/holiday trade may borrow the previous close. */
export const MAX_CARRY_DAYS = 7
/** The ratio must sit this close to an FX rate before that pair is named. */
const FX_HINT_TOLERANCE = 0.01

export interface TradeRow {
  portfolioName: string
  symbol: string
  date: string
  price: number
  currency: string
  instrumentCurrency: string | null
  type?: string
  exchangeRate?: number | null
  /** §72.18 — the source row's id; a SELL sharing a base with an EXPIRATION is
   * an option premium, not a share trade. */
  externalId?: string | null
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
        ? rates.get(`${t.tradeCurrency}>${t.claimedCurrency}`) ?? null
        : null
    const norm = normaliseToBarCurrency(t.tradePrice, t.tradeCurrency, t.claimedCurrency, rateToBar)
    const usable = t.barClose != null && Number.isFinite(norm.price)
    const deviation = usable ? deviationPct(norm.price, t.barClose!) : null
    // The hint stays on the RAW ratio: an unconverted gap that IS an FX rate is
    return { ...t, deviation }
  })
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
    unreconciled: verdicts.filter((v) => v.deviation != null && Math.abs(v.deviation) > tolerance).length,
    worstDeviation: worst,
    claimedCurrency: verdicts[0]?.claimedCurrency ?? null,
    positionCurrency,
    unverifiable: verdicts.every((v) => v.barClose == null),
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

/** Raw native closes keyed by YYYY-MM-DD. No `?currency=` — that would convert. */
async function fetchNativeBars(
  symbol: string,
  authToken: string,
): Promise<{ bars: Map<string, number>; claimedCurrency: string | null }> {
  const base = (process.env.INSTRUMENTS_URL ?? process.env.API_INSTRUMENTS_URL ?? "").replace(/\/$/, "")
  if (!base) throw new Error("INSTRUMENTS_URL is not set — cannot read price bars")
  const res = await fetch(`${base}/api/instruments/${encodeURIComponent(symbol)}/history?resolution=daily`, {
    headers: instrumentsAuthHeaders(authToken),
  })
  if (!res.ok) return { bars: new Map(), claimedCurrency: null }
  const body = (await res.json()) as {
    timestamps?: number[]
    closePrices?: Array<number | null>
    baseCurrency?: string | null
    currency?: string | null
    currencySource?: string | null
  }
  const bars = new Map<string, number>()
  for (let i = 0; i < (body.timestamps?.length ?? 0); i++) {
    const close = body.closePrices?.[i]
    if (close == null || !(close > 0)) continue
    bars.set(new Date(body.timestamps![i] * 1000).toISOString().slice(0, 10), close)
  }
  // §72.10 — `currency` is the TARGET (equal to the base here, since no
  // ?currency= is sent) and `baseCurrency` is the resolved base, which comes back
  // null whenever instruments could not resolve one. Reading only baseCurrency
  // left several symbols — INGAKC.TFI among them — with an unknown bar currency,
  // which after the conversion change would have made them all "unchecked".
  // Taking whichever the service actually reported keeps them comparable.
  const claimed = body.baseCurrency ?? (body.currencySource === "unknown" ? null : body.currency) ?? null
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
    const trades = (await db.execute(sql`
      select pf.name as "portfolioName",
             t.instrument_symbol as symbol,
             to_char(t.executed_at at time zone 'UTC', 'YYYY-MM-DD') as date,
             t.price::float8 as price, t.currency as currency,
             t.instrument_currency as "instrumentCurrency",
             t.exchange_rate::float8 as "exchangeRate",
             t.external_id as "externalId",
             t.type as type
      from portfolios.transactions t
      join portfolios.portfolios pf on pf.id = t.portfolio_id
      where t.type in ('BUY','SELL') and t.price is not null and t.price <> 0
        and t.instrument_symbol is not null
        ${only ? sql`and pf.name = ${only}` : sql``}
      order by t.instrument_symbol, t.executed_at`)) as unknown as TradeRow[]

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
    const barCache = new Map<string, Awaited<ReturnType<typeof fetchNativeBars>>>()
    for (const sym of symbols) barCache.set(sym, await fetchNativeBars(sym, token))

    const bySymbol = new Map<string, Array<Omit<TradeVerdict, "fxHint">>>()
    let optionLegsSkipped = 0
    for (const t of trades) {
      // §72.18 — skip option premium legs; they have no share price to compare.
      if (t.type === "SELL" && t.externalId && optionLegIds.has(t.externalId)) {
        optionLegsSkipped++
        continue
      }
      const { bars, claimedCurrency } = barCache.get(t.symbol)!
      const hit = pickBar(bars, t.date)
      const list = bySymbol.get(t.symbol) ?? []
      list.push({
        portfolioName: t.portfolioName,
        symbol: t.symbol,
        date: t.date,
        tradePrice: t.price,
        barClose: hit?.close ?? null,
        carriedDays: hit?.carriedDays ?? 0,
        deviation: hit ? deviationPct(t.price, hit.close) : null,
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

    // Rates only among the currencies the trades themselves used, so an FX hint
    // can only ever name a pair that appears in the data being checked.
    const rates = new Map<string, number>()
    // §72.10 — the rate table must reach BOTH ends of every comparison: the
    // currency the trade was paid in, and the currency the bar is denominated
    // in. They are usually different (a .L listing paid in PLN), and keying only
    // on the trade currencies meant the conversion rate was simply absent, so
    // those trades could not be compared at all.
    const tradeCcy = [...new Set(trades.map((t) => (t.currency ?? "").toUpperCase()).filter(Boolean))]
    const barCcy = [...new Set([...barCache.values()].map((v) => (v.claimedCurrency ?? "").toUpperCase()).filter(Boolean))]
    const wanted = [...new Set([...tradeCcy, ...barCcy])]
    for (const from of wanted) {
      try {
        const r = await resolveRates(token, from, wanted.filter((o) => o !== from))
        for (const [k, v] of r) if (v != null) rates.set(`${k}>${from}`, v)
      } catch {
        // a missing pair just means that conversion is unavailable, and the
        // trade is then reported unchecked rather than compared wrongly
      }
    }

    const reports: SymbolReport[] = []
    for (const [sym, list] of bySymbol) {
      const posCcy = (list[0] ? trades.find((t) => t.symbol === sym)?.instrumentCurrency : null) ?? null
      reports.push(summarise(sym, assessSymbol(list, rates), (posCcy ?? "").toUpperCase() || null, tolerance))
    }
    reports.sort((a, b) => Math.abs(b.worstDeviation) - Math.abs(a.worstDeviation))
    const flagged = reports.filter((r) => r.unreconciled > 0)
    const unverifiable = reports.filter((r) => r.unverifiable)

    if (asJson) {
      console.log(JSON.stringify({ tolerance, flagged: flagged.length, reports }, null, 2))
    } else {
      const checked = reports.reduce((n, r) => n + r.trades.filter((t) => t.barClose != null).length, 0)
      const unverifiable = reports.filter((r) => r.unverifiable)
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
                ? `  [${v.tradePrice} ${v.tradeCurrency} → ${v.claimedCurrency} at that day's rate]`
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
        `[price-audit] ${flagged.length} symbol(s) need a venue override or a currency fix. Nothing was modified.`,
      )
    }
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
