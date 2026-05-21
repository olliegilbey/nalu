import { sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { getAssessmentByWaveAndQuestionId } from "@/db/queries/assessments";
import { checkTierAdvancement } from "@/lib/scoring/progression";
import type { ConceptState } from "@/lib/types/scoring";
import type { WaveCloseTurn } from "@/lib/prompts/waveClose";
import type { WaveChatLog } from "@/lib/types/jsonbWaveChatLog";
import { applyAssessmentGrading, type GradedSignal } from "./applyAssessmentGrading";
import { findOpenQuestionnaire } from "./findOpenQuestionnaire";
import { namespaceQuestionId } from "./namespaceQuestionId";
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
 * MC questions are graded mid-turn (see `executeWaveMid.grade.ts`); receiving
 * an `mc-index` here means the LLM emitted a contract violation. Future work
 * (TODO.md) tightens the wave-close schema to drop the mc-index branch via a
 * superRefine so `executeTurn` can retry with a directive — until then, fail
 * loud so the orphan assessment row + under-counted SM-2 signal don't slip
 * through silently.
 *
 * The stored `question_id` column is namespaced per questionnaire
 * (`namespaceQuestionId`), but the model grades using the RAW `q.id` it saw in
 * the close-turn prompt's `questionIds`. We re-derive the namespace prefix from
 * the open questionnaire's id (the same one `executeWaveClose` fed the schema)
 * so the row lookup hits; the surfaced `questionId` stays raw for the client.
 */
export async function applyCloseGradings(
  tx: DbOrTx,
  ctx: LoadedWaveContext,
  parsed: WaveCloseTurn,
): Promise<readonly PersistedGradedSignal[]> {
  // Re-derive the open questionnaire being graded — its id namespaces the
  // stored `question_id` lookup. `ctx.wave.chatLog` is `unknown` at the Drizzle
  // JSONB boundary; runtime shape is guaranteed by `waveRowGuard` upstream.
  const openQuestionnaire = findOpenQuestionnaire(ctx.wave.chatLog as WaveChatLog);
  // Reduce keeps `eslint-plugin-functional/immutable-data` happy when we need
  // to accumulate results; the awaited accumulator threads them through.
  // Sequential by design — writes share one tx handle and grading counts at
  // close are tiny (0–1 free-text items). The SM-2 loop in
  // `persistWaveClose.ts` uses a plain `for…of` because it's purely effectful
  // (no accumulation), so the reduce-vs-for-of split is driven by whether we
  // need to thread a value, not by lint policy.
  return parsed.gradings.reduce<Promise<readonly PersistedGradedSignal[]>>(async (accP, g) => {
    const acc = await accP;
    if (g.kind === "mc-index") {
      // Contract violation — MC questions are graded mid-turn, not at close.
      // The shared `closeGradingItemSchema` permits this branch because it's
      // reused with scoping; the wave-close orchestrator never grades MC.
      throw new Error(
        `[executeWaveClose] mc-index grading at close is a contract violation; questionId=${g.questionId}`,
      );
    }
    // Namespace the raw `g.questionId` with the open questionnaire's id to hit
    // the stored row. If no questionnaire is open there is nothing to grade —
    // fall through to the null-row skip below (the model emitted a stale id).
    const storedQuestionId = openQuestionnaire
      ? namespaceQuestionId(openQuestionnaire.questionnaireId, g.questionId)
      : g.questionId;
    const row = await getAssessmentByWaveAndQuestionId(ctx.wave.id, storedQuestionId, tx);
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
