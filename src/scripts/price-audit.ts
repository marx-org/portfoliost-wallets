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
  /** "EUR>PLN" when the deviation is almost exactly one pair's rate. */
  fxHint: string | null
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

/** Signed relative difference: +0.05 means the trade was 5% above the bar. */
export function deviationPct(tradePrice: number, barClose: number): number {
  if (!(barClose > 0)) return Number.NaN
  return tradePrice / barClose - 1
}

/**
 * Name the currency pair when the trade/bar ratio is almost exactly an FX rate.
 *
 * Valid HERE and not at portfolio level: this is ONE trade against ONE close, so
 * the ratio is a like-for-like quantity. The same heuristic applied to a summed
 * portfolio total is meaningless — see the note in `valuation-audit.ts`, where a
 * single bad position among thirteen moved the total by 0.847 against a
 * CAD→PLN rate of 2.7131, and the heuristic was cut rather than shipped.
 */
export function fxHint(
  ratio: number,
  tradeCurrency: string,
  claimedCurrency: string | null,
  rates: Map<string, number>,
): string | null {
  if (!claimedCurrency || tradeCurrency === claimedCurrency) return null
  const key = `${tradeCurrency}>${claimedCurrency}`
  const rate = rates.get(key)
  if (rate == null) return null
  return Math.abs(ratio - rate) <= FX_HINT_TOLERANCE ? key : null
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
  trades: Array<Omit<TradeVerdict, "fxHint">>,
  rates: Map<string, number> = new Map(),
): TradeVerdict[] {
  return trades.map((t) => {
    const deviation = t.barClose == null ? null : deviationPct(t.tradePrice, t.barClose)
    const ratio = t.barClose ? t.tradePrice / t.barClose : Number.NaN
    return {
      ...t,
      deviation,
      fxHint: Number.isNaN(ratio) ? null : fxHint(ratio, t.tradeCurrency, t.claimedCurrency, rates),
    }
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
  }
  const bars = new Map<string, number>()
  for (let i = 0; i < (body.timestamps?.length ?? 0); i++) {
    const close = body.closePrices?.[i]
    if (close == null || !(close > 0)) continue
    bars.set(new Date(body.timestamps![i] * 1000).toISOString().slice(0, 10), close)
  }
  return { bars, claimedCurrency: body.baseCurrency ?? null }
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
             t.instrument_currency as "instrumentCurrency"
      from portfolios.transactions t
      join portfolios.portfolios pf on pf.id = t.portfolio_id
      where t.type in ('BUY','SELL') and t.price is not null and t.price <> 0
        and t.instrument_symbol is not null
        ${only ? sql`and pf.name = ${only}` : sql``}
      order by t.instrument_symbol, t.executed_at`)) as unknown as TradeRow[]

    // One history call per symbol, reused across every trade in it.
    const symbols = [...new Set(trades.map((t) => t.symbol))]
    const barCache = new Map<string, Awaited<ReturnType<typeof fetchNativeBars>>>()
    for (const sym of symbols) barCache.set(sym, await fetchNativeBars(sym, token))

    const bySymbol = new Map<string, Array<Omit<TradeVerdict, "fxHint">>>()
    for (const t of trades) {
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
      })
      bySymbol.set(t.symbol, list)
    }

    // Rates only among the currencies the trades themselves used, so an FX hint
    // can only ever name a pair that appears in the data being checked.
    const rates = new Map<string, number>()
    const ccy = [...new Set(trades.map((t) => (t.currency ?? "").toUpperCase()).filter(Boolean))]
    for (const c of ccy) {
      try {
        const r = await resolveRates(token, c, ccy.filter((o) => o !== c))
        for (const [k, v] of r) if (v != null) rates.set(`${k}>${c}`, v)
      } catch {
        // a missing pair just means no hint is offered for it
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
        console.log(
          `[price-audit] WARNING: ${unverifiable.length} symbol(s) have no bars and were NOT checked ` +
            `(${unverifiable.reduce((n, r) => n + r.checked, 0)} trades). ` +
            `A symbol with no data is unverified, not clean.\n`,
        )
      }
      if (flagged.length === 0 && checked > 0) {
        console.log(`[price-audit] all ${checked} checked trades reconcile with their bar.\n`)
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
              (v.fxHint ? `  ← ratio is FX ${v.fxHint}: wrong currency` : ""),
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
