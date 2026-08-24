import { Hono } from "hono"
import { logger } from "hono/logger"

import { validateJwt } from "./auth.js"
import { createWalletRoutes } from "./routes/wallets.js"
import { moduleMeta } from "./meta.js"

const app = new Hono()

app.use("*", logger())

app.get("/health", (c) => c.json({ status: "ok" }))

// D4 — module identity/verification endpoint
app.get("/__meta", (c) => c.json(moduleMeta()))

// D9 — edge auth preflight: 204 when the bearer token validates, 401 otherwise
app.get("/internal/verify", validateJwt, (c) => c.body(null, 204))

const api = new Hono()
api.route("/wallets", createWalletRoutes())

app.route("/api", api)

export default app
