import { z } from "zod";
import { qualityScoreSchema } from "@/lib/types/spaced-repetition";
import { blueprintSchema } from "@/lib/types/jsonb";

/**
 * Single source of truth for the harness ↔ model XML-tag contract
 * (spec §6.5).
 *
 * Two surfaces consume this module:
 *   1. `parseAssistantResponse` — extracts and validates model→harness tags.
 *   2. `src/lib/prompts/teaching.ts` — embeds tag names + JSON shapes into
 *      the static `<output_formats>` block of the Wave system prompt.
 *
 * Both surfaces import the same Zod schemas, so the prompt's documented
 * shape and the parser's validation can never drift (P9).
 */

// --- model → harness -------------------------------------------------------

export const comprehensionSignalSchema = z.object({
  concept_name: z.string(),
  tier: z.number().int().min(1).max(5),
  demonstrated_quality: qualityScoreSchema,
  evidence: z.string(),
});
export type ComprehensionSignal = z.infer<typeof comprehensionSignalSchema>;

export const assessmentQuestionSchema = z.discriminatedUnion("type", [
  z.object({
    question_id: z.string(),
    concept_name: z.string(),
    tier: z.number().int().min(1).max(5),
    type: z.literal("multiple_choice"),
    question: z.string(),
    options: z.record(z.string(), z.string()),
    correct: z.string(),
    freetextRubric: z.string().optional(),
    explanation: z.string().optional(),
  }),
  z.object({
    question_id: z.string(),
    concept_name: z.string(),
    tier: z.number().int().min(1).max(5),
    type: z.literal("free_text"),
    question: z.string(),
    freetextRubric: z.string(),
    explanation: z.string().optional(),
  }),
]);
export type AssessmentQuestion = z.infer<typeof assessmentQuestionSchema>;

export const assessmentSchema = z.object({
  questions: z.array(assessmentQuestionSchema).min(1),
});
export type AssessmentCard = z.infer<typeof assessmentSchema>;

export const nextLessonBlueprintSchema = blueprintSchema;
export type NextLessonBlueprint = z.infer<typeof nextLessonBlueprintSchema>;

export const courseSummaryUpdateSchema = z.object({
  summary: z.string(),
});
export type CourseSummaryUpdate = z.infer<typeof courseSummaryUpdateSchema>;

export const batchEvaluationSchema = z.object({
  evaluations: z.array(
    z.object({
      question_id: z.string(),
      concept_name: z.string(),
      quality_score: qualityScoreSchema,
      is_correct: z.boolean(),
      rationale: z.string(),
    }),
  ),
});
export type BatchEvaluation = z.infer<typeof batchEvaluationSchema>;

export const courseSummarySchema = z.object({ summary: z.string() });
export type CourseSummary = z.infer<typeof courseSummarySchema>;

/**
 * Names of every tag the harness extracts from a teaching-turn response.
 * The order matches the documented envelope in the system prompt.
 */
export const TEACHING_TURN_TAGS = [
  "response",
  "comprehension_signal",
  "assessment",
  "next_lesson_blueprint",
  "course_summary_update",
] as const;

export type TeachingTurnTag = (typeof TEACHING_TURN_TAGS)[number];

/**
 * Names of every tag the harness writes as a `context_messages` row.
 * Used by `src/lib/prompts/harness.ts` (next milestone).
 */
export const HARNESS_INJECTION_TAGS = [
  "user_message",
  "card_answers",
  "turns_remaining",
  "due_for_review",
] as const;

export type HarnessInjectionTag = (typeof HARNESS_INJECTION_TAGS)[number];
