import { eq, sql } from "drizzle-orm";
import { db, type DbOrTx } from "@/db/client";
import { assessments, type Assessment } from "@/db/schema";
import type { QualityScore } from "@/lib/types/spaced-repetition";
import { NotFoundError } from "./errors";

/**
 * `assessments` grading write: scores an existing row in place.
 *
 * `insertOpenAssessments` writes rows with placeholder grading fields; the
 * mid-turn and close grading paths fill them in here.
 */

/**
 * Grading patch applied to an existing assessment row after the LLM scores it.
 *
 * Only the three fields that flip from placeholders (set at insert time) to
 * final scored values: correctness, quality, and XP. All other columns
 * (waveId, conceptId, turnIndex, question, userAnswer, kind, assessedAt) are
 * immutable post-insert.
 */
export interface UpdateAssessmentGradingParams {
  /** Final correctness verdict (`verdict === "correct"` for free-text). */
  readonly isCorrect: boolean;
  /** LLM-assigned quality score 0-5; for MC use 4/1 (correct/incorrect). */
  readonly qualityScore: QualityScore;
  /** XP awarded — deterministic, computed by `calculateXP` / `calculateMcXp`. */
  readonly xpAwarded: number;
  /**
   * Optional learner answer text. Set when grading replaces the placeholder
   * userAnswer (`""`) inserted at probe-time by `insertOpenAssessments` — the
   * real text only becomes known when the learner replies. Omit to leave the
   * existing `user_answer` column untouched (e.g. `inferred` rows, where the
   * answer is stored at insert time and never updated).
   */
  readonly userAnswer?: string;
}

/**
 * Persist grading results onto an existing assessment row.
 *
 * Uses raw SQL UPDATE (house style). Re-fetches via a typed Drizzle select
 * so the returned row goes through Drizzle's camelCase mapping (mirrors the
 * `updateConceptSm2` pattern).
 *
 * Optional `tx` opts the UPDATE and re-fetch into a caller's transaction.
 * BOTH operations must run on the same executor — using `db` for the re-fetch
 * after a tx UPDATE would query a different connection that cannot see the
 * uncommitted change.
 *
 * @throws {NotFoundError} if `id` does not match any row.
 */
export async function updateAssessmentGrading(
  id: string,
  params: UpdateAssessmentGradingParams,
  tx?: DbOrTx,
): Promise<Assessment> {
  // Use the caller's transaction handle if supplied, else the singleton.
  const exec = tx ?? db;
  // Branch on whether the caller wants to overwrite `user_answer`. Two
  // statements (vs a single conditional COALESCE) keep each path's SQL
  // readable and the parameter-binding surface narrow. Both branches share
  // identical error semantics via the re-fetch below.
  if (params.userAnswer !== undefined) {
    await exec.execute(sql`
      UPDATE assessments
      SET is_correct    = ${params.isCorrect},
          quality_score = ${params.qualityScore},
          xp_awarded    = ${params.xpAwarded},
          user_answer   = ${params.userAnswer}
      WHERE id = ${id}
    `);
  } else {
    await exec.execute(sql`
      UPDATE assessments
      SET is_correct    = ${params.isCorrect},
          quality_score = ${params.qualityScore},
          xp_awarded    = ${params.xpAwarded}
      WHERE id = ${id}
    `);
  }

  // Re-fetch on the same executor for camelCase mapping and to surface
  // a missing id as NotFoundError (Postgres UPDATE silently affects 0 rows).
  const [row] = await exec.select().from(assessments).where(eq(assessments.id, id));
  if (!row) throw new NotFoundError("assessment", id);
  return row;
}
