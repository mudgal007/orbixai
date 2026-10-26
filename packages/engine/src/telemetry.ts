import type { IncomingMessage } from "node:http";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { ExpressInstrumentation } from "@opentelemetry/instrumentation-express";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import { PrismaInstrumentation } from "@prisma/instrumentation";

export interface Telemetry {
  enabled: boolean;
  shutdown: () => Promise<void>;
}

/** Requests whose URLs carry one-time secrets (OAuth code/state) or are pure noise are not traced. */
export function shouldIgnoreIncoming(url: string | undefined): boolean {
  if (!url) return false;
  return url.startsWith("/v1/oauth/") || url.startsWith("/v1/health") || url.startsWith("/v1/webhooks/");
}

/**
 * Starts OpenTelemetry tracing (HTTP, Express, Prisma + ORBIX engine spans) when an OTLP endpoint is
 * configured via the standard OTEL_EXPORTER_OTLP_ENDPOINT / OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
 * variables. Without one it does nothing and the engine's spans are no-ops.
 * Must be called before the rest of the app is imported so instrumentations can patch modules.
 */
export function startTelemetry(serviceName: string, env: NodeJS.ProcessEnv = process.env): Telemetry {
  if (!env.OTEL_EXPORTER_OTLP_ENDPOINT && !env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) {
    return { enabled: false, shutdown: async () => undefined };
  }
  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: env.OTEL_SERVICE_NAME ?? serviceName,
      [ATTR_SERVICE_VERSION]: env.npm_package_version ?? "0.1.0",
      "deployment.environment": env.NODE_ENV ?? "development",
    }),
    traceExporter: new OTLPTraceExporter(),
    instrumentations: [
      new HttpInstrumentation({ ignoreIncomingRequestHook: (req: IncomingMessage) => shouldIgnoreIncoming(req.url) }),
      new ExpressInstrumentation(),
      new PrismaInstrumentation(),
    ],
  });
  sdk.start();
  return { enabled: true, shutdown: () => sdk.shutdown() };
}
