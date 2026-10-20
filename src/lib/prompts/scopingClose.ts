import { BASELINE } from "@/lib/config/tuning";
import { VERDICT_QUALITY_BANDS } from "@/lib/types/jsonbBaseline";
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
 * only the stage label, the escaped input and the scope change per turn.
 */
export interface RenderScopingCloseStageParams {
  /** Already-serialised JSON from `buildScopingCloseLearnerInput`: `{ answers, mechanicalGradings }`. */
  readonly learnerInput: string;
  /** The framework's `baselineScopeTiers`: the levels placement walks. */
  readonly scopeTiers: readonly number[];
}

/**
 * The Harness's placement rule, in the model's words ("level", "lesson").
 * The model drafts Wave 1 in this same turn, before the Harness places the
 * learner. Without the rule it would pitch Wave 1 blind. The text mirrors
 * `determineStartingTier`, and reads its numbers from the same sources, so
 * a retune changes both. Harness text: nothing here is escaped.
 */
function renderPlacementRule(scopeTiers: readonly number[]): string {
  const percent = Math.round(BASELINE.tierMasteryRatio * 100);
  const [correctLo, correctHi] = VERDICT_QUALITY_BANDS.correct;
  // Sorted, as `determineStartingTier` sorts: the same scope renders the same bytes.
  const levels = [...scopeTiers].sort((a, b) => a - b).join(", ");
  return `<placement_rule>
The harness places the learner from the gradings. A level is mastered when at least ${percent}% of its baseline answers are correct (qualityScore ${correctLo}-${correctHi}). Each answer counts under its question's level. The learner starts at the lowest level in scope (${levels}) where under ${percent}% of answers are correct, or at the highest level if all are mastered. A level with no answers counts as under ${percent}%. Pitch the first lesson's opening text and planned concepts at that level.
</placement_rule>`;
}

/** Render the user-role envelope for the close-scoping turn: stage, learner input, placement rule. */
export function renderScopingCloseStage(params: RenderScopingCloseStageParams): string {
  const envelope = renderStageEnvelope({
    stage: "close scoping",
    learnerInput: params.learnerInput,
  });
  return `${envelope}
${renderPlacementRule(params.scopeTiers)}`;
}
