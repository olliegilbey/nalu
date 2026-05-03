import { z } from "zod";
import { qualityScoreSchema } from "@/lib/types/spaced-repetition";

/**
 * Trust-boundary Zod schemas for every JSONB column shape.
 *
 * Every read function in `src/db/queries/` runs these against the JSONB
 * payload before handing rows to consumers. drizzle-zod alone returns
 * `unknown` for JSONB; these schemas tighten that.
 *
 * Schemas mirror the `<...>` envelopes defined in spec §6.5 and the
 * existing prompt schemas under `src/lib/prompts/`.
 */

// --- courses.clarification -------------------------------------------------

/**
 * A single question emitted by the LLM during the scoping clarification step.
 *
 * Discriminated union so:
 *   - `single_select` requires ≥2 options (a radio group needs a choice)
 *   - `free_text` explicitly forbids an `options` field (Zod's discriminator
 *     strips unknown keys, so any accidental `options` is silently dropped —
 *     the important thing is we no longer allow it through unvalidated)
 *
 * WHY discriminated union over a plain object with optional `options`?
 * The old schema allowed `{type:"single_select"}` with no options, and
 * allowed `{type:"free_text", options:[...]}` — both are nonsensical at the
 * domain level. CodeRabbit Major finding requested tighter enforcement.
 */
export const clarificationQuestionSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string(),
    text: z.string(),
    type: z.literal("single_select"),
    // single_select needs ≥2 options to present a meaningful radio group.
    options: z.array(z.string()).min(2),
  }),
  // `.strict()` makes Zod error if the LLM smuggles an `options` array into
  // a free_text question. Without `.strict()`, Zod silently strips unknown keys
  // and the invariant is unenforced. CodeRabbit Major: tighten JSONB schemas.
  z
    .object({
      id: z.string(),
      text: z.string(),
      type: z.literal("free_text"),
      // Explicitly NO options field — free_text renders an open input box.
    })
    .strict(),
]);

/** The learner's answer to one clarification question. */
export const clarificationAnswerSchema = z.object({
  questionId: z.string(),
  answer: z.string(),
});

/**
 * Full JSONB payload stored in `courses.clarification`.
 * Persists both what the LLM asked and what the learner answered,
 * so the scoping context can be reconstructed without re-querying LLM.
 */
export const clarificationJsonbSchema = z.object({
  questions: z.array(clarificationQuestionSchema),
  answers: z.array(clarificationAnswerSchema),
});
export type ClarificationJsonb = z.infer<typeof clarificationJsonbSchema>;

// --- courses.framework -----------------------------------------------------

/** One rung of the learning ladder for a topic. */
export const tierSchema = z.object({
  number: z.number().int().min(1),
  name: z.string(),
  description: z.string(),
  example_concepts: z.array(z.string()),
});

/**
 * Full JSONB payload stored in `courses.framework`.
 * Produced by the framework step; seeds the first Wave's blueprint.
 */
export const frameworkJsonbSchema = z.object({
  topic: z.string(),
  scope_summary: z.string(),
  estimated_starting_tier: z.number().int().min(1),
  /** Tiers the baseline assessment covers — a subset of all tiers. */
  baseline_scope_tiers: z.array(z.number().int().min(1)),
  tiers: z.array(tierSchema),
});
export type FrameworkJsonb = z.infer<typeof frameworkJsonbSchema>;

// --- courses.baseline ------------------------------------------------------

/** LLM grading output for one baseline question. */
export const baselineGradingSchema = z.object({
  question_id: z.string(),
  concept_name: z.string(),
  quality_score: qualityScoreSchema,
  is_correct: z.boolean(),
  rationale: z.string(),
});

/**
 * Full JSONB payload stored in `courses.baseline`.
 * Questions and answers are opaque after grading (any shape the LLM emitted);
 * only gradings need strict typing for downstream progression logic.
 */
export const baselineJsonbSchema = z.object({
  questions: z.array(z.unknown()), // generated payload — opaque after grading
  answers: z.array(z.unknown()),
  gradings: z.array(baselineGradingSchema),
});
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
  /** Wave 1: seeded directly from the scoping framework output. */
  z.object({ kind: z.literal("scoping_handoff") }),
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
