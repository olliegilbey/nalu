import { z } from "zod/v4";
import { baselineSchema } from "./baseline";
import { frameworkSchema } from "./framework";

/**
 * Response schema for the merged scoping Turn (issue #15): one LLM call
 * designs the framework and writes the baseline against it.
 *
 * - `framework` is the framework stage's schema, unchanged.
 * - `baseline` is the flat baseline schema (`baseline.ts`).
 *
 * Key order matters. The model writes keys in schema order, so it picks
 * `baselineScopeTiers` before it writes a single baseline question.
 *
 * Each half keeps its own refines, bounded by the `FRAMEWORK` and `BASELINE`
 * tuning groups. The `.superRefine` here holds the one rule that spans both:
 * every baseline question sits on a tier the framework scoped (P-ON-02). Its
 * message goes back to the model verbatim as a retry directive.
 */
export const frameworkAndBaselineSchema = z
  .object({
    framework: frameworkSchema,
    baseline: baselineSchema,
  })
  .superRefine((value, ctx) => {
    const scope = value.framework.baselineScopeTiers;
    const inScope = new Set(scope);
    value.baseline.questions.forEach((q, idx) => {
      if (q.tier !== undefined && !inScope.has(q.tier)) {
        ctx.addIssue({
          code: "custom",
          path: ["baseline", "questions", idx, "tier"],
          message: `question ${q.id} tier ${q.tier} is outside baselineScopeTiers [${scope.join(", ")}]`,
        });
      }
    });
  });
