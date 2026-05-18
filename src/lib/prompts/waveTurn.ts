import { z } from "zod/v4";
import { qualityScoreSchema } from "@/lib/types/spaced-repetition";
import { questionnaireSchema } from "./questionnaire";

/**
 * Mid-Wave model response. Optional comprehensionSignals grade open questions
 * from the prior turn; optional questionnaire drops 1-N new questions. Both
 * may be absent (pure teaching turn).
 *
 * Discriminator-by-answer-kind (not card kind): an MC question answered via
 * the free-text escape is graded as free-text because the model only has
 * free-text content to evaluate (spec §4.3 rationale).
 */
const comprehensionSignalSchema = z.discriminatedUnion("kind", [
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

export const waveMidTurnSchema = z.object({
  userMessage: z
    .string()
    .min(1)
    .describe("The message the learner sees this turn. Teaching prose, ≤250 words."),
  comprehensionSignals: z
    .array(comprehensionSignalSchema)
    .optional()
    .describe(
      "Per-question grading of any open questions the learner just answered. Omit for pure teaching turns.",
    ),
  questionnaire: questionnaireSchema
    .optional()
    .describe(
      "1-N questions to drop into the conversation. Use sparingly (~1 turn in 3, never twice in a row, alternate types).",
    ),
});

export type WaveMidTurn = z.infer<typeof waveMidTurnSchema>;

export interface RenderWaveTurnEnvelopeParams {
  /** Pre-built envelope body (e.g. `<learner_reply>…</learner_reply>` or `<questionnaire_answers>…</questionnaire_answers>`). */
  readonly learnerInput: string;
  /** Turns remaining AFTER this turn completes (0 means the next call is the close turn). */
  readonly turnsRemaining: number;
  /** Optional inline JSON schema for non-strict-mode models. */
  readonly responseSchema?: string;
}

/**
 * Renders the per-turn user envelope for a Wave mid-turn. The harness
 * appends `<turns_remaining>` per spec §3.2 step 2. Output is XML-escaped
 * upstream by callers building `learnerInput`; this function only stitches.
 */
export function renderWaveTurnEnvelope(params: RenderWaveTurnEnvelopeParams): string {
  const schemaBlock = params.responseSchema
    ? `\n<response_schema>${params.responseSchema}</response_schema>`
    : "";
  return [
    "<stage>teaching turn</stage>",
    params.learnerInput,
    `<turns_remaining>${params.turnsRemaining}</turns_remaining>`,
    schemaBlock,
  ]
    .filter((s) => s !== "")
    .join("\n");
}
