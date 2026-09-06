import { Hono } from "hono"
import { and, asc, eq } from "drizzle-orm"
import { z } from "zod"
import { userIdentityMiddleware } from "../auth.js"
import { getDb, type DB } from "../db/index.js"
import { labels } from "../db/schema.js"
import { serializeLabel } from "../services/labels.js"
import type { components } from "../generated/api-types.js"

type Label = components["schemas"]["Label"]

/**
 * D66 — fixed palette of 10 colours (Tailwind `*-500` hexes). Auto-assignment
 * cycles through indices not yet used by the user's existing labels.
 */
export const LABEL_PALETTE = [
  "#64748b", // slate
  "#ef4444", // red
  "#f59e0b", // amber
  "#10b981", // emerald
  "#3b82f6", // blue
  "#a855f7", // purple
  "#ec4899", // pink
  "#06b6d4", // cyan
  "#f97316", // orange
  "#14b8a6", // teal
] as const

export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/

const LabelNameSchema = z.string().trim().min(1).max(40)

export const CreateLabelSchema = z.object({
  name: LabelNameSchema,
  color: z.string().regex(HEX_COLOR, "color must be a hex value like #rrggbb").optional(),
})

export const UpdateLabelSchema = z.object({
  name: LabelNameSchema.optional(),
  color: z.string().regex(HEX_COLOR, "color must be a hex value like #rrggbb").optional(),
})

/**
 * Detect the unique(user_id, name) constraint violation across drivers: the
 * Postgres error sits on `cause` (PGlite) with code 23505, or in the message
 * (node-postgres) with `duplicate key value violates unique constraint`.
 */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { message?: string; cause?: { code?: string; message?: string } }
  if (e?.cause?.code === "23505") return true
  return /duplicate key/i.test(`${e?.message ?? ""} ${e?.cause?.message ?? ""}`)
}

/** D66: next palette index not used by any of the user's existing labels (modulo 10). */
export async function nextPaletteColor(db: DB, userId: string): Promise<string> {
  const rows = await db
    .select({ color: labels.color })
    .from(labels)
    .where(eq(labels.userId, userId))
  const used = new Set(rows.map((r) => r.color.toLowerCase()))
  for (const hex of LABEL_PALETTE) {
    if (!used.has(hex.toLowerCase())) return hex
  }
  return LABEL_PALETTE[rows.length % LABEL_PALETTE.length]
}

export function createLabelRoutes(db?: DB) {
  const routes = new Hono()
  routes.use("*", userIdentityMiddleware)

  const getDbInstance = () => db ?? getDb()

  routes.get("/", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const rows = await database
      .select()
      .from(labels)
      .where(eq(labels.userId, identity.id))
      .orderBy(asc(labels.name))
    return c.json(rows.map(serializeLabel) satisfies Label[])
  })

  routes.post("/", async (c) => {
    const parsed = CreateLabelSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: "ValidationError", message: parsed.error.issues[0]?.message }, 422)
    }
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const color = parsed.data.color ?? (await nextPaletteColor(database, identity.id))
    try {
      const [created] = await database
        .insert(labels)
        .values({ userId: identity.id, name: parsed.data.name, color })
        .returning()
      return c.json(serializeLabel(created) satisfies Label, 201)
    } catch (err) {
      // unique(user_id, name) conflict → same label name already exists
      if (isUniqueViolation(err)) {
        return c.json({ error: "Conflict", message: "A label with that name already exists" }, 409)
      }
      throw err
    }
  })

  routes.patch("/:id", async (c) => {
    const parsed = UpdateLabelSchema.safeParse(await c.req.json().catch(() => ({})))
    if (!parsed.success) {
      return c.json({ error: "ValidationError", message: parsed.error.issues[0]?.message }, 422)
    }
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    const patch: Record<string, unknown> = { updatedAt: new Date() }
    if (parsed.data.name !== undefined) patch.name = parsed.data.name
    if (parsed.data.color !== undefined) patch.color = parsed.data.color
    try {
      // D24: scoped by owner — foreign labels are 404, not 403
      const [updated] = await database
        .update(labels)
        .set(patch)
        .where(and(eq(labels.id, c.req.param("id")), eq(labels.userId, identity.id)))
        .returning()
      if (!updated) {
        return c.json({ error: "NotFound", message: "Label not found" }, 404)
      }
      return c.json(serializeLabel(updated) satisfies Label)
    } catch (err) {
      if (isUniqueViolation(err)) {
        return c.json({ error: "Conflict", message: "A label with that name already exists" }, 409)
      }
      throw err
    }
  })

  routes.delete("/:id", async (c) => {
    const identity = c.get("userIdentity")
    const database = getDbInstance()
    // D24: scoped by owner — foreign labels are 404, not 403
    const [owned] = await database
      .select({ id: labels.id })
      .from(labels)
      .where(and(eq(labels.id, c.req.param("id")), eq(labels.userId, identity.id)))
    if (!owned) {
      return c.json({ error: "NotFound", message: "Label not found" }, 404)
    }
    // FK ON DELETE CASCADE drops all join rows
    await database.delete(labels).where(eq(labels.id, c.req.param("id")))
    return c.body(null, 204)
  })

  return routes
}