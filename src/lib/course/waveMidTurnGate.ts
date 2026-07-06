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
 * 2. Grading coverage — every answered question carries a staged signal.
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
