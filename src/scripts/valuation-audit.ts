/**
 * §71 — valuation audit: report positions whose stored metadata contradicts the
 * evidence already in the database.
 *
 * CRI.WA carried `instrument_currency = 'CAD'` for months while both of its BUY
 * transactions said `PLN`. Nothing failed: the value was multiplied by 2.7131,
 * the aggregate still looked plausible, and the stored snapshots (built from
 * pre-converted price bars) disagreed with the live figure by 18% without
 * either side raising. The contradiction was sitting in two columns of the same
 * table, and nothing read both.
 *
 * Two checks, both read-only:
 *
 *   1. CURRENCY — does a position's currency match the currency on its own
 *      transactions? The import writes both from the same source row, so a
 *      disagreement means something later overwrote one of them.
 *   2. RECONCILIATION — does the live valuation of a portfolio match the stored
 *      snapshot for the same day? This is the invariant the UI depends on and
 *      the one the currency bug violated. It does NOT try to name the offending
 *      currency from the size of the gap: a portfolio total is a sum, so one
 *      mislabelled position out of thirteen moves it by a fraction of an FX
 *      rate, not by the rate itself. A ratio heuristic would look authoritative
 *      and essentially never fire. Check 1 is the per-position detector, and it
 *      is the one that actually found this.
 *
 * Run:  node dist/scripts/valuation-audit.js [--tolerance 0.02] [--json]
 * Exit:  0 clean · 1 findings · 2 could not run (never reports "clean" on error)
 */
import { and, eq, sql } from "drizzle-orm"
import { getDb, closeDb } from "../db/index.js"
import { portfolios, portfolioTransactions, positions, valueSnapshots } from "../db/schema.js"
import { resolveServiceToken, fxTo } from "../services/instruments-fx.js"
import { splitPortfolioValue } from "../services/valuation.js"
import { cashBalances } from "../services/cashLedger.js"

/** A live/stored divergence above this fraction of the stored value is reported. */
const DEFAULT_TOLERANCE = 0.02
export interface CurrencyFinding {
  kind: "currency-mismatch"
  portfolioId: string
  portfolioName: string
  symbol: string
  storedCurrency: string
  transactionCurrencies: string[]
}

export interface ReconciliationFinding {
  kind: "reconciliation-gap"
  portfolioId: string
  portfolioName: string
  snapshotDate: string
  storedValue: number
  liveValue: number
  delta: number
  deltaPct: number
}

export type Finding = CurrencyFinding | ReconciliationFinding

/**
 * Pure comparison, exported so the rules are testable without a database.
 *
 * The audit REPORTS and never rewrites. Correcting a currency here would repeat
 * the very defect it exists to catch: the right value is a claim about which
 * source to believe, and this function is deliberately not in a position to make
 * it.
 */
export function findCurrencyMismatches(
  rows: Array<{ portfolioId: string; portfolioName: string; symbol: string; storedCurrency: string; transactionCurrencies: string[] }>,
): CurrencyFinding[] {
  return rows
    .filter((r) => {
      const stored = (r.storedCurrency ?? "").trim().toUpperCase()
      const seen = new Set(r.transactionCurrencies.map((c) => c.trim().toUpperCase()).filter(Boolean))
      // Only a genuine contradiction counts. A position with no currency-bearing
      // trade history cannot be checked and says nothing either way.
      //
      // Partial disagreement counts too: a position reading PLN against trades in
      // PLN *and* EUR is just as inconsistent as one matching none of them, and
      // is the more interesting case to look at by hand.
      if (stored === "" || seen.size === 0) return false
      return [...seen].some((c) => c !== stored)
    })
    .map((r) => ({
      kind: "currency-mismatch" as const,
      portfolioId: r.portfolioId,
      portfolioName: r.portfolioName,
      symbol: r.symbol,
      storedCurrency: (r.storedCurrency ?? "").trim().toUpperCase(),
      transactionCurrencies: [...new Set(r.transactionCurrencies.map((c) => c.trim().toUpperCase()))].sort(),
    }))
}

export function findReconciliationGaps(
  rows: Array<{
    portfolioId: string
    portfolioName: string
    snapshotDate: string
    storedValue: number
    liveValue: number
    tolerance?: number
  }>,
): ReconciliationFinding[] {
  const out: ReconciliationFinding[] = []
  for (const r of rows) {
    if (!(r.storedValue > 0)) continue // a zero baseline has no ratio to judge
    const delta = r.liveValue - r.storedValue
    const deltaPct = delta / r.storedValue
    if (Math.abs(deltaPct) <= (r.tolerance ?? DEFAULT_TOLERANCE)) continue
    out.push({
      kind: "reconciliation-gap",
      portfolioId: r.portfolioId,
      portfolioName: r.portfolioName,
      snapshotDate: r.snapshotDate,
      storedValue: r.storedValue,
      liveValue: r.liveValue,
      delta,
      deltaPct,
    })
  }
  return out
}

/** Positions whose currency disagrees with the currency on their own trades. */
export async function auditCurrencies(db: Awaited<ReturnType<typeof getDb>>) {
  return db
    .select({
      portfolioId: positions.portfolioId,
      portfolioName: portfolios.name,
      symbol: positions.symbol,
      storedCurrency: positions.instrumentCurrency,
      transactionCurrencies: sql<string[]>`array_agg(distinct ${portfolioTransactions.instrumentCurrency})`,
    })
    .from(positions)
    .innerJoin(portfolios, eq(positions.portfolioId, portfolios.id))
    .innerJoin(
      portfolioTransactions,
      and(
        eq(portfolioTransactions.portfolioId, positions.portfolioId),
        eq(portfolioTransactions.instrumentSymbol, positions.symbol),
      ),
    )
    .where(eq(positions.isOpen, true))
    .groupBy(positions.id, portfolios.name)
    .then((rows) => findCurrencyMismatches(rows as never))
}

/** Live valuation vs the stored snapshot for the same day, per portfolio. */
export async function auditReconciliation(
  db: Awaited<ReturnType<typeof getDb>>,
  authToken: string,
  tolerance: number,
) {
  const pfs = await db.select().from(portfolios)
  const out: ReconciliationFinding[] = []

  for (const p of pfs) {
    const base = p.baseCurrency.toUpperCase()
    // strict:false — this is a report. An unresolvable rate must degrade to a
    // visible wrong-looking number we then flag, not abort the whole audit.
    const toBase = await fxTo(authToken, base, new Map(), { strict: false })
    const posRows = await db
      .select({
        marketValue: positions.marketValue,
        quantity: positions.quantity,
        averageCostBasis: positions.averageCostBasis,
        instrumentCurrency: positions.instrumentCurrency,
      })
      .from(positions)
      .where(and(eq(positions.portfolioId, p.id), eq(positions.isOpen, true)))

    const split = await splitPortfolioValue(toBase, posRows, await cashBalances(db, authToken, p.id))
    if (split.unpricedPositions > 0) continue // an incomplete total cannot be compared

    // The most recent stored day: a snapshot for "today" only exists once
    // something has written one, and comparing against a stale day would flag
    // ordinary market movement as a defect.
    const [snap] = await db
      .select({ snapshotDate: valueSnapshots.snapshotDate, value: valueSnapshots.value })
      .from(valueSnapshots)
      .where(eq(valueSnapshots.portfolioId, p.id))
      .orderBy(sql`${valueSnapshots.snapshotDate} desc`)
      .limit(1)
    if (!snap) continue

    out.push(
      ...findReconciliationGaps(
        [
          {
            portfolioId: p.id,
            portfolioName: p.name,
            snapshotDate: String(snap.snapshotDate).slice(0, 10),
            storedValue: Number(snap.value),
            liveValue: split.totalValue,
            tolerance,
          },
        ],
      ),
    )
  }
  return out
}

async function main() {
  const argv = process.argv.slice(2)
  const toleranceArg = argv.indexOf("--tolerance")
  const tolerance = toleranceArg >= 0 ? Number(argv[toleranceArg + 1]) : DEFAULT_TOLERANCE
  const asJson = argv.includes("--json")

  const db = await getDb()
  try {
    // The sweep has no user identity, so it authenticates as a service (§63.10).
    const token = resolveServiceToken()
    const findings: Finding[] = [
      ...(await auditCurrencies(db)),
      ...(await auditReconciliation(db, token, tolerance)),
    ]

    if (asJson) {
      console.log(JSON.stringify({ tolerance, findings }, null, 2))
    } else if (findings.length === 0) {
      console.log(`[valuation-audit] clean — no currency or reconciliation findings (tolerance ${(tolerance * 100).toFixed(1)}%)`)
    } else {
      for (const f of findings) {
        if (f.kind === "currency-mismatch") {
          console.log(
            `[valuation-audit] CURRENCY pf=${f.portfolioName} ${f.symbol}: position says ${f.storedCurrency}, ` +
              `its transactions say ${f.transactionCurrencies.join("/")} — a currency discrepancy multiplies this ` +
              `position's value by the FX factor.`,
          )
        } else {
          console.log(
            `[valuation-audit] RECONCILE pf=${f.portfolioName} ${f.snapshotDate}: stored ${f.storedValue.toFixed(2)} ` +
              `vs live ${f.liveValue.toFixed(2)} (${(f.deltaPct * 100).toFixed(1)}%) — ` +
              `check the CURRENCY findings above first: one mislabelled position moves a ` +
              `portfolio total by its FX factor without looking wrong.`,
          )
        }
      }
      console.log(`[valuation-audit] ${findings.length} finding(s). Nothing was modified.`)
    }
    // 2, not 0, when the audit itself could not run: an audit that cannot check
    // must never be mistaken for an audit that found nothing.
    process.exit(findings.length > 0 ? 1 : 0)
  } catch (e) {
    console.error(`[valuation-audit] could not run: ${e instanceof Error ? e.message : String(e)}`)
    process.exit(2)
  } finally {
    await closeDb()
  }
}

if (process.argv[1]?.endsWith("valuation-audit.js") || process.argv[1]?.endsWith("valuation-audit.ts")) {
  void main()
}
