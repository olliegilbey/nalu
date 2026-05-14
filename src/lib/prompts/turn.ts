/**
 * Per-turn harness directives — model-facing prose authored by the harness
 * (not by a Zod refine). Kept in `src/lib/prompts/` because it is text the
 * model reads; the `executeTurn` harness consumes the constant and embeds
 * it in a `ValidationGateFailure` on JSON-parse failure.
 */

/**
 * Retry directive when the model's previous response is not valid JSON.
 *
 * Rare under Cerebras strict-mode constrained decoding (the decoder cannot
 * emit non-JSON), but possible when the provider returns text outside the
 * JSON envelope (e.g. a 429-throttling notice or a partial stream). The
 * directive is intentionally short — the inline `<response_schema>` block
 * in the next turn's envelope carries the contract; this just tells the
 * model what went wrong and what to do next.
 */
export const JSON_PARSE_RETRY_DIRECTIVE =
  "Your previous response did not parse as JSON. Reply with a single JSON object matching the schema attached to this turn.";
