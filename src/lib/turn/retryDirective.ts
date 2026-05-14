import { ValidationGateFailure } from "@/lib/llm/parseAssistantResponse";

/**
 * Build a human-readable retry directive for a failed turn.
 *
 * Why this exists: by default `executeTurn` surfaces Zod's raw issue-list
 * JSON as the retry message. Free-tier Cerebras models (notably
 * `llama3.1-8b`) interpret that JSON conversationally — they reply with
 * "please provide a valid input" prose instead of treating it as
 * compiler-style feedback. Wrapping the issues in imperative prose and
 * re-attaching the schema flips the framing back to "fix your last
 * reply", which the same models actually act on.
 *
 * Two failure modes are handled:
 *   1. JSON.parse failed — the model returned text that's not JSON at all.
 *      Detected by the `did not parse as JSON` prefix that
 *      `executeTurn.parseAndValidate` writes onto its `ValidationGateFailure`.
 *   2. Zod schema validation failed — the JSON parsed but the shape was
 *      wrong. The detail is Zod's full issue list as a JSON string; we
 *      flatten it to a `- field {path}: {message}` bullet list.
 *
 * The schema is re-attached in both cases so the model doesn't have to
 * scroll back to the original user message to recall the shape.
 */

/** Wire shape: a single entry from Zod's `error.issues`. */
interface ZodIssueLike {
  readonly path?: readonly (string | number)[];
  readonly message?: string;
}

/**
 * Try to parse a Zod error-message JSON string into a flat bullet list of
 * field paths and messages. Returns `null` on any parse failure so the
 * caller can fall back to verbatim emission.
 */
function summariseZodIssues(detail: string): string | null {
  // Local try/catch isolates parse failure without `let` reassignment.
  const parsed = (() => {
    try {
      return JSON.parse(detail) as unknown;
    } catch {
      return null;
    }
  })();
  if (!Array.isArray(parsed)) return null;
  const issues = parsed as readonly ZodIssueLike[];
  if (issues.length === 0) return null;
  // Compact one-per-line. Use `<root>` for top-level shape mismatches
  // where `path` is empty (Zod emits `[]` for the root object itself).
  return issues
    .map((iss) => {
      const path = Array.isArray(iss.path) && iss.path.length > 0 ? iss.path.join(".") : "<root>";
      const msg = typeof iss.message === "string" ? iss.message : "(no message)";
      return `- field ${path}: ${msg}`;
    })
    .join("\n");
}

/**
 * Build the retry directive string the model will see verbatim on the
 * next attempt. `schemaJson` is the same JSON-Schema body inlined in the
 * user envelope on the original turn — re-attaching it here means the
 * model has the contract right above its retry without scrollback.
 */
export function buildRetryDirective(err: ValidationGateFailure, schemaJson: string): string {
  // JSON.parse-failure branch — `parseAndValidate` writes this exact prefix.
  if (err.detail.toLowerCase().includes("did not parse as json")) {
    return [
      "Your previous response did not parse as JSON. Reply with a single JSON object — no prose, no Markdown fences, no leading commentary.",
      "",
      "Here is the schema your reply must match. Emit exactly one JSON object matching this schema:",
      `<response_schema>\n${schemaJson}\n</response_schema>`,
    ].join("\n");
  }
  // Zod-validation-failure branch — detail is Zod's issue-list JSON string.
  const summary = summariseZodIssues(err.detail);
  const issuesBlock =
    summary !== null
      ? `The decoded JSON had these issues, listed by field path:\n${summary}`
      : // Fallback: surface the raw detail if it wasn't parseable Zod JSON.
        `The decoded JSON failed validation: ${err.detail}`;
  return [
    "Your previous response did not match the required JSON schema.",
    issuesBlock,
    "",
    "Here is the schema your reply must match. Emit exactly one JSON object matching this schema, with no surrounding prose:",
    `<response_schema>\n${schemaJson}\n</response_schema>`,
  ].join("\n");
}
