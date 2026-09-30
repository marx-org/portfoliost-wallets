import { resolvedFxRate } from "./instruments-fx.js"

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

/**
 * §68 — ONE place that splits a portfolio's value into its two components.
 *
 * Before this there were three hand-written versions of the same arithmetic and
 * they had already drifted: `quotes.ts` added cash into totalValue, the
 * /total-metrics breakdown did not (so the headline missed cash by exactly the
 * cash balance — §63.3, open since the fact-check), and the summary-metrics route
 * summed positions RAW, with no per-position FX into the base currency, while
 * the contract said every amount was denominated in `currency`.
 *
 * `instrumentsValue` is each position's market value converted out of its OWN
 * instrument currency at its own rate, then summed. That last part is the point:
 * a raw cross-currency sum is only accidentally right when a portfolio happens to
 * hold positions in a single currency, and it is silently wrong otherwise.
 *
 * `cashValue` may be NEGATIVE (XTB and IKE Beata are margin accounts, §62) and is
 * never clamped — a negative balance reduces the total, which is the truth.
 * `totalValue` is then the sum by construction, so no caller can disagree with
 * another about what "value" means.
 */
export interface PortfolioValueSplit {
  /** Open positions only, in `base`, each converted from its own currency. */
  instrumentsValue: number
  /** Cash balance in `base`. Negative on a margin account. */
  cashValue: number
  /** instrumentsValue + cashValue — the whole account. */
  totalValue: number
  /**
   * §70 — open positions with no market value. They contribute NOTHING to
   * `instrumentsValue` and are counted here instead.
   *
   * This used to fall back to `quantity × averageCostBasis`, which reported the
   * position's COST as its market value: PROD had 75 of 85 open positions with
   * `market_value` NULL (nothing in the scheduled pipeline maintains that
   * column — only opening a portfolio refreshes it), and the headline
   * understated net worth by ~261k PLN. A cost basis is not a market value, and
   * it is not a safe default: it is plausible, which is exactly why it went
   * unnoticed. §66.2's rule — a number we do not have is rendered unresolved,
   * never invented.
   */
  unpricedPositions: number
}

export interface PositionValueRow {
  marketValue: string | number | null
  quantity: string | number | null
  averageCostBasis: string | number | null
  instrumentCurrency: string | null
}

/**
 * §63.2 — the composition rule that BOTH valuation paths share.
 *
 * **Neither path can be made to call the other, and the reason is the inputs,
 * not the code.** The live path (`splitPortfolioValue`) receives a market value
 * in each position's OWN instrument currency and converts it per row. The
 * history path (`computeSnapshotBatch`) receives a close that `fetchPriceSeries`
 * has **already** converted into the portfolio's base currency (§48.3), so it has
 * no instrument currency to convert and no market value per day. So this is not
 * "one function called twice" — that reading of §63.2 is not achievable, and
 * writing it as if it were would have meant re-deriving one path's inputs inside
 * the other.
 *
 * What IS duplicated — and what this removes — is everything *after* a per-row
 * number exists:
 *  - a row with no price contributes NOTHING and is counted, never substituted
 *    (§70 — a cost basis is not a market value, and it is plausible, which is
 *    why it went unnoticed for a session);
 *  - `totalValue` is the sum by construction, so no caller can disagree with
 *    another about what "value" means (§68);
 *  - cash is added last and never clamped (§62 — a margin account's negative
 *    balance reduces the total, which is the truth).
 *
 * Those three rules were written twice and could drift independently, which is
 * the exact failure §68 exists to prevent.
 *
 * @param contributions per-row values in the portfolio's base currency, or
 *   `null`/`undefined` for a row that is held but unpriced.
 */
export function composePortfolioValue(
  contributions: Iterable<number | null | undefined>,
  cashValue: number,
): PortfolioValueSplit {
  let instrumentsValue = 0
  let unpricedPositions = 0
  for (const c of contributions) {
    if (c == null) {
      unpricedPositions++
      continue
    }
    instrumentsValue += c
  }
  return { instrumentsValue, cashValue, totalValue: instrumentsValue + cashValue, unpricedPositions }
}

export async function splitPortfolioValue(
  toBase: (ccy: string) => Promise<number>,
  positions: PositionValueRow[],
  cashBalances: Map<string, number>,
  /**
   * Optional per-position observer, so the recalc path keeps its RCA debug log
   * without keeping a second copy of the arithmetic. §68 — the debug output was
   * the only thing the duplicated loop in quotes.ts was really for.
   */
  onPosition?: (info: { valueCcy: string; mv: number | null; contrib: number; unpriced: boolean }) => void,
): Promise<PortfolioValueSplit> {
  // Per-row conversion stays HERE, in the live path: this function is handed a
  // market value in the position's own currency and has to convert it. The
  // backfill receives pre-converted closes and cannot use this function at all —
  // see `composePortfolioValue`, which is the part the two genuinely share.
  const contributions: (number | null)[] = []
  for (const p of positions) {
    // §70 — NO cost-basis fallback. An unpriced position is worth an unknown
    // amount, not its purchase price, and reporting the purchase price as the
    // value is a lie that looks like a number.
    if (p.marketValue == null) {
      contributions.push(null)
      onPosition?.({ valueCcy: (p.instrumentCurrency ?? "").toUpperCase(), mv: null, contrib: 0, unpriced: true })
      continue
    }
    const mv = Number(p.marketValue)
    // A position with no instrument currency is passed through to the strict
    // converter, which throws rather than valuing it at face value in the base
    // currency (§66.4). A number is never invented here.
    const valueCcy = (p.instrumentCurrency ?? "").toUpperCase()
    const contrib = mv * (await toBase(valueCcy))
    contributions.push(contrib)
    onPosition?.({ valueCcy, mv, contrib, unpriced: false })
  }
  let cashValue = 0
  for (const [ccy, balance] of cashBalances) cashValue += balance * (await toBase(ccy))
  // §63.2 — the composition (unpriced ⇒ 0 + counted, total = sum, cash last and
  // unclamped) is `composePortfolioValue`'s, shared with the backfill.
  //
  // NOT rounded here. Rounding is a presentation decision and belongs at the JSON
  // boundary: the snapshot path persists 8dp, and rounding to cents inside this
  // function made snapshotPortfolioValue disagree with the backfill pipeline
  // (§53.6 asserts the two agree to 7 decimal places). Each route rounds its own
  // response; this returns what the arithmetic actually produced.
  return composePortfolioValue(contributions, cashValue)
}

/**
 * §70.2 — provenance helpers for a set of position rows.
 *
 * `oldestPriceAsOf` reports the OLDEST resolved price, not the newest, on
 * purpose. A total is only as fresh as its stalest input, and "last updated"
 * phrased against the freshest one implies the whole figure is current — which
 * is precisely the misleading claim §70 exists to stop. If NN TFI PPK is quoted
 * hourly and a Warsaw-listed position is carried over from yesterday, the
 * aggregate is a yesterday number wearing today's timestamp.
 *
 * Positions with no price at all are ignored rather than treated as infinitely
 * stale: they are already excluded from the value and counted in
 * `unpricedPositions`, and folding them in here would report a false age for a
 * figure that does not include them.
 */
export function oldestPriceAsOf(
  rows: { marketValue: string | number | null; priceAsOf: Date | string | null }[],
): string | null {
  let oldest: number | null = null
  for (const r of rows) {
    if (r.marketValue == null || r.priceAsOf == null) continue
    const t = r.priceAsOf instanceof Date ? r.priceAsOf.getTime() : Date.parse(String(r.priceAsOf))
    if (Number.isNaN(t)) continue
    if (oldest === null || t < oldest) oldest = t
  }
  return oldest === null ? null : new Date(oldest).toISOString()
}

/**
 * The dominant provenance across valued positions: 'fallback' wins ties, because
 * a single remembered price among fresh ones is the case worth surfacing.
 * Null when nothing could be priced.
 */
export function dominantPriceSource(
  rows: { marketValue: string | number | null; priceSource: string | null }[],
): string | null {
  const seen = new Set<string>()
  for (const r of rows) {
    if (r.marketValue == null) continue
    if (r.priceSource) seen.add(r.priceSource)
  }
  if (seen.size === 0) return null
  return seen.has("fallback") ? "fallback" : "quote"
}

