import type { Hono } from "hono"
import { createTestDb } from "../db/test-db.js"
import type { DB } from "../db/index.js"

export interface Harness {
  db: DB
  app: Hono
  headers: Record<string, string>
  /** Identity used for X-User-* fallback auth; change + reuse `headers`. */
  user: { id: string; email: string }
}

/** Compose-style harness: isolated PGlite db + X-User-* identity headers. */
export async function makeHarness(userId = "user-1"): Promise<Harness> {
  const { db } = await createTestDb()
  return {
    db,
    headers: { "X-User-Id": userId, "X-User-Email": `${userId}@test.dev` },
    user: { id: userId, email: `${userId}@test.dev` },
  } as never
}
