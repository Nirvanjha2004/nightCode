import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { SemanticResourceAttributes } from "@opentelemetry/semantic-conventions";
import { trace, SpanStatusCode, type Span } from "@opentelemetry/api";
export const tracer = trace.getTracer("nightcode");

/**
 * Marks a span as failed per our error-handling convention:
 * record the exception, emit an "Exception occurred" event, and set ERROR status.
 * Call from a catch block; the caller rethrows and ends the span in a finally block.
 */
export function markSpanError(span: Span, error: unknown): void {
    span.recordException(error as Error);
    span.addEvent("Exception occurred");
    span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
    });
}

const sdk = new NodeSDK({
    resource: resourceFromAttributes({
        [SemanticResourceAttributes.SERVICE_NAME]: "nightcode",
        [SemanticResourceAttributes.SERVICE_VERSION]: "0.1.0",
        [SemanticResourceAttributes.DEPLOYMENT_ENVIRONMENT]: "development",
    }),

    traceExporter: new OTLPTraceExporter({
        url: "http://localhost:4318/v1/traces",
    }),
});

sdk.start();

async function shutdown() {
    try {
        await sdk.shutdown();
        console.log("[Telemetry] SDK shut down successfully");
    } catch (err) {
        console.error("[Telemetry] Error shutting down SDK", err);
    } finally {
        process.exit(0);
    }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);