import { z } from "zod/v4";
import type { ValidationGateFailure } from "@/lib/turn/validationGateFailure";

/**
 * Heuristic post-mortem for `ValidationGateFailure` during live smoke.
 *
 * Under JSON-everywhere all parse failures fall into a small set:
 *   1. Non-JSON response — directive starts with "Your previous response did not parse as JSON".
 *   2. Missing required field — Zod error mentions a field path.
 *   3. Refine failure — the shape parsed; only `.refine` / `.superRefine` rules broke.
 *   4. Wrong stage payload — a top-level key is missing and the body's keys belong to a stage.
 *   5. Shape failure — list the Zod issues; any other detail gets a short gloss.
 */

// `ZodError.message` is the issue list as JSON. The detail is our own string,
// but JSON.parse yields `unknown`, so narrow it with Zod.
const zodIssueListSchema = z
  .array(
    z.object({
      code: z.string(),
      path: z.array(z.union([z.string(), z.number()])),
      message: z.string(),
    }),
  )
  .min(1);

// Each signature is the *leaf* key name we expect to see quoted in the JSON
// body — pre-flattened so the scoring loop is a plain `includes` check and
// avoids chained string ops that trip typed-lint rules.
const STAGE_KEY_SIGNATURES: Record<string, readonly string[]> = {
  clarify: ["questions", "freetextRubric"],
  framework: ["tiers", "estimatedStartingTier", "baselineScopeTiers"],
  baseline: ["questions", "conceptName", "tier", "correct"],
  "grade-baseline": ["gradings", "verdict", "qualityScore"],
};

// Minimum unique signature hits before we'll commit to a stage guess.
const STAGE_MATCH_THRESHOLD = 2;

function tryParseJson(raw: string): unknown | null {
  // Local helper so the caller stays `const`-only (no `let` for try/catch result).
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function detectStageFromBody(raw: string): string | null {
  // Cheap JSON probe — if the response parses, count unique signature
  // hits per stage. Highest score (≥ threshold) wins.
  const parsed = tryParseJson(raw);
  if (parsed === null) return null;
  const haystack = JSON.stringify(parsed);
  const scored = Object.entries(STAGE_KEY_SIGNATURES).map(([stage, sigs]) => {
    const score = sigs.filter((sig) => haystack.includes(`"${sig}"`)).length;
    return { stage, score };
  });
  const best = scored.reduce<{ stage: string; score: number }>(
    (acc, cur) => (cur.score > acc.score ? cur : acc),
    { stage: "", score: 0 },
  );
  return best.score >= STAGE_MATCH_THRESHOLD ? best.stage : null;
}

/** Map a {@link ValidationGateFailure} + raw model output to a one-line operator diagnosis. */
export function diagnoseFailure(err: ValidationGateFailure, raw: string): string {
  const detail = err.detail;

  // (1) Non-JSON.
  if (detail.toLowerCase().includes("did not parse as json")) {
    return "model returned text that is not valid JSON — check for stray prose outside the JSON envelope.";
  }

  // (2) Missing userMessage — every stage requires it.
  if (detail.includes("userMessage") && detail.toLowerCase().includes("required")) {
    return "response is missing the required `userMessage` field — every turn must include it.";
  }

  // Past the JSON check, the detail is always Zod's issue list. Anything else
  // gets the short gloss.
  const issues = zodIssueListSchema.safeParse(tryParseJson(detail));
  if (!issues.success) {
    return `gate '${err.reason}' tripped — see retry directive below.`;
  }
  // `<root>` matches retryDirective.ts for an issue with no path.
  const listed = issues.data
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "<root>"}: ${issue.message}`)
    .join("; ");

  // (3) Refine failure. Zod emits `custom` issues only from refines, and a
  // type error aborts refines. An all-custom list means the body fit this
  // turn's shape, so name the rules it broke instead of guessing a stage.
  if (issues.data.every((issue) => issue.code === "custom")) {
    return `body has the right shape but broke a schema rule — ${listed}`;
  }

  // (4) Wrong-stage detection. The stage guess reads only the body's keys, so
  // a right-stage body always matches its own stage. Trust the guess only when
  // a top-level key is missing or mistyped: `invalid_type` at a one-segment
  // path (issue #130).
  const topLevelKeyBroken = issues.data.some(
    (issue) => issue.code === "invalid_type" && issue.path.length === 1,
  );
  const detected = topLevelKeyBroken ? detectStageFromBody(raw) : null;
  if (detected !== null) {
    return `body matches the ${detected} stage schema — model appears to have answered the wrong turn.`;
  }

  // (5) Shape failure on a body that may well be this turn's: list the issues.
  return `body failed the schema — ${listed}`;
}
