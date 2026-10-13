import { eq, inArray, max, sql } from "drizzle-orm";
import { db, type DbOrTx } from "@/db/client";
import { assessments, concepts, type Assessment } from "@/db/schema";
import { NotFoundError } from "./errors";

/**
 * `assessments` batch insert for a new questionnaire: one placeholder row per
 * question, graded on a later turn by `updateAssessmentGrading`.
 */

/**
 * Parameters for `insertOpenAssessments` — one row per element in `rows`.
 *
 * Each row shares the same `waveId` and `turnIndex` (the assistant_response's
 * turn) but carries its own `conceptId`, `questionId`, `assessmentKind`, and
 * `question` text. Placeholder grading fields (`userAnswer=""`, `isCorrect=false`,
 * `qualityScore=0`, `xpAwarded=0`) are filled in at probe time and overwritten
 * by `updateAssessmentGrading` once the learner's next-turn answer is graded.
 */
export interface InsertOpenAssessmentParams {
  /** FK → waves.id. All rows in a batch share this. */
  readonly waveId: string;
  /** Zero-based turn index — same for every row (the assistant_response's turn). */
  readonly turnIndex: number;
  /** Per-row payload. */
  readonly rows: ReadonlyArray<{
    readonly conceptId: string;
    readonly questionId: string;
    readonly question: string;
    readonly assessmentKind: "card_mc" | "card_freetext";
  }>;
}

/**
 * Batch-insert placeholder assessment rows for a new questionnaire.
 *
 * Mid-turn flow drops 1-N questions in a single LLM turn; each maps to one
 * assessment row with placeholder grading fields. The placeholders persist
 * until the learner replies on the next turn, at which point
 * `updateAssessmentGrading` fills in the real verdict + quality + XP +
 * userAnswer.
 *
 * Mirrors the cross-course and monotonic-turn-index guards from
 * `recordAssessment` but runs each check ONCE per batch (single wave_id +
 * single turn_index). The batch INSERT uses Drizzle's `.values([...])` +
 * `.returning()` which IS safe — `RETURNING` is only banned in our codebase
 * for UPDATE statements (snake_case row-map mismatch); for inserts Drizzle's
 * camelCase mapping applies cleanly.
 *
 * @throws {Error} if `rows.length === 0` (defensive — no caller should send empty).
 * @throws {NotFoundError} if the wave or any concept id is missing.
 * @throws {Error} if any concept belongs to a different course than the wave.
 * @throws {Error} if `turnIndex` is less than the current max for this wave.
 */
export async function insertOpenAssessments(
  params: InsertOpenAssessmentParams,
  tx?: DbOrTx,
): Promise<readonly Assessment[]> {
  // Defensive — empty batches are always a caller bug; surface immediately.
  if (params.rows.length === 0) {
    throw new Error("insertOpenAssessments: rows must be non-empty");
  }
  const exec = tx ?? db;

  // --- Cross-course safety check (batched) --------------------------------
  // ALL concepts in the batch must belong to the same course as the wave.
  // One query: load the wave's course id and each distinct concept's course id.
  // We then compare server-side. Single round-trip instead of N.
  const distinctConceptIds = [...new Set(params.rows.map((r) => r.conceptId))];
  const waveScopeRows = await exec.execute<{ course_id: string | null }>(
    sql`SELECT course_id FROM waves WHERE id = ${params.waveId} LIMIT 1`,
  );
  const waveCourseId = waveScopeRows[0]?.course_id ?? null;
  if (!waveCourseId) {
    throw new NotFoundError("wave", params.waveId);
  }
  // Use Drizzle's `inArray` rather than raw `ANY(array)` so the SQL template
  // interpolation generates a proper `IN (?, ?, ...)` clause — raw `${array}`
  // in a `sql` template expands to a comma-separated parameter list that can't
  // be cast to `uuid[]` (Postgres treats it as a record literal).
  const conceptScopeRows = await exec
    .select({ id: concepts.id, courseId: concepts.courseId })
    .from(concepts)
    .where(inArray(concepts.id, distinctConceptIds));
  // O(1) lookup of concept → course id below.
  const conceptCourseById = new Map(conceptScopeRows.map((r) => [r.id, r.courseId]));
  for (const cid of distinctConceptIds) {
    const conceptCourse = conceptCourseById.get(cid);
    if (!conceptCourse) {
      throw new NotFoundError("concept", cid);
    }
    if (conceptCourse !== waveCourseId) {
      throw new Error(
        `insertOpenAssessments: wave ${params.waveId} and concept ${cid} belong to different courses`,
      );
    }
  }

  // --- Monotonic turn_index guard -----------------------------------------
  // All rows share the same turnIndex, so a single MAX-check suffices.
  // Equal turn_index is allowed (siblings on the same turn). Same single-writer
  // concurrency caveat as `recordAssessment`.
  const [maxRow] = await exec
    .select({ maxTurn: max(assessments.turnIndex) })
    .from(assessments)
    .where(eq(assessments.waveId, params.waveId));
  const currentMax = maxRow?.maxTurn ?? -1;
  if (params.turnIndex < currentMax) {
    throw new Error(
      `insertOpenAssessments: turnIndex ${params.turnIndex} < current max ${currentMax} for wave ${params.waveId}`,
    );
  }

  // --- Batch INSERT --------------------------------------------------------
  // Build the values list with placeholder grading fields. Drizzle's
  // `.values([...])` accepts an array of insert shapes and `.returning()` is
  // safe on INSERT (camelCase mapping applies; the snake_case-mismatch trap
  // only affects RETURNING on UPDATE statements).
  const inserted = await exec
    .insert(assessments)
    .values(
      params.rows.map((r) => ({
        waveId: params.waveId,
        conceptId: r.conceptId,
        turnIndex: params.turnIndex,
        question: r.question,
        questionId: r.questionId,
        // Placeholder fields — grading fills these in on the next turn.
        userAnswer: "",
        isCorrect: false,
        qualityScore: 0,
        assessmentKind: r.assessmentKind,
        xpAwarded: 0,
      })),
    )
    .returning();
  return inserted;
}
