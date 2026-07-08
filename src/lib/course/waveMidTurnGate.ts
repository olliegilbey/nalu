import { ValidationGateFailure } from "@/lib/llm/parseAssistantResponse";
import type { WaveTurnCollector } from "./waveTurnTools";
import type { SubmitTurnPayload } from "./buildLearnerInput";

/**
 * Post-loop validation gate for a streamed tool mid-turn — the tool-channel
 * replacement for the mega-schema's whole-object guarantees. Runs AFTER the
 * loop ends, over the staged collector + the prose the learner actually saw
 * (all steps' streamed text, not just the final step's).
 *
 * Failure detail strings are model-readable retry directives — they persist
 * as `harness_retry_directive` rows verbatim (`executeToolTurnStream`'s
 * default `retryDirective`).
 *
 * Checks (each replaces a mega-schema invariant, in order):
 * 1. Non-empty prose — was `userMessage: z.string().min(1)`.
 * 2. No raw response-JSON in the prose — waves opened under the mega-schema
 *    contract carry JSON assistant turns (and sometimes an inline
 *    `<response_schema>`) in their replayed context; the model imitates the
 *    history and dumps the old JSON envelope as text instead of calling
 *    tools (observed live, 2026-07-08). The directive breaks the few-shot
 *    pattern so the retry recovers.
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
      "Your turn ended without any teaching prose. The learner sees your plain text output — after any tool calls finish, always write the teaching message for this turn.",
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

/**
 * True when the prose embeds a raw model-response JSON envelope (the whole
 * message is one, or one trails the prose — both observed live). Precision
 * over recall: a candidate must parse as a JSON object from a `{` through
 * the END of the prose AND carry a mega-schema/tool-input key, so teaching
 * prose that merely mentions JSON never trips it.
 */
function containsResponseJsonBlob(prose: string): boolean {
  const trimmed = prose.trim();
  // Pathological-length guard: the scan is O(braces × length).
  if (trimmed.length > 20_000) return false;
  const braceIndices = [...trimmed.matchAll(/\{/g)].slice(0, 20).map((m) => m.index);
  return braceIndices.some((i) => {
    const candidate = (() => {
      try {
        return JSON.parse(trimmed.slice(i)) as unknown;
      } catch {
        return null;
      }
    })();
    return (
      typeof candidate === "object" &&
      candidate !== null &&
      ("userMessage" in candidate ||
        "questionnaire" in candidate ||
        "questions" in candidate ||
        "comprehensionSignals" in candidate)
    );
  });
}
