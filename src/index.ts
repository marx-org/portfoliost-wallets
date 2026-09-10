import { Hono } from "hono"
import { pino } from "pino"

import { validateJwt } from "./auth.js"
import { createWalletRoutes } from "./routes/wallets.js"
import { createMovementRoutes } from "./routes/movements.js"
import { createTransactionRoutes } from "./routes/transactions.js"
import { createHistoryRoutes } from "./routes/history.js"
import { createRegistryRoutes } from "./routes/registry.js"
import { createAdminRoutes } from "./routes/admin.js"
import { createPortfolioRoutes } from "./routes/portfolios.js"
import { createPublicShareRoutes } from "./routes/portfolios.js"
import { createCrossPortfolioTransactionsRoute } from "./routes/portfolio-transactions.js"
import { createLabelRoutes } from "./routes/labels.js"
import { createPositionLabelRoutes } from "./routes/position-labels.js"
import { createTransactionLabelRoutes } from "./routes/transaction-labels.js"
import { createWalletTransactionLabelRoutes } from "./routes/wallet-transaction-labels.js"
import { moduleMeta } from "./meta.js"
import { metricsRouteHandler } from "./instrumentation.js"

const app = new Hono()

const log = pino({ base: { service: "portfoliost-wallets" } })
app.use("*", async (c, next) => {
  const start = Date.now()
  await next()
  log.info({
    method: c.req.method,
    path: c.req.path,
    status: c.res.status,
    duration_ms: Date.now() - start,
    request_id: c.req.header("x-request-id") ?? undefined,
  })
})

app.get("/metrics", metricsRouteHandler)

app.get("/health", (c) => c.json({ status: "ok" }))

// D4 — module identity/verification endpoint
app.get("/__meta", (c) => c.json(moduleMeta()))

// D9 — edge auth preflight: 204 when the bearer token validates, 401 otherwise
app.get("/internal/verify", validateJwt, (c) => c.body(null, 204))

const api = new Hono()
const walletsApi = createWalletRoutes()
api.route("/wallets", walletsApi)
api.route("/wallets", createMovementRoutes())
api.route("/wallets/transactions", createTransactionRoutes())
api.route("/wallets", createHistoryRoutes())
// registry: /api/currencies (public) + /api/internal/fx-rates (D20/D26)
api.route("/", createRegistryRoutes())
// D47 — admin-facing FX rates endpoint
api.route("/admin", createAdminRoutes())

// §15 — portfolio management (D53–D64)
// D2: cross-portfolio transaction feed (must be mounted before portfolio routes to avoid /:id collision)
api.route("/portfolios/transactions", createCrossPortfolioTransactionsRoute())
api.route("/portfolios", createPortfolioRoutes())
// G3: public share view (auth-exempt) — mounted at /portfolios/public to avoid auth middleware
api.route("/portfolios/public", createPublicShareRoutes())

// D65–D68 — labels
api.route("/labels", createLabelRoutes())
api.route("/positions", createPositionLabelRoutes())
api.route("/portfolios", createTransactionLabelRoutes())
api.route("/wallets", createWalletTransactionLabelRoutes())

app.route("/api", api)

export default app
