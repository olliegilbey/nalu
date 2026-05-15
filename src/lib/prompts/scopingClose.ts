import { z } from "zod/v4";
import { makeCloseTurnBaseSchema, type MakeCloseTurnBaseSchemaParams } from "./closeTurn";
import { renderStageEnvelope } from "./scoping";

/**
 * Scoping-only extensions on the shared close-turn base. The model emits two
 * one-shot fields exclusive to scoping close:
 *   - `immutableSummary`: durable learner profile, written once.
 *   - `startingTier`: the level lesson 1 starts at.
 *
 * Both are clamped to the framework's `scopeTiers` via a superRefine layered
 * on top of the base schema's grading-tier refine. Refine failures route back
 * into `executeTurn`'s ValidationGateFailure retry as teacher-style messages.
 */
export function makeScopingCloseSchema(params: MakeCloseTurnBaseSchemaParams) {
  const scope = new Set(params.scopeTiers);
  const base = makeCloseTurnBaseSchema(params);

  return base.and(
    z
      .object({
        immutableSummary: z
          .string()
          .min(1)
          .describe(
            "Capture the durable facts about this learner that should ground every future lesson: their background, what they're trying to achieve, what they already know, what motivates them. 3-5 sentences. Write what you'd want to be reminded of at the start of every lesson you teach them.",
          ),
        startingTier: z
          .number()
          .int()
          .describe(
            "Choose the framework level at which lesson 1 should begin teaching. Base it on the learner's performance: where did they show competence, where did they show gaps? Pick the lowest level at which they need real teaching. Stay inside the framework's level range.",
          ),
      })
      .superRefine((val, ctx) => {
        if (!scope.has(val.startingTier)) {
          ctx.addIssue({
            code: "custom",
            path: ["startingTier"],
            message: `startingTier ${val.startingTier} is outside the framework's level range [${[...scope].join(", ")}]. Choose one of the levels in that range.`,
          });
        }
      }),
  );
}

export type ScopingCloseTurn = z.infer<ReturnType<typeof makeScopingCloseSchema>>;

/**
 * Stage envelope for the close-scoping turn. The learner-input payload carries
 * the per-question answers and mechanical MC results so the model can read
 * what was submitted without re-asking. Cache-prefix stability is preserved —
 * only the stage label, the escaped input, and the schema JSON change per turn.
 */
export interface RenderScopingCloseStageParams {
  /** Already-serialised JSON of `{ items: [...] }` for the close turn. */
  readonly learnerInput: string;
  /** Optional inline JSON-schema string for non-strict-mode models. */
  readonly responseSchema?: string;
}

export function renderScopingCloseStage(params: RenderScopingCloseStageParams): string {
  return renderStageEnvelope({
    stage: "close scoping",
    learnerInput: params.learnerInput,
    responseSchema: params.responseSchema,
  });
}
