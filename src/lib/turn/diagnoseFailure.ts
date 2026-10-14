import { z } from "zod/v4";
import type { ValidationGateFailure } from "@/lib/turn/validationGateFailure";

/**
 * Heuristic post-mortem for `ValidationGateFailure` during live smoke.
 *
 * Under JSON-everywhere all parse failures fall into a small set:
 *   1. Non-JSON response — directive starts with "Your previous response did not parse as JSON".
 *   2. Missing `userMessage` — Zod reports `invalid_type` at `["userMessage"]`.
 *   3. Refine failure — the shape parsed; only `.refine` / `.superRefine` rules broke.
 *   4. Wrong stage payload — the body's keys fit another stage better than this turn's.
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

// Keyed by the `label` each caller passes to `executeTurn`, so the expected
// stage needs no mapping. Each signature is the *leaf* key name we expect to
// see quoted in the JSON body — pre-flattened so the scoring loop is a plain
// `includes` check and avoids chained string ops that trip typed-lint rules.
// The two close turns share `gradings`, `summary` and `nextUnitBlueprint`;
// their own keys break the tie.
const STAGE_KEY_SIGNATURES = {
  clarify: ["questions", "freetextRubric"],
  framework: ["tiers", "estimatedStartingTier", "baselineScopeTiers"],
  baseline: ["questions", "conceptName", "tier", "correct"],
  "scoping-close": ["gradings", "summary", "nextUnitBlueprint", "immutableSummary", "startingTier"],
  "wave-close": ["gradings", "summary", "nextUnitBlueprint", "conceptUpdates"],
} as const satisfies Record<string, readonly string[]>;

/** A Turn label with a key signature: the stages the diagnosis can tell apart. */
type TurnStage = keyof typeof STAGE_KEY_SIGNATURES;

const isTurnStage = (label: string): label is TurnStage =>
  Object.hasOwn(STAGE_KEY_SIGNATURES, label);

const TURN_STAGES: readonly TurnStage[] = Object.keys(STAGE_KEY_SIGNATURES).filter(isTurnStage);

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

/**
 * The stage whose keys the body fits better than the expected stage's, or
 * null. A right-stage body scores its own stage high even with a key missing,
 * so a rival must beat the expected stage outright (issue #130). A tie means
 * the body fits this turn as well as any other.
 */
function detectRivalStage(raw: string, expected: TurnStage): TurnStage | null {
  const parsed = tryParseJson(raw);
  if (parsed === null) return null;
  const haystack = JSON.stringify(parsed);
  const score = (stage: TurnStage) =>
    STAGE_KEY_SIGNATURES[stage].filter((sig) => haystack.includes(`"${sig}"`)).length;
  const expectedScore = score(expected);
  const rival = TURN_STAGES.filter((stage) => stage !== expected)
    .map((stage) => ({ stage, score: score(stage) }))
    .reduce<{ stage: TurnStage | null; score: number }>(
      (acc, cur) => (cur.score > acc.score ? cur : acc),
      { stage: null, score: 0 },
    );
  return rival.score >= STAGE_MATCH_THRESHOLD && rival.score > expectedScore ? rival.stage : null;
}

/**
 * Map a {@link ValidationGateFailure} + raw model output to a one-line operator
 * diagnosis. `label` is the Turn's `executeTurn` label, the stage it expects.
 */
export function diagnoseFailure(err: ValidationGateFailure, raw: string, label: string): string {
  const detail = err.detail;

  // (1) Non-JSON.
  if (detail.toLowerCase().includes("did not parse as json")) {
    return "model returned text that is not valid JSON — check for stray prose outside the JSON envelope.";
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

  // (2) Missing userMessage — every stage requires it, so it says nothing
  // about which stage the body is.
  const userMessageBroken = issues.data.some(
    (issue) =>
      issue.code === "invalid_type" && issue.path.length === 1 && issue.path[0] === "userMessage",
  );
  if (userMessageBroken) {
    return "response is missing the required `userMessage` field — every turn must include it.";
  }

  // (3) Refine failure. Zod emits `custom` issues only from refines, and a
  // type error aborts refines. An all-custom list means the body fit this
  // turn's shape, so name the rules it broke instead of guessing a stage.
  if (issues.data.every((issue) => issue.code === "custom")) {
    return `body has the right shape but broke a schema rule — ${listed}`;
  }

  // (4) Wrong-stage detection, against the stage this Turn expects. A label
  // with no signature cannot be compared, so it skips straight to the list.
  const rival = isTurnStage(label) ? detectRivalStage(raw, label) : null;
  if (rival !== null) {
    return `body matches the ${rival} stage schema, not ${label} — model appears to have answered the wrong turn.`;
  }

  // (5) Shape failure on a body that fits this turn: list the issues.
  return `body failed the schema — ${listed}`;
}
