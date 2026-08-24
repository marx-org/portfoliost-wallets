import { drizzle } from "drizzle-orm/postgres-js"
import type { PgDatabase } from "drizzle-orm/pg-core"
import postgres from "postgres"
import * as schema from "./schema.js"

// Accepts any pg-dialect drizzle instance (postgres-js in prod, PGlite in tests).
export type DB = PgDatabase<any, any, any>

let _client: postgres.Sql | null = null
let _db: ReturnType<typeof drizzle<typeof schema>> | null = null

export const DEFAULT_DATABASE_URL =
  "postgres://portfoliost:portfoliost@localhost:5432/portfoliost"

export function getDb() {
  if (!_db) {
    _client = postgres(process.env.DATABASE_URL || DEFAULT_DATABASE_URL, { max: 10 })
    _db = drizzle(_client, { schema })
  }
  return _db
}

export async function closeDb() {
  if (_client) {
    await _client.end()
    _client = null
    _db = null
  }
}
