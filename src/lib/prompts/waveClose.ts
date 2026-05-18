import { z } from "zod/v4";
import { qualityScoreSchema } from "@/lib/types/spaced-repetition";
import { makeCloseTurnBaseSchema, type MakeCloseTurnBaseSchemaParams } from "./closeTurn";

const conceptUpdateSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe("Exact concept name (matches an existing concept on the course)."),
  qualityScore: qualityScoreSchema.describe(
    "Your holistic judgement of how well this concept was retaught/reviewed across the lesson. 0-5.",
  ),
  reason: z.string().min(1).describe("One sentence: what in the lesson justifies this score."),
});

/**
 * Wave-close schema = base + `conceptUpdates[]` (SM-2 batch).
 *
 * Why batched at close, not per-question: a single question is not enough to
 * declare a concept retaught. The model decides holistically across the Wave
 * which concepts have been taught enough to warrant an SM-2 advance.
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
          .describe("Concepts you judge taught well enough this lesson to advance their SM-2."),
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
  readonly responseSchema?: string;
}

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
