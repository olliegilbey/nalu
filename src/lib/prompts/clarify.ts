import { z } from "zod/v4";
import { SCOPING } from "@/lib/config/tuning";
import { questionnaireSchema } from "./questionnaire";

/**
 * Clarify-stage response schema.
 *
 * - `userMessage` is the warm chat-bubble framing the learner reads.
 * - `questions` is a Questionnaire (2–4 entries; conceptName/tier/correct
 *   absent — clarify is elicitation, not assessment).
 *
 * The count bounds come from `tuning.SCOPING` so the prompt contract and
 * runtime validator stay in lock-step. Cerebras strict mode cannot express
 * minItems/maxItems — refine messages compensate Zod-side and become the
 * retry directive verbatim (wrapped in Zod's issue-list JSON).
 */
export const clarifySchema = z
  .object({
    userMessage: z
      .string()
      .describe(
        "[chat] Warm, brief chat-bubble shown verbatim to the learner. " +
          "Frame what you're about to ask and why — do NOT enumerate the questions here; " +
          "the UI renders the question cards from the `questions` field.",
      ),
    questions: questionnaireSchema.describe(
      `[UI] Between ${SCOPING.minClarifyAnswers} and ${SCOPING.maxClarifyAnswers} clarifying questions. ` +
        "Questions are elicitation — no `conceptName`, no `tier`, no `correct`. " +
        "Focus on scope, baseline knowledge, and end goal.",
    ),
  })
  .refine(
    (v) =>
      v.questions.questions.length >= SCOPING.minClarifyAnswers &&
      v.questions.questions.length <= SCOPING.maxClarifyAnswers,
    {
      message: `clarify questions must be between ${SCOPING.minClarifyAnswers} and ${SCOPING.maxClarifyAnswers}`,
      path: ["questions", "questions"],
    },
  )
  .refine(
    (v) => v.questions.questions.every((q) => q.conceptName === undefined && q.tier === undefined),
    {
      message:
        "clarify questions must not carry conceptName or tier — clarify is elicitation, not assessment",
      path: ["questions", "questions"],
    },
  );

export type ClarifyTurn = z.infer<typeof clarifySchema>;
