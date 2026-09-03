import { defineConfig } from "drizzle-kit"

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  migrations: {
    schema: "drizzle_wallets",
  },
  dbCredentials: {
    url: process.env.DATABASE_URL || "postgres://portfoliost:portfoliost@localhost:5432/portfoliost",
  },
})
