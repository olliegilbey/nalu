import { and, asc, desc, eq } from "drizzle-orm";
import { db, type DbOrTx } from "@/db/client";
import { assessments, type Assessment } from "@/db/schema";

/** Re-exported domain error for missing query targets — single import site for callers. */
export { NotFoundError } from "./errors";

/**
 * `assessments` query surface (spec §8): reads.
 *
 * In-Wave probes only — baseline gradings live in `courses.baseline` JSONB.
 *
 * Writes live in siblings: `assessments.open.ts` (a questionnaire's
 * placeholder rows) and `assessments.grade.ts` (grading an existing row).
 */

/**
 * Return assessments for a concept across all Waves, ordered by
 * `assessedAt` DESC (most recent first — typical for spaced-repetition reads).
 * Optional `limit` caps the result in SQL (`LIMIT`), after the ORDER BY, so
 * it keeps the most recent rows; omit it for the full history. Optional
 * trailing `tx` runs the read inside a caller's transaction (file convention).
 */
export async function getAssessmentsByConcept(
  conceptId: string,
  limit?: number,
  tx?: DbOrTx,
): Promise<readonly Assessment[]> {
  const exec = tx ?? db;
  const query = exec
    .select()
    .from(assessments)
    .where(eq(assessments.conceptId, conceptId))
    // id ASC breaks ties: one quiz's rows share the transaction's `now()`,
    // and a tie with no tiebreaker lets the planner pick which rows a
    // `limit` keeps. Same tiebreaker as `getDueConceptsByCourse`.
    .orderBy(desc(assessments.assessedAt), asc(assessments.id));
  return limit === undefined ? query : query.limit(limit);
}

/**
 * Look up a single assessment row by wave + question id.
 *
 * `questionId` is the namespaced form (`${questionnaireId}:${rawId}` — see
 * `namespaceQuestionId`), matching how the column is written; callers must
 * namespace the model's raw id before calling.
 *
 * Returns `null` (NOT throw) on miss so the mid-turn orchestrator can
 * distinguish "model graded a question we don't have a row for" (defensive
 * skip / log) from real DB errors. Backed by the partial unique index
 * `assessments_wave_question_unique`, so at most one row can match.
 *
 * Optional `tx` opts the read into a caller's transaction so writes earlier in
 * the same tx are visible. Mirrors `getConceptByNameForCourse`.
 */
export async function getAssessmentByWaveAndQuestionId(
  waveId: string,
  questionId: string,
  tx?: DbOrTx,
): Promise<Assessment | null> {
  const exec = tx ?? db;
  const [row] = await exec
    .select()
    .from(assessments)
    .where(and(eq(assessments.waveId, waveId), eq(assessments.questionId, questionId)));
  return row ?? null;
}
