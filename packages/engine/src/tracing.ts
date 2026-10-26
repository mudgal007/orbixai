import { SpanStatusCode, trace, type Attributes, type Span } from "@opentelemetry/api";
import { ExecutionError, redact } from "@orbix/core";

// Resolved lazily through the global provider, so spans are no-ops until telemetry is started.
const tracer = trace.getTracer("orbix-engine");

/**
 * Runs `fn` inside an active span. Attributes must be identifiers and metadata only — never inputs,
 * outputs or credentials (those stay in the redacted ToolExecution trace in the database).
 */
export async function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => Promise<T>): Promise<T> {
  return tracer.startActiveSpan(name, { attributes }, async (span) => {
    try {
      return await fn(span);
    } catch (e) {
      if (e instanceof ExecutionError) span.setAttribute("orbix.failure_class", e.failureClass);
      const message = redact(e instanceof Error ? e.message : String(e)).slice(0, 300);
      span.recordException({ name: e instanceof Error ? e.name : "Error", message });
      span.setStatus({ code: SpanStatusCode.ERROR, message });
      throw e;
    } finally {
      span.end();
    }
  });
}
