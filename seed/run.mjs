import { seed } from "../dist/db/seed.js"
import { seedPortfolios } from "../dist/db/portfolio-seed.js"

const dbUrl =
  process.env.DATABASE_URL || "postgres://portfoliost:portfoliost@localhost:5432/portfoliost"

const skipPortfolios = process.env.SEED_PORTFOLIOS === "false"

Promise.all([
  seed(dbUrl),
  skipPortfolios ? Promise.resolve(false) : seedPortfolios(dbUrl),
])
  .then(([walletDone, portfolioDone]) => {
    console.log(walletDone ? "[wallets] seeded parity wallet + transactions" : "[wallets] seed skipped (data exists)")
    if (!skipPortfolios) {
      console.log(portfolioDone ? "[portfolios] seeded parity Top10 portfolio" : "[portfolios] seed skipped (data exists)")
    }
  })
  .catch((err) => {
    console.error("Seed failed:", err)
    process.exit(1)
  })
