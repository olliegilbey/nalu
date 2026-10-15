/**
 * Per-turn harness directives — model-facing prose authored by the harness
 * (not by a Zod refine). Kept in `src/lib/prompts/` because it is text the
 * model reads; the turn runners (`executeTurn`, `executeToolTurnStream`)
 * embed these constants in a `ValidationGateFailure`.
 */

/**
 * Retry directive when the model's previous response is not valid JSON.
 *
 * Rare under Cerebras strict-mode constrained decoding (the decoder cannot
 * emit non-JSON), but possible when the provider returns text outside the
 * JSON envelope (e.g. a 429-throttling notice or a partial stream). The
 * directive is intentionally short — the wire-side `response_format` carries
 * the schema contract; this just tells the model what went wrong and what to
 * do next.
 */
export const JSON_PARSE_RETRY_DIRECTIVE =
  "Your previous response did not parse as JSON. Reply with a single JSON object matching the schema attached to this turn.";

/**
 * Retry directive when a tool-loop Step hit the output cap
 * (`LLM.maxToolStepOutputTokens`, issue #181). The cut-off reply replays as
 * an empty message, so this text is all the model learns of it. Seen live
 * as a runaway quiz tool call, so it names the tool-call input. It does not
 * ask for shorter prose: no cut has come from prose, and that ask could
 * thin out the retry's teaching.
 */
export const OUTPUT_TRUNCATED_RETRY_DIRECTIVE =
  "Your previous reply hit the output length limit and was cut off, so it was discarded. Write this turn again, more concisely: keep your reasoning focused and keep every tool call's input compact.";

/**
 * Wrap a retry directive in the Harness-owned `<harness_feedback>` tag.
 *
 * Directives ride in user-role rows, beside learner text. Both system
 * prompts name this tag as Harness text to follow (issue #123). Learner text
 * is always escaped, so no learner can forge it. Both turn runners apply it
 * to every new `harness_retry_directive` row. Older rows keep their bytes.
 */
export function renderHarnessFeedback(directive: string): string {
  return `<harness_feedback>\n${directive}\n</harness_feedback>`;
}
