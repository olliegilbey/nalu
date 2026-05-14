import { z } from "zod";
import { qualityScoreSchema } from "@/lib/types/spaced-repetition";

/**
 * Baseline JSONB shapes — split out of `jsonb.ts` to keep both files under
 * the 200-LOC ceiling. Re-exported from `jsonb.ts` so callers can keep
 * importing from `@/lib/types/jsonb` unchanged.
 *
 * Note: this file intentionally redeclares the `v3Question` / `v3Response`
 * shapes used by the baseline payload. They mirror the ones in `jsonb.ts`
 * for clarification; duplicating the small shape is cheaper than threading
 * a cross-file import that would create a cycle once `jsonb.ts` re-exports
 * back from here.
 */

const v3McOption = z.enum(["A", "B", "C", "D"]);

const v3Question = z.discriminatedUnion("type", [
  z.object({
    id: z.string(),
    type: z.literal("free_text"),
    prompt: z.string(),
    freetextRubric: z.string(),
    conceptName: z.string().optional(),
    tier: z.number().int().positive().optional(),
  }),
  z.object({
    id: z.string(),
    type: z.literal("multiple_choice"),
    prompt: z.string(),
    options: z.object({ A: z.string(), B: z.string(), C: z.string(), D: z.string() }),
    correct: v3McOption.optional(),
    freetextRubric: z.string(),
    conceptName: z.string().optional(),
    tier: z.number().int().positive().optional(),
  }),
]);

const v3Response = z
  .object({
    questionId: z.string(),
    choice: v3McOption.optional(),
    freetext: z.string().optional(),
  })
  .refine((r) => (r.choice === undefined) !== (r.freetext === undefined), {
    message: "response must have exactly one of choice or freetext",
  });

/**
 * Verdict ↔ qualityScore alignment table. Defence-in-depth mirror of the
 * same constant in `src/lib/prompts/baselineGrading.ts`: the LLM-facing
 * schema enforces this on parse, and the persistence schema enforces it
 * again on every JSONB read so a manual DB write or a future schema drift
 * can't smuggle in `verdict: "correct"` with `qualityScore: 1`.
 */
export const VERDICT_QUALITY_BANDS: Readonly<
  Record<"correct" | "partial" | "incorrect", readonly [number, number]>
> = {
  correct: [4, 5],
  partial: [2, 3],
  incorrect: [0, 1],
};

/**
 * LLM grading output for one baseline question, enriched server-side with
 * `conceptTier` (looked up from the baseline question the grading targets).
 *
 * The LLM-facing v4 wire schema (`src/lib/prompts/baselineGrading.ts`) does
 * NOT include `conceptTier` — the model only emits `conceptName`. The
 * harness enriches with `conceptTier` from the baseline question before
 * persisting, so downstream consumers (XP, SM-2 scheduling, starting-tier
 * placement) don't need to re-correlate against `baseline.questions`.
 */
export const baselineGradingSchema = z
  .object({
    questionId: z.string(),
    conceptName: z.string(),
    conceptTier: z.number().int().positive(),
    verdict: z.enum(["correct", "partial", "incorrect"]),
    qualityScore: qualityScoreSchema,
    rationale: z.string(),
  })
  .superRefine((val, ctx) => {
    const [lo, hi] = VERDICT_QUALITY_BANDS[val.verdict];
    if (val.qualityScore < lo || val.qualityScore > hi) {
      ctx.addIssue({
        code: "custom",
        path: ["qualityScore"],
        message: `verdict='${val.verdict}' requires qualityScore in [${lo}, ${hi}], got ${val.qualityScore}.`,
      });
    }
  });
export type BaselineGrading = z.infer<typeof baselineGradingSchema>;

/**
 * What `generateBaseline` writes after questions are generated, before close.
 * `gradings` is initialised empty here and populated by `gradeBaseline`.
 *
 * `.strict()` is required for union discrimination in `baselineJsonbSchema`:
 * without it, a malformed closed payload (with `immutableSummary` but missing
 * `summarySeed`) would silently fall through to this arm and have its
 * close-turn fields stripped, masking a corruption bug.
 */
export const baselineQuestionsJsonbSchema = z
  .object({
    /** The model's framing message for this baseline turn. Persisted so cached replay can return the model's exact wording. */
    userMessage: z.string(),
    questions: z.array(v3Question),
    responses: z.array(v3Response),
    gradings: z.array(baselineGradingSchema),
  })
  .strict();
export type BaselineQuestionsJsonb = z.infer<typeof baselineQuestionsJsonbSchema>;

/**
 * What `submitBaseline` writes on close. Strict superset of the pre-close
 * shape, with the close-turn outputs added: dual summaries (immutable
 * profile + evolving seed) and the chosen `startingTier`.
 *
 * `.strict()` here is symmetric with the pre-close arm — both arms reject
 * unknown keys so the union below has unambiguous discrimination.
 */
export const baselineClosedJsonbSchema = baselineQuestionsJsonbSchema
  .extend({
    immutableSummary: z.string(),
    summarySeed: z.string(),
    startingTier: z.number().int().positive(),
  })
  .strict();
export type BaselineClosedJsonb = z.infer<typeof baselineClosedJsonbSchema>;

/**
 * Row-guard schema: accepts either shape — the closed shape is a strict
 * superset of the pre-close shape, so consumers discriminate by checking
 * `"startingTier" in baseline`.
 *
 * Both arms are `.strict()`; the closed arm is listed first so well-formed
 * close payloads match without first attempting (and failing) the pre-close
 * arm. A malformed close payload (mixing close-turn fields incompletely)
 * rejects on both arms: the closed arm fails on the missing field, and the
 * pre-close arm fails because `.strict()` rejects the unknown close-turn
 * keys — so the corruption surfaces instead of silently degrading.
 */
export const baselineJsonbSchema = z.union([
  baselineClosedJsonbSchema,
  baselineQuestionsJsonbSchema,
]);
export type BaselineJsonb = z.infer<typeof baselineJsonbSchema>;
