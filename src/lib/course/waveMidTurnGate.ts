import { ValidationGateFailure } from "@/lib/turn/validationGateFailure";
import type { ToolQuestionInput, WaveTurnCollector } from "./waveTurnTools";
import type { SubmitTurnPayload } from "./buildLearnerInput";

/**
 * Post-loop validation gate for a streamed tool mid-turn — the tool-channel
 * replacement for the mega-schema's whole-object guarantees. Runs AFTER the
 * loop ends, over the staged collector + the prose the learner actually saw
 * (all steps' streamed text, not just the final step's).
 *
 * Failure detail strings are model-readable retry directives —
 * `executeToolTurnStream` persists each one verbatim as the
 * `harness_retry_directive` row.
 *
 * Checks (each replaces a mega-schema invariant, in order):
 * 1. Non-empty prose — was `userMessage: z.string().min(1)`.
 * 2. No raw response-JSON in the prose — waves opened under the mega-schema
 *    contract carry JSON assistant turns (and sometimes an inline
 *    `<response_schema>`) in their replayed context; the model imitates the
 *    history and dumps the old JSON envelope as text instead of calling
 *    tools (observed live, 2026-07-08). The directive breaks the few-shot
 *    pattern so the retry recovers. It also keeps an answer key out of
 *    chat_log: accepted prose persists whole, even past the stream guard's
 *    cut (#156).
 * 3. Grading coverage — every answered question carries a staged signal.
 *    The old schema left `comprehensionSignals` optional, silently skipping
 *    grading when the model forgot; the tool channel makes the omission
 *    detectable (probe finding: ~5% no-call rate), so gate it.
 */
export function validateWaveMidToolTurn(
  collector: WaveTurnCollector,
  visibleProse: string,
  payload: SubmitTurnPayload,
): ValidationGateFailure | null {
  if (visibleProse.trim().length === 0) {
    return new ValidationGateFailure(
      "tool_turn_gate",
      "Your response ended without any teaching prose. The learner sees your plain text output — after any tool calls finish, always write the teaching message for this turn.",
    );
  }

  if (containsResponseJsonBlob(visibleProse)) {
    return new ValidationGateFailure(
      "tool_turn_gate",
      "Your message to the learner contained a raw JSON object. Your plain text output goes to the learner verbatim: write natural conversational prose only, and emit structured actions (grading, quizzes) ONLY by calling the provided tools (recordComprehensionSignals, presentQuestionnaire). Rewrite this turn: teaching prose as plain text, plus tool calls for any grading or quiz.",
    );
  }

  if (payload.kind === "questionnaire-answers") {
    const gradedIds = new Set(collector.signals.map((s) => s.questionId));
    const ungraded = payload.answers.map((a) => a.id).filter((id) => !gradedIds.has(id));
    if (ungraded.length > 0) {
      return new ValidationGateFailure(
        "tool_turn_gate",
        `The learner submitted answers to questions ${ungraded.join(", ")} but you did not record grading signals for them. Call recordComprehensionSignals FIRST with one signal per answered question, then write your teaching prose.`,
      );
    }
  }

  return null;
}

/** Top-level keys of the retired mega-schema envelope and the tool inputs. */
const RESPONSE_ENVELOPE_KEYS = [
  "userMessage",
  "questionnaire",
  "questions",
  "comprehensionSignals",
] as const;

/** The answer-key field of a questionnaire question. Typed, so a rename breaks the build. */
const ANSWER_KEY_FIELD: keyof ToolQuestionInput = "correct";

/**
 * True when the prose embeds a raw model-response JSON object. Observed live
 * as the whole message, as a blob trailing the prose, and mid-line (#156).
 * Each candidate is the balanced `{…}` that opens at one `{`, so prose after
 * the object cannot hide it. Precision over recall: a candidate trips only
 * when it parses AND carries an envelope key at top level, or an answer key
 * (`correct`) at any depth. The second rule catches invented wrappers such
 * as `{"items":[{"correct":"B"}]}`. Teaching prose that merely shows JSON
 * passes. Fence-blind on purpose: a fenced or backticked answer key is still
 * a leak, so it fails here even though the stream guard exempts it.
 */
function containsResponseJsonBlob(prose: string): boolean {
  const trimmed = prose.trim();
  // Pathological-length guard: the scan is O(braces × length). FAIL CLOSED —
  // beyond the bound we cannot prove the prose is clean, and legit teaching
  // prose never approaches 20k chars; reject rather than let an oversized
  // JSON-imitation leak (answer keys ride in those blobs) through the gate.
  if (trimmed.length > 20_000) return true;
  const braceIndices = [...trimmed.matchAll(/\{/g)].slice(0, 20).map((m) => m.index);
  return braceIndices.some((i) => {
    const candidate = parseJsonObjectAt(trimmed, i);
    return (
      candidate !== null &&
      (RESPONSE_ENVELOPE_KEYS.some((key) => key in candidate) ||
        hasKeyAtAnyDepth(candidate, ANSWER_KEY_FIELD))
    );
  });
}

/**
 * The JSON object whose `{` sits at `start`, parsed, or null. Parses only up
 * to the matching `}`, so trailing prose does not break the parse.
 */
function parseJsonObjectAt(text: string, start: number): object | null {
  const end = findMatchingBrace(text, start);
  if (end === null) return null;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof value === "object" && value !== null ? value : null;
  } catch {
    // Not JSON (set notation, `{{name}}`, prose braces): not a candidate.
    return null;
  }
}

/**
 * Index of the `}` that closes the `{` at `start`, or null if it never
 * closes. JSON-string aware: braces inside "…" do not count, and a `\`
 * escapes the next character, so `"\"}"` stays one string.
 */
function findMatchingBrace(text: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}

/** True when `value` or any object or array nested in it holds `key`. */
function hasKeyAtAnyDepth(value: unknown, key: string): boolean {
  if (typeof value !== "object" || value === null) return false;
  return key in value || Object.values(value).some((child) => hasKeyAtAnyDepth(child, key));
}
