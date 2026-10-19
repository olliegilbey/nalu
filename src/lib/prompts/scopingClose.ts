import { renderStageEnvelope } from "./scoping";

// The scoping close answers with the shared close-turn base,
// `makeCloseTurnBaseSchema` in `closeTurn.ts`, and nothing more. The model
// does not pick the starting tier: `determineStartingTier`
// (`src/lib/scoring/startingTier.ts`) computes it from the graded answers
// (issue #94). Nor does it write a second, "immutable" summary: its one
// summary becomes `courses.summary` (issue #93).

/**
 * Stage envelope for the close-scoping turn. The learner-input payload carries
 * the per-question answers and mechanical MC results so the model can read
 * what was submitted without re-asking. Cache-prefix stability is preserved —
 * only the stage label and the escaped input change per turn.
 */
export interface RenderScopingCloseStageParams {
  /** Already-serialised JSON from `buildScopingCloseLearnerInput`: `{ answers, mechanicalGradings }`. */
  readonly learnerInput: string;
}

/** Render the user-role envelope for the close-scoping turn. */
export function renderScopingCloseStage(params: RenderScopingCloseStageParams): string {
  return renderStageEnvelope({
    stage: "close scoping",
    learnerInput: params.learnerInput,
  });
}
