import { sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { getAssessmentByWaveAndQuestionId } from "@/db/queries/assessments";
import { checkTierAdvancement } from "@/lib/scoring/progression";
import type { ConceptState } from "@/lib/types/scoring";
import type { WaveCloseTurn } from "@/lib/prompts/waveClose";
import { applyAssessmentGrading, type GradedSignal } from "./applyAssessmentGrading";
import type { LoadedWaveContext } from "./loadWaveContext";

/**
 * Internal helpers for `persistWaveClose` — split out to keep both files under
 * the ~200-line ceiling. Mirrors the `executeWaveMid.{ts,grade.ts,insert.ts}`
 * pattern. Not re-exported via the barrel; only `persistWaveClose` calls these.
 */

/**
 * Per-question grading projection surfaced back to the orchestrator. Mirrors
 * the mid-turn shape so the upstream `submitWaveTurn` union can be uniform.
 */
export interface PersistedGradedSignal {
  readonly kind: GradedSignal["kind"];
  readonly questionId: string;
  readonly xpAwarded: number;
}

/**
 * Apply each close-grading to the corresponding assessment row.
 *
 * Free-text path: route through `applyAssessmentGrading` with the parsed
 * payload's verdict + qualityScore. The `conceptTier` comes from the grading
 * item itself (the schema enforces it's in-scope).
 *
 * MC path: defensive skip + log. The close-turn mc-index variant carries no
 * correctness boolean; computing it requires the learner's selected letter
 * (from the submitTurn payload), which the close orchestrator does not yet
 * accept. A future task adds the payload parameter; until then logging the
 * skip keeps the row in placeholder state instead of corrupting it.
 */
export async function applyCloseGradings(
  tx: DbOrTx,
  ctx: LoadedWaveContext,
  parsed: WaveCloseTurn,
): Promise<readonly PersistedGradedSignal[]> {
  // Reduce keeps `eslint-plugin-functional` happy (no for/push); the awaited
  // accumulator threads results through. Sequential by design — writes share
  // one tx handle and grading counts at close are tiny (0–1 free-text items).
  return parsed.gradings.reduce<Promise<readonly PersistedGradedSignal[]>>(async (accP, g) => {
    const acc = await accP;
    if (g.kind === "mc-index") {
      process.stderr.write(
        `[executeWaveClose] mc-index grading at close not yet supported; skipping questionId=${g.questionId}\n`,
      );
      return acc;
    }
    const row = await getAssessmentByWaveAndQuestionId(ctx.wave.id, g.questionId, tx);
    if (!row) {
      process.stderr.write(
        `[executeWaveClose] no assessment row for wave=${ctx.wave.id} questionId=${g.questionId}; skipping\n`,
      );
      return acc;
    }
    const applied = await applyAssessmentGrading({
      assessmentId: row.id,
      conceptTier: g.conceptTier,
      signal: {
        kind: "free-text",
        questionId: g.questionId,
        verdict: g.verdict,
        qualityScore: g.qualityScore,
      },
      tx,
    });
    return [
      ...acc,
      { kind: applied.kind, questionId: applied.questionId, xpAwarded: applied.xpAwarded },
    ];
  }, Promise.resolve([]));
}

/**
 * Run `checkTierAdvancement` against current-tier concepts with a known
 * lastQualityScore. On advance, bump `courses.current_tier` inside the same
 * tx (raw UPDATE — the helper `updateCourseTier` uses the `db` singleton and
 * would deadlock here, same rationale as in `persistScopingClose`).
 *
 * Returns the new tier number on advance; null otherwise.
 */
export async function maybeAdvanceTier(
  tx: DbOrTx,
  courseId: string,
  currentTier: number,
  allConcepts: readonly { readonly tier: number; readonly lastQualityScore: number | null }[],
): Promise<number | null> {
  // ConceptState requires a concrete QualityScore — never-assessed concepts
  // (lastQualityScore null) are excluded so they don't drag the passing ratio.
  // The cast at the end is safe because lastQualityScore is constrained to
  // 0..5 by a DB CHECK (`concepts_last_quality_score_range`).
  const conceptStates: readonly ConceptState[] = allConcepts
    .filter((c) => c.tier === currentTier && c.lastQualityScore !== null)
    .map((c) => ({ lastQualityScore: c.lastQualityScore as 0 | 1 | 2 | 3 | 4 | 5 }));
  const advancement = checkTierAdvancement(conceptStates);
  if (!advancement.canAdvance) return null;
  const newTier = currentTier + 1;
  await tx.execute(sql`
    UPDATE courses
    SET current_tier = ${newTier},
        updated_at = NOW()
    WHERE id = ${courseId}
  `);
  return newTier;
}
