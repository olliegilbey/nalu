import { z } from "zod/v4";
import { qualityScoreSchema } from "@/lib/types/spaced-repetition";

/**
 * Verdict ↔ qualityScore alignment. Mirrors the v3 storage table in
 * `src/lib/types/jsonb.ts` — keep them in sync.
 */
const VERDICT_QUALITY_BANDS: Readonly<
  Record<"correct" | "partial" | "incorrect", readonly [number, number]>
> = {
  correct: [4, 5],
  partial: [2, 3],
  incorrect: [0, 1],
};

/** One grading item — shape shared by scoping-close and (future) wave-end. */
export const closeGradingItemSchema = z.object({
  questionId: z
    .string()
    .describe(
      "The id of the question you are grading. Copy verbatim from the question this evaluation refers to.",
    ),
  verdict: z
    .enum(["correct", "partial", "incorrect"])
    .describe(
      "Judge the learner's answer against the expected answer. Use 'correct' only when the answer captures the key idea; 'partial' when the learner shows some grasp but misses important pieces; 'incorrect' when the answer misses the point or is wrong.",
    ),
  qualityScore: qualityScoreSchema.describe(
    "Score the answer 0-5. 5 = fluent, fully correct. 4 = correct with minor gaps. 3 = mostly right, notable gap. 2 = partial grasp, important errors. 1 = wrong but related. 0 = no understanding. Keep this in band with your verdict (correct → 4-5, partial → 2-3, incorrect → 0-1).",
  ),
  conceptName: z
    .string()
    .min(1)
    .describe(
      "Name the single concept this question probes. Use the noun-phrase a learner would search for, e.g. 'Rust ownership', not 'the idea that values have owners'. Keep names consistent across questions that probe the same concept.",
    ),
  conceptTier: z
    .number()
    .int()
    .describe(
      "Place the concept at the level a learner needs to reach to grasp it confidently. Use the level numbers from the framework you produced earlier in this conversation. Don't drift outside the framework's level range.",
    ),
  rationale: z
    .string()
    .describe(
      "Two sentences. First sentence: name what the learner got right or wrong. Second sentence: what this tells you about where to start teaching them.",
    ),
});

/** Blueprint for the following lesson — shared by scoping-close and wave-end. */
export const blueprintSchema = z.object({
  topic: z
    .string()
    .min(1)
    .describe(
      "Name the focus of the first lesson in 3-7 words. This is the headline the learner sees when they enter the lesson.",
    ),
  outline: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      "List the beats of the first lesson, one bullet per beat, 3-6 bullets. Order them in the sequence you'll teach them. Each beat is a phrase, not a sentence.",
    ),
  openingText: z
    .string()
    .min(1)
    .describe(
      "Write the first message the learner sees when they open lesson 1. 2-4 sentences. Greet them by what you've learned about them, name what you'll teach in this lesson, invite their first response. Conversational, warm, no markdown headers.",
    ),
});

export interface MakeCloseTurnBaseSchemaParams {
  readonly scopeTiers: readonly number[];
  readonly questionIds: readonly string[];
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

  return z
    .object({
      userMessage: z
        .string()
        .min(1)
        .describe(
          "Write the message the learner sees as the closing of this planning conversation. Acknowledge a specific thing you've learned about them, then signal that their first lesson is ready. 2-3 sentences. Conversational.",
        ),
      gradings: z
        .array(closeGradingItemSchema)
        .describe(
          "Produce one grading entry per question the learner answered. Cover every question — don't drop any.",
        ),
      summary: z
        .string()
        .min(1)
        .describe(
          "Write a 2-3 sentence summary of where this learner is starting from in this subject, based on how they performed so far. This summary will grow as the course progresses; you're writing its current state.",
        ),
      nextUnitBlueprint: blueprintSchema.describe(
        "The plan for the first lesson. The learner will see `openingText` when they enter that lesson.",
      ),
    })
    .superRefine((val, ctx) => {
      // 1. Verdict/qualityScore band.
      val.gradings.forEach((g, idx) => {
        const [lo, hi] = VERDICT_QUALITY_BANDS[g.verdict];
        if (g.qualityScore < lo || g.qualityScore > hi) {
          ctx.addIssue({
            code: "custom",
            path: ["gradings", idx, "qualityScore"],
            message:
              `grading for ${g.questionId}: verdict='${g.verdict}' requires qualityScore in [${lo}, ${hi}], got ${g.qualityScore}. ` +
              "Map: correct → 4-5, partial → 2-3, incorrect → 0-1.",
          });
        }
        // 2. conceptTier in scope.
        if (!scope.has(g.conceptTier)) {
          ctx.addIssue({
            code: "custom",
            path: ["gradings", idx, "conceptTier"],
            message: `grading for ${g.questionId}: conceptTier ${g.conceptTier} is outside the framework's level range [${[...scope].join(", ")}].`,
          });
        }
      });
      // 3. Unique question ids.
      const ids = val.gradings.map((g) => g.questionId);
      const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
      if (dupes.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["gradings"],
          message: `duplicate questionIds in gradings: ${[...new Set(dupes)].join(", ")}`,
        });
      }
      // 4. Every question covered.
      const missing = [...idSet].filter((id) => !ids.includes(id));
      if (missing.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["gradings"],
          message: `gradings missing for question ids: ${missing.join(", ")}`,
        });
      }
      // 5. No stray ids.
      const stray = ids.filter((id) => !idSet.has(id));
      if (stray.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["gradings"],
          message: `gradings include unknown question ids: ${stray.join(", ")}`,
        });
      }
    });
}

export type CloseTurnBase = z.infer<ReturnType<typeof makeCloseTurnBaseSchema>>;
