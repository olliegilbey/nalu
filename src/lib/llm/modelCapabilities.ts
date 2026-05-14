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
};

/**
 * Return capability flags for the given model name.
 *
 * Unknown model names default to `{ honorsStrictMode: true }` — we assume
 * support and let only explicitly weak models opt out. This is conservative:
 * a new honouring model gets correct behaviour without a registry entry.
 * A new weak model that is not yet registered will have `response_format`
 * sent unnecessarily, but the inline schema fallback in the prompt prevents
 * silently broken output (the prompt layer still carries the contract).
 *
 * @param modelName - The exact model name string (from `LLM_MODEL` env var or
 *   the provider call). Not normalised — must match a registry key exactly.
 */
export function getModelCapabilities(modelName: string): ModelCapabilities {
  return MODEL_CAPABILITIES[modelName] ?? { honorsStrictMode: true };
}
