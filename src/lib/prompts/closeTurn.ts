import { z } from "zod/v4";
import { qualityScoreSchema } from "@/lib/types/spaced-repetition";

const VERDICT_QUALITY_BANDS: Readonly<
  Record<"correct" | "partial" | "incorrect", readonly [number, number]>
> = {
  correct: [4, 5],
  partial: [2, 3],
  incorrect: [0, 1],
};

/**
 * Grading item — discriminated by ANSWER kind, not card kind. An MC question
 * answered via the free-text escape is graded as free-text because that is
 * what the model has to evaluate (spec §4.1 rationale).
 */
export const closeGradingItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mc-index"),
    questionId: z
      .string()
      .describe("Verbatim question id from the prompt — match the card the learner clicked."),
    rationale: z
      .string()
      .describe(
        "Two sentences. First: what the click tells you. Second: what to teach next given this signal.",
      ),
  }),
  z.object({
    kind: z.literal("free-text"),
    questionId: z.string(),
    verdict: z
      .enum(["correct", "partial", "incorrect"])
      .describe(
        "Judge the learner's text. 'correct' captures the key idea; 'partial' some grasp + missing pieces; 'incorrect' misses or wrong.",
      ),
    qualityScore: qualityScoreSchema.describe(
      "0-5. correct → 4-5, partial → 2-3, incorrect → 0-1.",
    ),
    conceptName: z
      .string()
      .min(1)
      .describe("Concept this question probes — verbatim from the prompt's concept list."),
    conceptTier: z
      .number()
      .int()
      .describe("Tier (level) of the concept; must be within the in-scope tiers from the prompt."),
    rationale: z
      .string()
      .describe(
        "Two sentences. First: why this verdict given the learner's text. Second: what to teach next.",
      ),
  }),
]);

/** Planned concept entry — surfaces in the blueprint for the next Wave. */
export const plannedConceptSchema = z.object({
  name: z.string().min(1).describe("Exact concept name (verbatim from <planned_concepts>)."),
  tier: z.number().int(),
  role: z
    .enum(["fresh", "review"])
    .describe("'review' for SM-2-due concepts (must be in reviewDueNames); 'fresh' for new ones."),
});

/** Blueprint for the next lesson — shared by scoping-close and wave-close. */
export const blueprintSchema = z.object({
  topic: z.string().min(1).describe("Name the next lesson's focus in 3-7 words."),
  outline: z
    .array(z.string().min(1))
    .min(1)
    .describe("3-6 beats, phrase per bullet, in teaching order."),
  openingText: z
    .string()
    .min(1)
    .describe("2-4 sentence first message. Conversational, warm, no markdown headers."),
  plannedConcepts: z
    .array(plannedConceptSchema)
    .describe("Concepts you intend to teach this lesson. May be empty for consolidation lessons."),
});

export interface MakeCloseTurnBaseSchemaParams {
  readonly scopeTiers: readonly number[];
  readonly questionIds: readonly string[];
  /** Concept names the model may use under role:"fresh". Loose — refine accepts novel names. */
  readonly freshConceptNames: readonly string[];
  /** Concept names SM-2-due at close. Strict — role:"review" entries MUST be in this list. */
  readonly reviewDueNames: readonly string[];
  /**
   * Every concept that exists on this course at close time. Used by
   * `makeWaveCloseSchema` to validate `conceptUpdates[].name`. Empty for
   * scoping (no concepts exist yet pre-close).
   */
  readonly existingConceptNames: readonly string[];
}

/**
 * Shared close-turn base. Returns a Zod object schema with the fields every
 * close-turn (scoping or wave-end) emits. Tier-band and id-coverage invariants
 * are runtime-closed over `scopeTiers` / `questionIds` so the refine messages
 * can name the specific values that triggered the violation.
 */
export function makeCloseTurnBaseSchema(params: MakeCloseTurnBaseSchemaParams) {
  const scope = new Set(params.scopeTiers);
  const idSet = new Set(params.questionIds);
  const reviewDue = new Set(params.reviewDueNames);

  return z
    .object({
      userMessage: z
        .string()
        .min(1)
        .describe(
          "Message the learner sees as the closing of this turn. 2-3 sentences. Conversational.",
        ),
      gradings: z
        .array(closeGradingItemSchema)
        .describe("One entry per question the learner answered. Cover every id."),
      summary: z.string().min(1).describe("2-3 sentences capturing where the learner stands now."),
      nextUnitBlueprint: blueprintSchema,
    })
    .superRefine((val, ctx) => {
      // 1. Verdict/qualityScore band — free-text gradings only.
      val.gradings.forEach((g, idx) => {
        if (g.kind !== "free-text") return;
        const [lo, hi] = VERDICT_QUALITY_BANDS[g.verdict];
        if (g.qualityScore < lo || g.qualityScore > hi) {
          ctx.addIssue({
            code: "custom",
            path: ["gradings", idx, "qualityScore"],
            message: `grading for ${g.questionId}: verdict='${g.verdict}' requires qualityScore in [${lo}, ${hi}], got ${g.qualityScore}.`,
          });
        }
        if (!scope.has(g.conceptTier)) {
          ctx.addIssue({
            code: "custom",
            path: ["gradings", idx, "conceptTier"],
            message: `grading for ${g.questionId}: conceptTier ${g.conceptTier} is outside [${[...scope].join(", ")}].`,
          });
        }
      });
      // 2. Unique question ids in gradings.
      const ids = val.gradings.map((g) => g.questionId);
      const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
      if (dupes.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["gradings"],
          message: `duplicate questionIds in gradings: ${[...new Set(dupes)].join(", ")}`,
        });
      }
      // 3. Every question covered.
      const missing = [...idSet].filter((id) => !ids.includes(id));
      if (missing.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["gradings"],
          message: `gradings missing for question ids: ${missing.join(", ")}`,
        });
      }
      // 4. plannedConcepts.role='review' names must be in reviewDueNames.
      val.nextUnitBlueprint.plannedConcepts.forEach((pc, idx) => {
        if (pc.role === "review" && !reviewDue.has(pc.name)) {
          ctx.addIssue({
            code: "custom",
            path: ["nextUnitBlueprint", "plannedConcepts", idx, "name"],
            message: `review-role plannedConcept '${pc.name}' not in reviewDueNames [${params.reviewDueNames.join(", ")}].`,
          });
        }
      });
      // 5. plannedConcepts.name unique (no fresh/review collision).
      const pcNames = val.nextUnitBlueprint.plannedConcepts.map((pc) => pc.name);
      const pcDupes = pcNames.filter((n, i) => pcNames.indexOf(n) !== i);
      if (pcDupes.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["nextUnitBlueprint", "plannedConcepts"],
          message: `duplicate plannedConcept names (fresh/review collision?): ${[...new Set(pcDupes)].join(", ")}`,
        });
      }
    });
}

export type CloseTurnBase = z.infer<ReturnType<typeof makeCloseTurnBaseSchema>>;
