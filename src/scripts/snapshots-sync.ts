// Scheduled additive snapshot refresh (2026-09-27).
//
// Cron job (wallets HelmRelease `snapshotssync` + `snapshotssync-postfx`): for
// EVERY portfolio, upsert value_snapshots for [first trade, TODAY] — never
// deletes, so a failed/slow pass can't blank a chart. Extends past the normal
// backfill window (yesterday) so the last two days are re-valued: FX for a fresh
// date is unknown until the ECB publish (~16:00 CET, fxsync 17:10 UTC) and
// can still shift the converted value. Runs after fxsync.
//
// The per-portfolio passes are serialized by the shared backfill runner
// (one at a time — same guard as the analytics-triggered backfills), and
// `enqueueBackfill` coalesces to one slot per portfolio.
//
// §63.10 — the credential. This job is not a user: it iterates every portfolio of
// every user, so it has no single user identity to present and a user JWT is the
// wrong credential for it by construction. It authenticates with the
// INSTRUMENTS_SERVICE_TOKEN shared secret, which instruments' serviceOrUserMiddleware
// accepts in place of a user JWT (instruments/src/auth.ts). The previous version
// of this file passed an empty string on the belief — stated in its own comment —
// that instruments' /internal/fx-rates endpoint was unauthenticated. It is not,
// so every price-bars and FX call 401'd, the backfill dropped every position, and
// the pass wrote cash-only values over correct ones twice a day for the whole
// fleet. `main` now fails fast when the token is missing rather than running a
// pass that cannot price anything.
//
// Manual recompute (POST /:id/recompute, default mode) still does a FULL
// delete+rebuild (forcePortfolioRecalc); this job is the additive one, and it
// carries the caller's browser JWT rather than the service token.

import { getDb, closeDb } from "../db/index.js"
import { portfolios } from "../db/schema.js"
import { runBackfillRecent } from "../services/backfill.js"
import { refreshQuotes } from "../services/quotes.js"
import { resolveServiceToken } from "../services/instruments-fx.js"

async function main() {
  // Before touching the DB: a pass that cannot price is refused by the write
  // guard, so failing here is cheaper and clearer than N portfolio failures.
  const token = resolveServiceToken()
  const db = getDb()
  const rows = await db
    .select({ id: portfolios.id, name: portfolios.name, userId: portfolios.userId })
    .from(portfolios)
    .orderBy(portfolios.name)

  console.log(`[snapshotsync] refreshing ${rows.length} portfolios (additive, through today)`)
  let ok = 0
  let failed = 0
  for (const p of rows) {
    try {
      // §70 — PRICE FIRST, then snapshot.
      //
      // This job used to call only `runBackfillRecent`, so nothing in the
      // scheduled pipeline ever wrote `positions.market_value`. The only writer
      // was `refreshQuotes`, which ran whenever a user OPENED a portfolio. So
      // after any re-import every position was unpriced, and the aggregate
      // quietly reported each one's COST as its market value — the dashboard
      // understated net worth by ~261k PLN on PROD while looking entirely
      // plausible (two PLN funds sat exactly on their cost to the złoty).
      //
      // §76.1 — since then reads stopped pricing: no GET route calls
      // `refreshQuotes` any more (it survived D58 only in
      // routes/portfolio-transactions.ts, which is where portfolio-open reads
      // positions from). So as of §76.1 this job is not merely the safer writer,
      // it is the ONLY one in the scheduled pipeline, and a portfolio whose
      // prices have gone stale stays stale until this runs or a write
      // re-prices it. `snapshots-sync` is therefore the thing that keeps the
      // dashboard truthful; if this job stops, §76.5's cron-coverage check is
      // what should fail.
      //
      // `refreshQuotes` never throws (instruments errors keep stored values and
      // mark priceSource 'fallback'), so this cannot fail the job. The backfill
      // then values positions off prices that are actually fresh.
      //
      // Reuses the existing writer rather than adding a second one: a second
      // path that populates the same column is how the two drifted in the first
      // place.
      await refreshQuotes(db, p.userId, p.id, token)
      console.log(`[snapshotsync] ${p.name} (${p.id}) priced`)
      // Resolves when the serialized pass has been consumed. Rejections are
      // swallowed by runBackfillCore (status → 'failed'), so a credential or
      // transport problem shows up in portfolio_backfill_metadata, not here.
      await runBackfillRecent(db, p.id, token)
      ok++
      console.log(`[snapshotsync] ${p.name} (${p.id}) ok`)
    } catch (err) {
      failed++
      console.error(`[snapshotsync] ${p.name} (${p.id}) failed:`, err)
    }
  }
  console.log(`[snapshotsync] done: ok=${ok} failed=${failed}`)
  await closeDb()
  if (failed > 0) process.exitCode = 1
}

main().catch(async (err) => {
  console.error("[snapshotsync] fatal:", err)
  process.exit(1)
})
