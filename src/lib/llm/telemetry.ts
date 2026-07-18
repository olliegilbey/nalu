import type { TelemetrySettings } from "ai";

/**
 * Per-call `experimental_telemetry` settings for every LLM call, gated by
 * `LLM_TELEMETRY=true` and stage-labelled via `functionId` (e.g. "wave-mid",
 * "clarify") so traces group by pipeline stage.
 *
 * Reads `process.env` directly instead of `getEnv()`: unit tests call the
 * LLM wrappers with mock models and no full env, and this helper must not
 * force whole-schema env validation onto that path.
 *
 * Inputs/outputs contain learner content — keep them out of traces until a
 * deliberate decision says otherwise; spans still carry timing, tokens,
 * model, and retries.
 */
export function llmTelemetry(functionId: string): TelemetrySettings {
  return {
    isEnabled: process.env.LLM_TELEMETRY === "true",
    functionId,
    recordInputs: false,
    recordOutputs: false,
  };
}
