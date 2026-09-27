// Scheduled additive snapshot refresh (2026-09-27).
//
// Cron job (wallets HelmRelease `snapshotsync`): for EVERY portfolio,
// upsert value_snapshots for [first trade, TODAY] — never deletes, so a
// failed/slow pass can't blank a chart. Extends past the normal backfill
// window (yesterday) so the last two days are re-valued: FX for a fresh
// date is unknown until the ECB publish (~16:00 CET, fxsync 17:10 UTC) and
// can still shift the converted value. Runs after fxsync.
//
// The per-portfolio passes are serialized by the shared backfill runner
// (one at a time — same guard as the analytics-triggered backfills), and
// `enqueueBackfill` coalesces to one slot per portfolio. No user token is
// needed: the instruments /internal/fx-rates endpoint is unauthenticated.
//
// Manual recompute (POST /:id/recompute, default mode) still does a FULL
// delete+rebuild (forcePortfolioRecalc); this job is the additive one.

import { getDb, closeDb } from "../db/index.js"
import { portfolios } from "../db/schema.js"
import { runBackfillRecent } from "../services/backfill.js"

async function main() {
  const db = getDb()
  const rows = await db
    .select({ id: portfolios.id, name: portfolios.name })
    .from(portfolios)
    .orderBy(portfolios.name)

  console.log(`[snapshotsync] refreshing ${rows.length} portfolios (additive, through today)`)
  let ok = 0
  let failed = 0
  for (const p of rows) {
    try {
      // Resolves when the serialized pass has been consumed.
      await runBackfillRecent(db, p.id, "")
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
