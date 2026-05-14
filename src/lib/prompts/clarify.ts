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
  );
// Note: we deliberately do NOT refine away `conceptName`/`tier` on clarify
// questions. The schema `.describe()` and system prompt already instruct the
// model to omit them at this stage, and weak models (e.g. llama3.1-8b) sometimes
// emit hallucinated values regardless. Failing the turn over a stray optional
// field would be worse than persisting a benign hallucination — the UI ignores
// these fields and downstream stages aren't materially affected.

export type ClarifyTurn = z.infer<typeof clarifySchema>;
