import { z } from "zod/v4";
import { qualityScoreSchema } from "@/lib/types/spaced-repetition";
import { makeCloseTurnBaseSchema, type MakeCloseTurnBaseSchemaParams } from "./closeTurn";

/** Per-concept SM-2 update emitted in the wave-close batch. */
const conceptUpdateSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe("Exact concept name (matches an existing concept on the course)."),
  qualityScore: qualityScoreSchema.describe(
    "0-5. How well the LEARNER demonstrated they understand this concept this lesson — judged from their own answers and explanations, not from how well you taught it. Score high only when they actively showed mastery: a correct answer reasoned in their own words. If they got a related question wrong, said nothing about it, or only had it explained to them, score low. This score drives the spaced-repetition schedule — inflating it makes the system believe they know something they have not shown.",
  ),
  reason: z
    .string()
    .min(1)
    .describe("One sentence: what the learner said or did this lesson that justifies this score."),
});

/**
 * Wave-close schema = base + `conceptUpdates[]` (SM-2 batch).
 *
 * Why batched at close, not per-question: a single question is not enough to
 * judge a concept. The model decides holistically across the Wave how well the
 * learner *demonstrated* each concept, scoring SM-2 quality from the learner's
 * own answers — not from how much teaching coverage the concept received.
 * Per-question gradings drive XP + feedback toasts; only SM-2 state lives here.
 */
export function makeWaveCloseSchema(params: MakeCloseTurnBaseSchemaParams) {
  const existing = new Set(params.existingConceptNames);
  const base = makeCloseTurnBaseSchema(params);

  return base.and(
    z
      .object({
        conceptUpdates: z
          .array(conceptUpdateSchema)
          .describe(
            "One entry per concept the learner actively worked with this lesson, each scored on what they demonstrated — not on what you covered. A concept the learner struggled with belongs here too, with a low score; omit only concepts they never engaged with.",
          ),
      })
      .superRefine((val, ctx) => {
        val.conceptUpdates.forEach((u, idx) => {
          if (!existing.has(u.name)) {
            ctx.addIssue({
              code: "custom",
              path: ["conceptUpdates", idx, "name"],
              message: `conceptUpdates[${idx}].name='${u.name}' is not an existing concept. Valid names: [${params.existingConceptNames.join(", ")}].`,
            });
          }
        });
      }),
  );
}

export type WaveCloseTurn = z.infer<ReturnType<typeof makeWaveCloseSchema>>;

export interface RenderWaveCloseEnvelopeParams {
  readonly learnerInput: string;
  /** Pre-rendered `<concepts_for_next_wave>…</concepts_for_next_wave>` block from `scheduler.renderConceptInjection`. */
  readonly conceptsForNextWaveBlock: string;
  /** Optional inline JSON schema for non-strict-mode models. */
  readonly responseSchema?: string;
}

/**
 * Renders the close-turn user envelope for a Wave. `turns_remaining=0` is
 * hardcoded — this IS the close turn, so by definition no further turns
 * remain in this Wave. The harness still injects the value explicitly so
 * the model's contract ("read turns_remaining each turn") stays uniform.
 * `learnerInput` and `conceptsForNextWaveBlock` are XML-escaped upstream
 * by the caller; this function only stitches.
 */
export function renderWaveCloseEnvelope(params: RenderWaveCloseEnvelopeParams): string {
  const schemaBlock = params.responseSchema
    ? `<response_schema>${params.responseSchema}</response_schema>`
    : "";
  return [
    "<stage>close wave</stage>",
    params.learnerInput,
    "<turns_remaining>0</turns_remaining>",
    params.conceptsForNextWaveBlock,
    schemaBlock,
  ]
    .filter((s) => s !== "")
    .join("\n");
}
