import { createSdk, buildMetricsRoute } from "@marx2/otel"
import { PrometheusExporter } from "@opentelemetry/exporter-prometheus"
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node"
import { RuntimeNodeInstrumentation } from "@opentelemetry/instrumentation-runtime-node"

export const prometheusExporter = new PrometheusExporter({ preventServerStart: true })

const sdk = createSdk({
  serviceName: "portfoliost-wallets",
  metricReader: prometheusExporter,
  instrumentations: [
    ...getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-fs": { enabled: false },
    }),
    new RuntimeNodeInstrumentation(),
  ],
})

sdk.start()
process.once("beforeExit", async () => { await sdk.shutdown() })

export const metricsRouteHandler = buildMetricsRoute(prometheusExporter)
