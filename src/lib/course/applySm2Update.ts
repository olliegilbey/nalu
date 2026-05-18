import type { DbOrTx } from "@/db/client";
import { calculateSM2 } from "@/lib/spaced-repetition/sm2";
import { getConceptByNameForCourse, updateConceptSm2 } from "@/db/queries/concepts";

/** Inputs to `applySm2Update`. */
export interface ApplySm2UpdateParams {
  /** Course the concept belongs to (used for the case-insensitive name lookup). */
  readonly courseId: string;
  /** Concept name as emitted by the LLM close-turn payload. */
  readonly name: string;
  /** Final qualityScore for this concept across the Wave (0-5). */
  readonly qualityScore: number;
  /** Reference time — flows through to `lastReviewedAt` and `nextReviewAt`. */
  readonly now: Date;
  /** Caller's transaction handle — shared by the lookup AND the write. */
  readonly tx: DbOrTx;
}

/**
 * Close-only SM-2 step. Reads current state, calls pure `calculateSM2`,
 * persists. NO XP touch — XP was already awarded per-question by
 * `applyAssessmentGrading` calls earlier in the close transaction.
 *
 * Lookup uses the `tx` handle so a concept inserted earlier in the same
 * transaction (e.g. via `upsertConcept`) is visible — the singleton `db`
 * would not see uncommitted rows from the caller's tx.
 *
 * @throws {Error} if the concept name is missing on the course. The
 *   schema's `existingConceptNames` refine should have caught this upstream,
 *   but a stale read between schema-build and persist is theoretically possible.
 */
export async function applySm2Update(params: ApplySm2UpdateParams): Promise<void> {
  // Read current SM-2 state via the SAME tx so we observe any pending writes.
  const concept = await getConceptByNameForCourse(params.courseId, params.name, params.tx);
  if (!concept) {
    throw new Error(
      `applySm2Update: concept '${params.name}' missing on course ${params.courseId}`,
    );
  }
  // Pure SM-2 step: existing state + quality + now → next state + nextReviewAt.
  const next = calculateSM2(
    {
      easinessFactor: concept.easinessFactor,
      interval: concept.intervalDays,
      repetitionCount: concept.repetitionCount,
    },
    params.qualityScore,
    params.now,
  );
  await updateConceptSm2(
    concept.id,
    {
      easinessFactor: next.easinessFactor,
      intervalDays: next.interval,
      repetitionCount: next.repetitionCount,
      // qualityScore was already validated upstream by `qualityScoreSchema`
      // before reaching this function — the cast is plan-faithful.
      lastQualityScore: params.qualityScore as 0 | 1 | 2 | 3 | 4 | 5,
      lastReviewedAt: params.now,
      nextReviewAt: next.nextReviewAt,
    },
    params.tx,
  );
}
