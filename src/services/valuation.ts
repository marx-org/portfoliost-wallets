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
}

export interface PositionValueRow {
  marketValue: string | number | null
  quantity: string | number | null
  averageCostBasis: string | number | null
  instrumentCurrency: string | null
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
  onPosition?: (info: { valueCcy: string; mv: number; contrib: number }) => void,
): Promise<PortfolioValueSplit> {
  let instrumentsValue = 0
  for (const p of positions) {
    const mv = p.marketValue != null ? Number(p.marketValue) : Number(p.quantity ?? 0) * Number(p.averageCostBasis ?? 0)
    // A position with no instrument currency is passed through to the strict
    // converter, which throws rather than valuing it at face value in the base
    // currency (§66.4). A number is never invented here.
    const valueCcy = (p.instrumentCurrency ?? "").toUpperCase()
    const contrib = mv * (await toBase(valueCcy))
    instrumentsValue += contrib
    onPosition?.({ valueCcy, mv, contrib })
  }
  let cashValue = 0
  for (const [ccy, balance] of cashBalances) cashValue += balance * (await toBase(ccy))
  // NOT rounded here. Rounding is a presentation decision and belongs at the JSON
  // boundary: the snapshot path persists 8dp, and rounding to cents inside this
  // function made snapshotPortfolioValue disagree with the backfill pipeline
  // (§53.6 asserts the two agree to 7 decimal places). Each route rounds its own
  // response; this returns what the arithmetic actually produced.
  return { instrumentsValue, cashValue, totalValue: instrumentsValue + cashValue }
}

