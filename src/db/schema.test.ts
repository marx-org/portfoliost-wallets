import { describe, expect, it } from "vitest"
import { sql } from "drizzle-orm"
import { createTestDb } from "./test-db.js"
import { walletsSchema } from "./schema.js"

describe("wallets schema", () => {
  it("exposes the dedicated pg schema object per D6", () => {
    expect(walletsSchema).toBeDefined()
  })

  it("migrations apply cleanly on a fresh database", async () => {
    // empty journal for now; first real migration creates the schema
    await expect(createTestDb()).resolves.toBeTruthy()
  })
})
