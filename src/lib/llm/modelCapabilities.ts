/**
 * Per-model capability flags for the Nalu LLM layer.
 *
 * WHY this exists: Cerebras free-tier llama3.1-8b silently ignores
 * `response_format: { type: "json_schema", strict: true }` and emits
 * free-form JSON that may not match the declared schema. Stronger models
 * (llama-3.3-70b and above) honour strict-mode constrained decoding.
 *
 * Consequence: we gate two distinct mechanisms on `honorsStrictMode`:
 *   1. Wire-side `response_format` — only sent to honouring models. Sending
 *      it to a model that ignores it wastes tokens and obscures the contract.
 *   2. Inline `<response_schema>` in the user envelope — only sent to
 *      non-honouring models. Honouring models get the schema via the wire;
 *      duplicating it would waste ~3-5 KB per turn.
 */

/** Capability flags returned for a given model name. */
export interface ModelCapabilities {
  /**
   * True if the model correctly enforces `response_format.strict = true`
   * constrained decoding. False means the model silently emits free-form JSON
   * regardless of the `response_format` field — the inline schema is needed.
   */
  readonly honorsStrictMode: boolean;
}

/**
 * Known-model capability registry. Keyed by the exact model name string that
 * appears in `LLM_MODEL` (or the provider chatModel call). Case-sensitive —
 * do not normalise; the provider uses the string verbatim.
 *
 * Each entry includes a WHY comment because the rationale is empirical, not
 * derivable from the model name alone.
 */
const MODEL_CAPABILITIES: Readonly<Record<string, ModelCapabilities>> = {
  /**
   * Cerebras free-tier floor model. Empirically ignores
   * `response_format: { type: "json_schema", strict: true }` — emits
   * free-form JSON that fits the schema most of the time but occasionally
   * drifts. Inline `<response_schema>` in the user envelope is the
   * mitigation used by the scoping prompts.
   *
   * Cerebras sunsets this model on 2026-05-27; see memory/llama_8b_deprecation.md.
   */
  "llama3.1-8b": { honorsStrictMode: false },

  /**
   * Cerebras 70B model. Correctly enforces strict-mode constrained decoding.
   * The inline schema block is omitted for this model to save prompt tokens.
   */
  "llama-3.3-70b": { honorsStrictMode: true },

  /**
   * Cerebras preview 235B model (Qwen 3 Instruct). Supports strict-mode
   * `response_format` constrained decoding, so the inline `<response_schema>`
   * block is omitted to save prompt tokens.
   *
   * Current default for `just smoke` (see justfile). Picked because the
   * llama3.1-8b 8192-token ceiling overruns on the close-scoping turn once
   * the conversation accrues all four stage envelopes; qwen has headroom.
   *
   * Cerebras sunsets this model on 2026-05-27 — same cliff as llama3.1-8b.
   * Re-audit free-tier availability before that date. See
   * memory/project_llama_8b_deprecation.md.
   */
  "qwen-3-235b-a22b-instruct-2507": { honorsStrictMode: true },
};

/**
 * Return capability flags for the given model name.
 *
 * Unknown model names default to `{ honorsStrictMode: false }` — the safer
 * direction. An unknown model is *more* likely to silently ignore
 * `response_format` than to enforce it (the failure mode this gating exists
 * to mitigate). Defaulting to `false` causes the inline `<response_schema>`
 * block to be added, which strong models simply parse and ignore (a few KB
 * of wasted tokens); the opposite mistake — assuming strict support and
 * losing both enforcement paths — produces schema-non-conformant output and
 * avoidable retry exhaust. New honouring models must be added to the
 * registry explicitly to drop the inline block.
 *
 * @param modelName - The exact model name string (from `LLM_MODEL` env var or
 *   the provider call). Not normalised — must match a registry key exactly.
 */
export function getModelCapabilities(modelName: string): ModelCapabilities {
  return MODEL_CAPABILITIES[modelName] ?? { honorsStrictMode: false };
}
