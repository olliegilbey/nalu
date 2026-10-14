import { z } from "zod/v4";
import { qualityScoreSchema } from "@/lib/types/spaced-repetition";
import type { Questionnaire } from "./questionnaire";

/**
 * Canonical shape of one comprehension signal: the model's grade for a
 * question the learner answered last turn. The `recordComprehensionSignals`
 * tool takes a flat input and maps it onto this union
 * (`src/lib/course/waveTurnTools.ts`).
 *
 * Discriminator-by-answer-kind (not card kind): an MC question answered via
 * the free-text escape is graded as free-text because the model evaluates
 * the learner's text (spec §4.3 rationale). For a typed MC answer the
 * envelope also carries the Harness's answer key: the options and the
 * correct key (issue #149).
 *
 * No `verdict`/`qualityScore` band `superRefine` here — mid-turn signals are
 * advisory (they shape the next turn's teaching). The XP-relevant grading
 * runs at wave-close, where the band invariant IS enforced (`closeTurn.ts`).
 */
export const comprehensionSignalSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mc-index"),
    questionId: z
      .string()
      .describe("Verbatim question id from the prompt — match the card the learner clicked."),
    rationale: z
      .string()
      .describe("Two sentences. First: what the click tells you. Second: what to teach next."),
  }),
  z.object({
    kind: z.literal("free-text"),
    questionId: z
      .string()
      .describe("Verbatim question id from the prompt — match the question the learner answered."),
    verdict: z
      .enum(["correct", "partial", "incorrect"])
      .describe(
        "Judge the learner's text. 'correct' captures the key idea; 'partial' some grasp + missing pieces; 'incorrect' misses or wrong.",
      ),
    qualityScore: qualityScoreSchema.describe(
      "0-5. correct → 4-5, partial → 2-3, incorrect → 0-1.",
    ),
    rationale: z
      .string()
      .describe(
        "Two sentences. First: why this verdict given the learner's text. Second: what to teach next.",
      ),
  }),
]);

/**
 * One mid-Wave turn's output, as `persistWaveMidTurn` consumes it: the
 * learner-visible prose plus whatever the model staged through its tools.
 * `streamWaveTurn` builds it from the tool collector.
 */
export interface WaveMidTurn {
  /** Teaching prose the learner saw this turn. */
  readonly userMessage: string;
  /** Grades for the questions the learner just answered. Absent on pure teaching turns. */
  readonly comprehensionSignals?: readonly z.infer<typeof comprehensionSignalSchema>[];
  /** A new graded concept-check, if the model presented one. */
  readonly questionnaire?: Questionnaire;
}

/** Inputs to {@link renderWaveTurnEnvelope} — the per-turn mid-Wave user envelope. */
export interface RenderWaveTurnEnvelopeParams {
  /** Pre-built envelope body (e.g. `<learner_reply>…</learner_reply>` or `<questionnaire_answers>…</questionnaire_answers>`). */
  readonly learnerInput: string;
  /** Turns remaining AFTER this turn completes (0 means the next call is the close turn). */
  readonly turnsRemaining: number;
}

/**
 * Renders the per-turn user envelope for a Wave mid-turn. The harness
 * appends `<turns_remaining>` per spec §3.2 step 2. Output is XML-escaped
 * upstream by callers building `learnerInput`; this function only stitches.
 */
export function renderWaveTurnEnvelope(params: RenderWaveTurnEnvelopeParams): string {
  return [
    "<stage>teaching turn</stage>",
    params.learnerInput,
    `<turns_remaining>${params.turnsRemaining}</turns_remaining>`,
  ]
    .filter((s) => s !== "")
    .join("\n");
}
