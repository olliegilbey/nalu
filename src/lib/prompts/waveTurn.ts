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
 * Zod schema for a mid-Wave model response: required teaching `userMessage`,
 * plus optional `comprehensionSignals` (prior-answer grading) and
 * `questionnaire` (1-N new questions). Used as `executeTurn`'s `responseSchema`.
 */
export const waveMidTurnSchema = z
  .object({
    userMessage: z
      .string()
      .min(1)
      .describe(
        "The message the learner sees this turn. Teaching prose: explanation, worked examples, conversational tutoring, ≤250 words.",
      ),
    comprehensionSignals: z
      .array(comprehensionSignalSchema)
      .optional()
      .describe(
        "Per-question grading of any open questions the learner just answered. Omit for pure teaching turns.",
      ),
    questionnaire: questionnaireSchema
      .optional()
      .describe(
        "Optional graded concept-check: 1-N questions, each assessing one concept. EVERY question must carry `conceptName` (an existing concept name or a new one); EVERY multiple-choice question must also carry `correct`.",
      ),
  })
  .superRefine((val, ctx) => {
    // A teaching `questionnaire` question is a graded concept-check: each one
    // becomes an `assessments` row keyed on a `concept`, and SM-2 scheduling,
    // XP, and tier progression all depend on that link. The shared
    // `questionSchema` leaves `conceptName` and MC `correct` optional because
    // clarify reuses the same shape with no grading; the wave-mid stage
    // tightens it here, mirroring `makeBaselineSchema`'s stage-level
    // superRefine. Without this, an omission passes validation and then
    // crashes `insertNewQuestionnaire` with an unrecoverable 500 — this turns
    // it into a retryable `ValidationGateFailure` directive instead.
    if (!val.questionnaire) return;
    val.questionnaire.questions.forEach((q, idx) => {
      // `!q.conceptName?.trim()` rejects undefined, "", and whitespace-only
      // values, mirroring the `insertNewQuestionnaire` backstop. A blank
      // conceptName is a valid `z.string()` but would upsert a nameless
      // concept downstream, so the schema gate catches it here as a retryable
      // `ValidationGateFailure` rather than letting it slip through to a 500.
      if (!q.conceptName?.trim()) {
        ctx.addIssue({
          code: "custom",
          path: ["questionnaire", "questions", idx, "conceptName"],
          message: `question ${q.id} is missing required conceptName. Every teaching-quiz question must name the concept it assesses (reuse an existing concept name or introduce a new one). For an open or reflective question you do NOT want graded, ask it in your teaching prose instead.`,
        });
      }
      // MC must carry `correct` so the client can score the click without a
      // round-trip and the grading path has a key to compare against.
      if (q.type === "multiple_choice" && q.correct === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["questionnaire", "questions", idx, "correct"],
          message: `MC question ${q.id} is missing required correct key. Every teaching multiple-choice question must mark which option (A, B, C, or D) is correct.`,
        });
      }
    });
  });

/** Parsed mid-Wave model response — the inferred shape of {@link waveMidTurnSchema}. */
export type WaveMidTurn = z.infer<typeof waveMidTurnSchema>;

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
