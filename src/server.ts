import { serve } from "@hono/node-server"
import app from "./index.js"

const port = parseInt(process.env.PORT ?? "3000", 10)

serve({ fetch: app.fetch, port }, () => {
  console.log(`portfoliost-wallets listening on port ${port}`)
})
