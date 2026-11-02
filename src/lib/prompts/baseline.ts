import { z } from "zod/v4";
import { BASELINE, FRAMEWORK } from "@/lib/config/tuning";
import {
  GRADED_RUBRIC_RULE,
  isPlaceholderRubric,
  placeholderRubricDirective,
  questionSchema,
} from "./questionnaire";

/**
 * Questions per in-scope tier. Starts at `BASELINE.questionsPerTier` and rises
 * until the total reaches `BASELINE.minQuestions`: 1 tier → 7, 2 → 4 each (8),
 * 3 → 3 each (9). A flat 3 per tier gave 6 on a 2-tier scope, below the
 * floor, so the model padded with out-of-scope tiers (issue #129).
 */
function baselineQuestionsPerTier(scopeSize: number): number {
  return Math.max(BASELINE.questionsPerTier, Math.ceil(BASELINE.minQuestions / scopeSize));
}

/**
 * The count rule for every legal scope size, as the wire states it:
 * "1 tier → 7 questions; 2 tiers → 4 per tier (8); 3 tiers → 3 per tier (9)".
 * The framework picks the scope in the same response (issue #15), so the
 * model reads its own scope size off this table. Every total lands in
 * [minQuestions, maxQuestions]; baseline.test.ts checks each one.
 */
const COUNT_RULE = Array.from({ length: FRAMEWORK.maxBaselineScopeSize }, (_, i) => {
  const size = i + 1;
  const perTier = baselineQuestionsPerTier(size);
  return size === 1
    ? `1 tier → ${perTier} questions`
    : `${size} tiers → ${perTier} per tier (${perTier * size})`;
}).join("; ");

/**
 * Baseline half of the merged framework-and-baseline response
 * (`frameworkAndBaseline.ts`). It checks every rule a baseline holds on its
 * own. The scope rule needs the framework's `baselineScopeTiers`, so the
 * merged schema checks it.
 *
 * The wire description renders the count rule for every scope size and ties
 * it to `baselineScopeTiers`. The `.refine` enforces only the total.
 *
 * Output shape: `{ userMessage: string, questions: Question[] }`. Flat, like
 * `courses.baseline`: the wrapper object clarify keeps would cost wire chars
 * the merged schema cannot spare under Cerebras's 5000-char cap.
 */
export const baselineSchema = z
  .object({
    userMessage: z
      .string()
      .describe(
        "[chat] Warm chat-bubble framing the baseline. Do NOT enumerate the questions; the UI renders cards.",
      ),
    questions: z
      .array(questionSchema)
      .describe(
        `[UI] Questions on the tiers in baselineScopeTiers only. Count by its size: ${COUNT_RULE}. ` +
          "Every question is STANDALONE — never reference another question. " +
          "Mix multiple_choice and free_text. MC: 4 keyed options A/B/C/D, no 'Not sure' option. " +
          "Every question carries `conceptName`, `tier`, and `freetextRubric`. Every MC carries `correct`. " +
          `Every question is graded: each free_text \`freetextRubric\` states ${GRADED_RUBRIC_RULE}. ` +
          "Use ids b1, b2, b3, … in order.",
      )
      .refine((qs) => qs.length >= BASELINE.minQuestions && qs.length <= BASELINE.maxQuestions, {
        message: `baseline must contain between ${BASELINE.minQuestions} and ${BASELINE.maxQuestions} questions`,
      }),
  })
  .superRefine((val, ctx) => {
    const qs = val.questions;

    // Every baseline question must carry conceptName + tier (optional on the
    // shared questionSchema because clarify uses the same shape without scope).
    qs.forEach((q, idx) => {
      if (q.conceptName === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["questions", idx, "conceptName"],
          message: `question ${q.id} is missing required conceptName`,
        });
      }
      if (q.tier === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["questions", idx, "tier"],
          message: `question ${q.id} is missing required tier`,
        });
      }
      // MC must carry `correct` so the client can score without a round-trip.
      if (q.type === "multiple_choice" && q.correct === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["questions", idx, "correct"],
          message: `MC question ${q.id} is missing required correct key`,
        });
      }
      // The close turn grades free text against this rubric. A placeholder
      // (clarify's, copied from the Context) leaves it no key (issue #22).
      if (q.type === "free_text" && isPlaceholderRubric(q.freetextRubric)) {
        ctx.addIssue({
          code: "custom",
          path: ["questions", idx, "freetextRubric"],
          message: placeholderRubricDirective(q.id),
        });
      }
    });

    // Unique ids — duplicate ids break client-side response matching.
    const ids = qs.map((q) => q.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["questions"],
        message: `duplicate question ids: ${[...new Set(dupes)].join(", ")}`,
      });
    }
  });
