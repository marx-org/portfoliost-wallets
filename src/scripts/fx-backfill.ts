/**
 * FX backfill entrypoint (D25): `npm run fx:backfill` — one-shot historical
 * import since a given date. Defaults to 2019-01-01; pass a date to override.
 * Idempotent via upsert on (rate_date, currency).
 */
import { closeDb, getDb } from "../db/index.js"
import { importHistory } from "../services/fx-import.js"

const start = process.argv[2] ?? "2019-01-01"

async function main() {
  const db = getDb()
  const count = await importHistory(db, { start })
  console.log(`[wallets] fx backfill ok: ${count} rate rows since ${start}`)
  await closeDb()
}

main().catch((err) => {
  console.error("[wallets] fx backfill failed:", err?.message ?? err)
  process.exit(1)
})