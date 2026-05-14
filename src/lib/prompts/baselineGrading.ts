import { z } from "zod/v4";
import { qualityScoreSchema } from "@/lib/types/spaced-repetition";

const verdictSchema = z
  .enum(["correct", "partial", "incorrect"])
  .describe("[server] Overall verdict on the learner's answer. Drives SM-2 quality bucketing.");

const gradingItemSchema = z.object({
  questionId: z.string().describe("[server] Matches the question's id."),
  conceptName: z
    .string()
    .describe("[server] Concept the question probed (carried from the baseline question)."),
  verdict: verdictSchema,
  qualityScore: qualityScoreSchema.describe(
    "[server] SM-2 quality score 0–5. Map: correct → 4–5, partial → 2–3, incorrect → 0–1. " +
      "Calibrate by depth of understanding shown.",
  ),
  rationale: z
    .string()
    .describe("[server] One- or two-sentence justification. Internal — not shown to the learner."),
});

/**
 * Verdict ↔ qualityScore alignment table.
 *
 * Codifies the description on `qualityScore` ("correct → 4–5, partial → 2–3,
 * incorrect → 0–1") as machine-checkable bands. Without this the model can
 * emit `verdict: "correct"` with `qualityScore: 1` and the post-decode gate
 * passes; SM-2 then schedules a "correct" answer aggressively while XP /
 * tier-advancement logic disagrees. Bands are inclusive on both ends.
 */
const VERDICT_QUALITY_BANDS: Readonly<
  Record<"correct" | "partial" | "incorrect", [number, number]>
> = {
  correct: [4, 5],
  partial: [2, 3],
  incorrect: [0, 1],
};

/**
 * Grade-baseline turn schema. Mirrors the rest of the scoping contract:
 * userMessage (chat) + structured gradings (server-only).
 *
 * Cross-field invariants:
 *   - gradings list has unique questionIds.
 *   - `verdict` matches the band on `qualityScore` (see VERDICT_QUALITY_BANDS).
 *
 * Count bounds come from the submitted answer list — the harness enforces those
 * post-decode in `gradeBaseline.ts` because Cerebras strict mode rejects
 * minItems/maxItems.
 */
export const gradeBaselineSchema = z
  .object({
    userMessage: z
      .string()
      .describe(
        "[chat] Brief warm summary of how the learner did. Do NOT list per-question verdicts here — the UI renders those from `gradings`.",
      ),
    gradings: z
      .array(gradingItemSchema)
      .describe("[server] One grading entry per question that was sent to the grader."),
  })
  .superRefine((val, ctx) => {
    const ids = val.gradings.map((g) => g.questionId);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["gradings"],
        message: `duplicate questionIds in gradings: ${[...new Set(dupes)].join(", ")}`,
      });
    }
    // Verdict-band alignment. Caught here (not in `gradingItemSchema`) so the
    // refine message can quote the questionId for easier model recovery.
    val.gradings.forEach((g, idx) => {
      const [lo, hi] = VERDICT_QUALITY_BANDS[g.verdict];
      if (g.qualityScore < lo || g.qualityScore > hi) {
        ctx.addIssue({
          code: "custom",
          path: ["gradings", idx, "qualityScore"],
          message:
            `grading for ${g.questionId}: verdict='${g.verdict}' requires qualityScore in [${lo}, ${hi}], got ${g.qualityScore}. ` +
            "Map: correct → 4–5, partial → 2–3, incorrect → 0–1.",
        });
      }
    });
  });

export type GradeBaselineTurn = z.infer<typeof gradeBaselineSchema>;
