/**
 * Gated, redaction-aware diagnostics for the free-text grading pipeline
 * (GitHub issue #22: correct free-text answers awarding 0 XP).
 *
 * Everything here is a pure formatter plus one env gate. NO I/O — callers own
 * the `process.stderr.write`, exactly like `src/lib/turn/formatTurn.ts`. Two
 * layers import it: `src/lib/turn/executeTurn.ts` (parse-failure dump) and
 * `src/lib/course/closeGradingDebug.ts` (per-grading and strip-path lines).
 * It lives outside `src/lib/llm/` because it formats Harness data (parsed
 * gradings, learner Responses), not LLM SDK calls.
 *
 * Guardrail (AGENTS.md): learner content and LLM outputs never reach
 * production logs. `isGradingDebugEnabled()` is the single gate every content
 * log MUST be wrapped in, and it fails closed. Excerpts are also truncated
 * here, so even flag-on output caps how much learner text is emitted.
 */
import { calculateXP } from "@/lib/scoring/xp";
import type { CloseTurnBase } from "@/lib/prompts/closeTurn";
import type { V3Response } from "@/lib/types/jsonb";

/** True when `LLM_DEBUG_GRADINGS=1` under NODE_ENV development or test; the one grading-debug gate. */
export function isGradingDebugEnabled(): boolean {
  // Fail closed: an allowlist, not a production blocklist, so an unset or
  // unexpected NODE_ENV logs nothing. Same shape as the `LLM_DEVTOOLS` gate in
  // `src/lib/llm/provider.ts`, widened to `test` because `just smoke` runs
  // under vitest. Vercel Production and Preview both run NODE_ENV=production.
  const env = process.env.NODE_ENV;
  if (env !== "development" && env !== "test") return false;
  // Read from `process.env`, not `getEnv()`: like LLM_TELEMETRY / LLM_DEVTOOLS
  // it stays out of the boot-time schema, so a typo cannot crash the app.
  return process.env.LLM_DEBUG_GRADINGS === "1";
}

/** Max chars of a learner Response excerpt in a debug line — redaction cap. */
export const GRADING_DEBUG_EXCERPT_MAX = 80;

/** Max chars of each raw LLM fragment in a parse-failure debug line. */
export const GRADING_DEBUG_CANDIDATE_MAX = 600;

/** Pure: flatten whitespace to single spaces, then cap at `max` chars with a trailing `…`. */
export function truncateForDebug(s: string, max: number): string {
  // Flattening keeps one grading on one log line; learner answers may hold newlines.
  const flattened = s.replace(/\s+/g, " ").trim();
  if (flattened.length <= max) return flattened;
  return `${flattened.slice(0, max)}…`;
}

/** One close-turn grading as the model emitted it, after Zod parse. */
type CloseGrading = CloseTurnBase["gradings"][number];

/** Inputs for one `formatGradingDebugLine` row. */
export interface GradingDebugInput {
  /** Which close path logged the line. */
  readonly context: "wave-close" | "scoping-close";
  /** The model's grading. */
  readonly grading: CloseGrading;
  /** The learner's Response to the graded question; undefined when none was found. */
  readonly response: V3Response | undefined;
  /** Tier the Harness scores free-text XP at; defaults to the grading's `conceptTier`. */
  readonly xpTier?: number;
}

/** Pure: render one grading beside the learner's Response as a single `[grading-debug]` line. */
export function formatGradingDebugLine(f: GradingDebugInput): string {
  const g = f.grading;
  // Free-text gradings carry the model's verdict and the XP it maps to. A
  // `q=0`/`q=1` grading shows `xp≈0` — hypothesis (2). Display-only: the
  // close transaction scores from the persisted concept tier.
  const gradingParts =
    g.kind === "free-text"
      ? [
          `verdict=${g.verdict}`,
          `q=${g.qualityScore}`,
          `xp≈${calculateXP(f.xpTier ?? g.conceptTier, g.qualityScore)}`,
        ]
      : [];
  // Gradings are discriminated by ANSWER kind (closeTurn.ts): a freetext
  // Response needs a `free-text` grading, a choice needs `mc-index`. A
  // freetext Response graded `mc-index` passes Zod and the close skips it
  // for 0 XP — the silent path. Flag it so it greps.
  const responseKind = describeResponseKind(f.response);
  const responseText = f.response?.freetext ?? f.response?.choice;
  const expectedKind = responseKind === "freetext" ? "free-text" : "mc-index";
  const mismatch = responseKind !== "none" && expectedKind !== g.kind;
  const parts = [
    "[grading-debug]",
    f.context,
    `qid=${JSON.stringify(g.questionId)}`,
    `kind=${g.kind}`,
    ...gradingParts,
    `responseKind=${responseKind}`,
    ...(responseText !== undefined
      ? [`response=${JSON.stringify(truncateForDebug(responseText, GRADING_DEBUG_EXCERPT_MAX))}`]
      : []),
    ...(mismatch ? ["KIND-MISMATCH"] : []),
  ];
  return parts.join(" ");
}

/** Pure: name a Response's kind, matching the `choice` / `freetext` fields on `V3Response`. */
function describeResponseKind(r: V3Response | undefined): "freetext" | "choice" | "none" {
  if (r === undefined) return "none";
  return r.freetext !== undefined ? "freetext" : "choice";
}

/** Pure: one-line summary of the gradings the close turn's empty-idSet preprocess discards. */
export function summariseStrippedGradings(context: string, v: unknown): string {
  // `v` is the RAW pre-parse value. This strip (commit c3ed970) is the masking
  // path issue #22 must rule out, so pull `questionId`/`kind` from each entry
  // defensively, without trusting the shape.
  if (!Array.isArray(v)) {
    return `[grading-debug] ${context} strip: non-array gradings value (type=${typeof v})`;
  }
  const ids = v.map((entry) => {
    if (entry !== null && typeof entry === "object") {
      const rec = entry as Record<string, unknown>;
      const qid = typeof rec.questionId === "string" ? rec.questionId : "?";
      const kind = typeof rec.kind === "string" ? rec.kind : "?";
      return `${qid}(${kind})`;
    }
    return "?(?)";
  });
  return `[grading-debug] ${context} strip: idSet empty, discarding ${v.length} grading(s): [${ids.join(", ")}]`;
}

/** Pure: one-line view of a failed parse — the Zod issues plus the `gradings` fragment, each capped. */
export function formatParseFailureDebugLine(label: string, detail: string, raw: string): string {
  const issues = JSON.stringify(
    truncateForDebug(summariseIssues(detail), GRADING_DEBUG_CANDIDATE_MAX),
  );
  return `[grading-debug] parse-failure label=${label} issues=${issues} ${describeGradingsFragment(raw)}`;
}

/** Pure: the raw candidate's `gradings` fragment, capped; the raw prefix when it is not JSON. */
function describeGradingsFragment(raw: string): string {
  // The candidate opens with `userMessage`, so a plain prefix cut hides the
  // gradings. Pull the `gradings` fragment out of the raw JSON instead.
  const candidate = parseJson(raw);
  if (candidate === undefined) {
    return `candidate=${JSON.stringify(truncateForDebug(raw, GRADING_DEBUG_CANDIDATE_MAX))}`;
  }
  if (candidate !== null && typeof candidate === "object" && "gradings" in candidate) {
    return `gradings=${truncateForDebug(JSON.stringify(candidate.gradings), GRADING_DEBUG_CANDIDATE_MAX)}`;
  }
  return "gradings=absent";
}

/** Pure: Zod's issue-list JSON as `path: message` pairs; the raw detail when it is not issue JSON. */
function summariseIssues(detail: string): string {
  const parsed = parseJson(detail);
  if (!Array.isArray(parsed)) return detail;
  return parsed
    .map((issue: unknown) => {
      const rec = issue !== null && typeof issue === "object" ? issue : {};
      const path = "path" in rec && Array.isArray(rec.path) ? rec.path.join(".") : "";
      const message = "message" in rec && typeof rec.message === "string" ? rec.message : "?";
      return `${path === "" ? "<root>" : path}: ${message}`;
    })
    .join("; ");
}

/** Pure: `JSON.parse` that returns undefined instead of throwing. */
function parseJson(s: string): unknown {
  try {
    return JSON.parse(s) as unknown;
  } catch {
    return undefined;
  }
}
