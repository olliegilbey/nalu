import { z } from "zod/v4";
import { BASELINE } from "@/lib/config/tuning";
import { questionSchema } from "./questionnaire";

/**
 * Parameters for {@link makeBaselineSchema}. Scope tiers are extracted from
 * the framework before calling so the factory stays a pure function.
 */
export interface MakeBaselineSchemaParams {
  /** Tier numbers the baseline may draw from. Sourced from `framework.baselineScopeTiers`. */
  readonly scopeTiers: readonly number[];
}

/**
 * Build a per-call baseline schema whose `.superRefine` knows the scope tiers
 * the framework prescribed. Scope cannot live on the shared `questionSchema`
 * because clarify uses the same Question shape with no scope concept; only the
 * baseline-stage wrapper enforces it.
 *
 * Output shape: `{ userMessage: string, questions: { questions: Question[] } }`.
 * The nested `questions` object is intentional — it matches the `questionnaireSchema`
 * wrapper so the factory composes naturally with the questionnaire layer.
 */
export function makeBaselineSchema(params: MakeBaselineSchemaParams) {
  // Convert to Set once; used in the superRefine closure below.
  const scope = new Set(params.scopeTiers);

  return z
    .object({
      userMessage: z
        .string()
        .describe(
          "[chat] Warm chat-bubble framing the baseline. Do NOT enumerate the questions; the UI renders cards.",
        ),
      questions: z
        .object({
          questions: z
            .array(questionSchema)
            .describe(
              `[UI] Between ${BASELINE.minQuestions} and ${BASELINE.maxQuestions} questions total, ` +
                `${BASELINE.questionsPerTier} per tier in scope. Every question is STANDALONE — never reference another question. ` +
                "Mix multiple_choice and free_text. MC: 4 keyed options A/B/C/D, no 'Not sure' option. " +
                "Every question carries `conceptName`, `tier`, and `freetextRubric`. Every MC carries `correct`. " +
                "Use ids b1, b2, b3, … in order.",
            ),
        })
        .refine(
          (q) =>
            q.questions.length >= BASELINE.minQuestions &&
            q.questions.length <= BASELINE.maxQuestions,
          {
            message: `baseline must contain between ${BASELINE.minQuestions} and ${BASELINE.maxQuestions} questions`,
            path: ["questions"],
          },
        ),
    })
    .superRefine((val, ctx) => {
      const qs = val.questions.questions;

      // Every baseline question must carry conceptName + tier (optional on the
      // shared questionSchema because clarify uses the same shape without scope).
      qs.forEach((q, idx) => {
        if (q.conceptName === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["questions", "questions", idx, "conceptName"],
            message: `question ${q.id} is missing required conceptName`,
          });
        }
        if (q.tier === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["questions", "questions", idx, "tier"],
            message: `question ${q.id} is missing required tier`,
          });
        }
        // MC must carry `correct` so the client can score without a round-trip.
        if (q.type === "multiple_choice" && q.correct === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["questions", "questions", idx, "correct"],
            message: `MC question ${q.id} is missing required correct key`,
          });
        }
      });

      // Tier-scope invariant (P-ON-02): every question's tier must be in scope.
      qs.forEach((q, idx) => {
        if (q.tier !== undefined && !scope.has(q.tier)) {
          ctx.addIssue({
            code: "custom",
            path: ["questions", "questions", idx, "tier"],
            message: `question ${q.id} tier ${q.tier} is outside the requested scope [${[...scope].join(", ")}]`,
          });
        }
      });

      // Unique ids — duplicate ids break client-side response matching.
      const ids = qs.map((q) => q.id);
      const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
      if (dupes.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["questions", "questions"],
          message: `duplicate question ids: ${[...new Set(dupes)].join(", ")}`,
        });
      }
    });
}

/** Inferred per-call Baseline payload — `z.infer` over the factory return. */
export type BaselineTurn = z.infer<ReturnType<typeof makeBaselineSchema>>;
