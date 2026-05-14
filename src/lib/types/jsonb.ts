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
 * Baseline JSONB shapes are defined in `./jsonbBaseline.ts` to keep both
 * files under the 200-LOC ceiling. Re-exported here so callers continue to
 * import everything from `@/lib/types/jsonb`.
 */
export {
  VERDICT_QUALITY_BANDS,
  baselineGradingSchema,
  baselineQuestionsJsonbSchema,
  baselineClosedJsonbSchema,
  baselineJsonbSchema,
} from "./jsonbBaseline";
export type {
  BaselineGrading,
  BaselineQuestionsJsonb,
  BaselineClosedJsonb,
  BaselineJsonb,
} from "./jsonbBaseline";

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
