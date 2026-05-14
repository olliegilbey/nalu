import { z } from "zod";
import { qualityScoreSchema } from "@/lib/types/spaced-repetition";

/**
 * Trust-boundary Zod schemas for every JSONB column shape.
 *
 * Every read function in `src/db/queries/` runs these against the JSONB
 * payload before handing rows to consumers. drizzle-zod alone returns
 * `unknown` for JSONB; these schemas tighten that.
 *
 * Schemas mirror the wire shapes defined in the prompt schemas under
 * `src/lib/prompts/`. Field names are camelCase to match the JSON-everywhere
 * contract (spec §4.8).
 *
 * NOTE: storage schemas live on `zod` v3 (the v3 import the rest of jsonb.ts
 * already uses for table guards). Wire schemas live on `zod/v4` for the
 * `z.toJSONSchema()` codegen. We bridge by re-defining the JSONB shapes
 * here in v3 mirroring the v4 wire shape — these two surfaces drift only
 * if a developer changes one without the other, which is caught by the
 * round-trip test below.
 */

// --- courses.clarification --------------------------------------------------

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

export const clarificationJsonbSchema = z.object({
  /** The model's framing message for this clarification turn. Persisted so cached replay can return the model's exact wording. */
  userMessage: z.string(),
  questions: z.array(v3Question),
  responses: z.array(v3Response),
});
export type ClarificationJsonb = z.infer<typeof clarificationJsonbSchema>;

// --- courses.framework ------------------------------------------------------

/** One rung of the learning ladder. camelCase — matches wire shape (spec §4.8). */
export const tierSchema = z.object({
  number: z.number().int().min(1),
  name: z.string(),
  description: z.string(),
  exampleConcepts: z.array(z.string()),
});

export const frameworkJsonbSchema = z.object({
  /** The model's framing message for this framework turn. Persisted so cached replay can return the model's exact wording — symmetric with clarification/baseline. */
  userMessage: z.string(),
  tiers: z.array(tierSchema),
  estimatedStartingTier: z.number().int().min(1),
  baselineScopeTiers: z.array(z.number().int().min(1)),
});
export type FrameworkJsonb = z.infer<typeof frameworkJsonbSchema>;

// --- courses.baseline -------------------------------------------------------

/**
 * Verdict ↔ qualityScore alignment table. Defence-in-depth mirror of the
 * same constant in `src/lib/prompts/baselineGrading.ts`: the LLM-facing
 * schema enforces this on parse, and the persistence schema enforces it
 * again on every JSONB read so a manual DB write or a future schema drift
 * can't smuggle in `verdict: "correct"` with `qualityScore: 1`.
 */
const VERDICT_QUALITY_BANDS: Readonly<
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

/**
 * What `generateBaseline` writes after questions are generated, before close.
 * `gradings` is initialised empty here and populated by `gradeBaseline`.
 */
export const baselineQuestionsJsonbSchema = z.object({
  /** The model's framing message for this baseline turn. Persisted so cached replay can return the model's exact wording. */
  userMessage: z.string(),
  questions: z.array(v3Question),
  responses: z.array(v3Response),
  gradings: z.array(baselineGradingSchema),
});
export type BaselineQuestionsJsonb = z.infer<typeof baselineQuestionsJsonbSchema>;

/**
 * What `submitBaseline` writes on close. Strict superset of the pre-close
 * shape, with the close-turn outputs added: dual summaries (immutable
 * profile + evolving seed) and the chosen `startingTier`.
 */
export const baselineClosedJsonbSchema = baselineQuestionsJsonbSchema.extend({
  immutableSummary: z.string(),
  summarySeed: z.string(),
  startingTier: z.number().int().positive(),
});
export type BaselineClosedJsonb = z.infer<typeof baselineClosedJsonbSchema>;

/**
 * Row-guard schema: accepts either shape — the closed shape is a strict
 * superset of the pre-close shape, so consumers discriminate by checking
 * `"startingTier" in baseline`.
 *
 * The closed arm is listed first so payloads carrying close-turn fields
 * surface their stricter parse errors (e.g. missing `summarySeed`) rather
 * than silently degrading to the pre-close shape, which would strip those
 * fields.
 */
export const baselineJsonbSchema = z.union([
  baselineClosedJsonbSchema,
  baselineQuestionsJsonbSchema,
]);
export type BaselineJsonb = z.infer<typeof baselineJsonbSchema>;

// --- waves.due_concepts_snapshot ------------------------------------------

/**
 * One entry in the due-concepts snapshot injected at Wave boundaries.
 * Captures which concepts SM-2 scheduled for review and their last quality.
 */
export const dueConceptSnapshotEntrySchema = z.object({
  conceptId: z.string().uuid(),
  name: z.string(),
  tier: z.number().int().min(1),
  /** Null for concepts that have never been assessed (first appearance). */
  lastQuality: qualityScoreSchema.nullable(),
});

/** Array of due concepts frozen at Wave start for LLM prompt injection. */
export const dueConceptsSnapshotSchema = z.array(dueConceptSnapshotEntrySchema);
export type DueConceptsSnapshot = z.infer<typeof dueConceptsSnapshotSchema>;

// --- waves.seed_source (discriminated union) -------------------------------

/**
 * Teaching plan emitted by the LLM on a Wave's final turn.
 * Seeds the next Wave's opening system prompt.
 */
export const blueprintSchema = z.object({
  topic: z.string(),
  outline: z.array(z.string()),
  openingText: z.string(),
});
export type Blueprint = z.infer<typeof blueprintSchema>;

/**
 * How a Wave was seeded. Discriminated union so consumers can branch
 * on whether this is the first Wave (scoping handoff) or a continuation.
 */
export const seedSourceSchema = z.discriminatedUnion("kind", [
  /**
   * Wave 1: seeded from the scoping close-turn output. The blueprint here is
   * the one emitted alongside `startingContext` when scoping finalised,
   * carried over to seed the first teaching Wave's opening prompt.
   */
  z.object({
    kind: z.literal("scoping_handoff"),
    blueprint: blueprintSchema,
  }),
  /** Wave N>1: seeded from the prior Wave's emitted blueprint. */
  z.object({
    kind: z.literal("prior_blueprint"),
    priorWaveId: z.string().uuid(),
    blueprint: blueprintSchema,
  }),
]);
export type SeedSource = z.infer<typeof seedSourceSchema>;

// --- waves.blueprint_emitted (= Blueprint when present) -------------------

/**
 * The blueprint the LLM emitted on this Wave's final turn, or null if the
 * Wave ended without emitting one (e.g. course complete).
 */
export const blueprintEmittedSchema = blueprintSchema.nullable();
