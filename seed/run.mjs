import { seed } from "../dist/db/seed.js"

const dbUrl =
  process.env.DATABASE_URL || "postgres://portfoliost:portfoliost@localhost:5432/portfoliost"

seed(dbUrl)
  .then((did) => console.log(did ? "[wallets] seeded parity wallet + transactions" : "[wallets] seed skipped (data exists)"))
  .catch((err) => {
    console.error("[wallets] Seed failed:", err)
    process.exit(1)
  })
