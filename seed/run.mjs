import { seed } from "../dist/db/seed.js"
import { seedPortfolios } from "../dist/db/portfolio-seed.js"

const dbUrl =
  process.env.DATABASE_URL || "postgres://portfoliost:portfoliost@localhost:5432/portfoliost"

const skipPortfolios = process.env.SEED_PORTFOLIOS === "false"

// Sequential: the portfolio seed's insert references the seeded wallet via
// FK (portfolios.wallet_id), so the wallet must be committed first.
const walletDone = await seed(dbUrl)
const portfolioDone = skipPortfolios ? false : await seedPortfolios(dbUrl)

console.log(walletDone ? "[wallets] seeded parity wallet + transactions" : "[wallets] seed skipped (data exists)")
if (!skipPortfolios) {
  console.log(portfolioDone ? "[portfolios] seeded parity Top10 portfolio" : "[portfolios] seed skipped (data exists)")
}
