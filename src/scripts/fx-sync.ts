/**
 * FX sync entrypoint (D25): `npm run fx:sync` — daily incremental import.
 * Cluster CronJob wraps this; compose can run it manually.
 */
import { closeDb, getDb } from "../db/index.js"
import { syncDaily } from "../services/fx-import.js"

async function main() {
  const db = getDb()
  const count = await syncDaily(db)
  console.log(`[wallets] fx sync ok: ${count} rate rows in window`)
  await closeDb()
}

main().catch((err) => {
  console.error("[wallets] fx sync failed:", err?.message ?? err)
  process.exit(1)
})
