import { registerOTel } from "@vercel/otel";

/**
 * Next.js instrumentation hook — registers the OTel SDK once per server boot.
 *
 * Without an exporter configured this is near-zero overhead: spans are
 * created but go nowhere until an OTLP endpoint is set via the standard
 * `OTEL_EXPORTER_OTLP_*` env vars (deployment concern — see
 * "Observability" in docs/DEPLOY.md for the verified Vercel env recipe).
 * LLM spans themselves are gated per-call by `LLM_TELEMETRY`
 * (src/lib/llm/telemetry.ts).
 */
export function register() {
  registerOTel({ serviceName: "nalu" });
}
