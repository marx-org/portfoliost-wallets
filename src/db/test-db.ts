import { PGlite } from "@electric-sql/pglite"
import { drizzle } from "drizzle-orm/pglite"
import { migrate } from "drizzle-orm/pglite/migrator"
import { fileURLToPath } from "url"
import * as schema from "./schema.js"

export const migrationsFolder = fileURLToPath(new URL("../../drizzle", import.meta.url))

export async function createTestDb() {
  const client = new PGlite()
  const db = drizzle(client, { schema })
  await migrate(db, { migrationsFolder, migrationsSchema: "drizzle_wallets" })
  return { db, client }
}
