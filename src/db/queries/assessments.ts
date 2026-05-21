import { and, asc, desc, eq, inArray, max, sql } from "drizzle-orm";
import { db, type DbOrTx } from "@/db/client";
import { assessments, concepts, type Assessment } from "@/db/schema";
import type { QualityScore } from "@/lib/types/spaced-repetition";
import { NotFoundError } from "./errors";

/** Re-exported domain error for missing query targets — single import site for callers. */
export { NotFoundError } from "./errors";

/**
 * `assessments` query surface (spec §8).
 *
 * In-Wave probes only — baseline gradings live in `courses.baseline` JSONB.
 *
 * `assessment_kind = 'inferred'` rows have NULL `question` (the correctness
 * signal arrived from the model's read of free-form prose); the DB CHECK
 * `assessments_question_required_for_card_kinds` enforces the inverse for
 * `card_mc` / `card_freetext`. Callers must supply `question` for card
 * kinds — TS types make that obvious.
 */

/**
 * Parameters for inserting a single in-Wave assessment probe.
 *
 * All fields readonly — no mutation after construction.
 */
export interface RecordAssessmentParams {
  /** Wave the assessment belongs to (FK → waves.id). */
  readonly waveId: string;
  /** Concept being assessed (FK → concepts.id). */
  readonly conceptId: string;
  /** Zero-based index of the turn within the Wave when the probe occurred. */
  readonly turnIndex: number;
  /**
   * The question text shown to the learner.
   * Must be non-null for `card_mc` / `card_freetext` kinds; may be null for
   * `inferred` kinds where no question was posed.
   * The DB CHECK `assessments_question_required_for_card_kinds` enforces this.
   */
  readonly question: string | null;
  /**
   * Model-generated question id (verbatim from the prompt envelope).
   * Required for card kinds — enforced by the DB CHECK
   * `assessments_question_id_required_for_card_kinds`. `inferred` rows pass null.
   */
  readonly questionId: string | null;
  /** The learner's answer text (or free-form prose for `inferred` rows). */
  readonly userAnswer: string;
  /** Whether the answer was graded correct by the LLM. */
  readonly isCorrect: boolean;
  /** LLM-assigned quality score (0-5). */
  readonly qualityScore: QualityScore;
  /** Probe flavour — controls which CHECK branch applies. */
  readonly assessmentKind: "card_mc" | "card_freetext" | "inferred";
  /** XP awarded for this assessment (deterministic, not LLM-driven). */
  readonly xpAwarded: number;
}

/**
 * Insert a single assessment probe and return the persisted row.
 *
 * Pre-insert invariant checks (Codex P1 thread PRRT_kwDOR_akxs5-xHQM):
 *  1. Cross-course guard: the concept must belong to the same course as the
 *     wave, otherwise we'd silently corrupt another course's SM-2 state.
 *  2. Monotonic turn_index: prevents out-of-order writes that would corrupt
 *     the assessment timeline used for SM-2 scheduling and XP totals.
 *
 * Note: the DB CHECK `assessments_question_required_for_card_kinds` will reject
 * card_mc/card_freetext rows with null `question` at the Postgres level.
 *
 * @throws {NotFoundError} if the wave or concept id does not exist.
 * @throws {Error} if the wave and concept belong to different courses.
 * @throws {Error} if turnIndex is less than the current max turn_index for
 *   this wave (monotonic constraint).
 */
export async function recordAssessment(params: RecordAssessmentParams): Promise<Assessment> {
  // --- Cross-course safety check -------------------------------------------
  // One round-trip fetches both course ids so we can compare them together.
  // If either FK resolves to NULL the row doesn't exist — surface NotFoundError.
  const scopeRows = await db.execute<{
    wave_course_id: string | null;
    concept_course_id: string | null;
  }>(
    sql`SELECT
          (SELECT course_id FROM waves    WHERE id = ${params.waveId})    AS wave_course_id,
          (SELECT course_id FROM concepts WHERE id = ${params.conceptId}) AS concept_course_id`,
  );
  // postgres-js RowList is array-indexable; [0] is the single result row.
  const scopeCheck = scopeRows[0];
  if (!scopeCheck?.wave_course_id || !scopeCheck?.concept_course_id) {
    throw new NotFoundError("wave_or_concept", `${params.waveId}/${params.conceptId}`);
  }
  if (scopeCheck.wave_course_id !== scopeCheck.concept_course_id) {
    throw new Error(
      `recordAssessment: wave ${params.waveId} and concept ${params.conceptId} belong to different courses`,
    );
  }

  // --- Monotonic turn_index guard ------------------------------------------
  // New assessments must have turn_index >= the current max for this wave.
  // Equal turn_index is allowed (multiple concepts assessed on the same turn).
  // WHY: out-of-order writes would corrupt the assessment timeline used by the
  // SM-2 scheduler and XP summation logic downstream.
  //
  // CONCURRENCY: SELECT MAX + INSERT is not atomic — two parallel writers can
  // both observe the same `currentMax` and both insert. Safe today because the
  // harness loop guarantees a single writer per Wave (single-user-per-Wave
  // invariant; same shape as `getNextTurnIndex` in `contextMessages.ts`). If
  // parallel write paths are ever added (sub-agent harness, multi-device
  // replay), wrap this read+insert in a SERIALIZABLE transaction or take an
  // advisory lock keyed by `waveId`. Tracked in `docs/TODO.md`.
  const [maxRow] = await db
    .select({ maxTurn: max(assessments.turnIndex) })
    .from(assessments)
    .where(eq(assessments.waveId, params.waveId));
  // maxTurn is null when no assessments exist yet; treat as -1 so any turnIndex ≥ 0 passes.
  const currentMax = maxRow?.maxTurn ?? -1;
  if (params.turnIndex < currentMax) {
    throw new Error(
      `recordAssessment: turnIndex ${params.turnIndex} < current max ${currentMax} for wave ${params.waveId}`,
    );
  }

  const [row] = await db.insert(assessments).values(params).returning();
  if (!row) throw new Error("recordAssessment: insert returned no row");
  return row;
}

/**
 * Return all assessments for a Wave, ordered by `assessedAt` ASC.
 *
 * Ordered ascending so callers can reconstruct the probe sequence within
 * the Wave (first probe first).
 */
export async function getAssessmentsByWave(waveId: string): Promise<readonly Assessment[]> {
  return db
    .select()
    .from(assessments)
    .where(eq(assessments.waveId, waveId))
    .orderBy(asc(assessments.assessedAt));
}

/**
 * Return all assessments for a concept across all Waves, ordered by
 * `assessedAt` DESC (most recent first — typical for spaced-repetition reads).
 */
export async function getAssessmentsByConcept(conceptId: string): Promise<readonly Assessment[]> {
  return db
    .select()
    .from(assessments)
    .where(eq(assessments.conceptId, conceptId))
    .orderBy(desc(assessments.assessedAt));
}

/**
 * Return assessments for a specific Wave + Concept pair, ordered by
 * `assessedAt` ASC for determinism.
 *
 * Useful when the harness needs the per-concept probe history within a
 * single Wave (e.g. to decide whether to re-probe the same concept).
 */
export async function getAssessmentsByWaveAndConcept(
  waveId: string,
  conceptId: string,
): Promise<readonly Assessment[]> {
  return db
    .select()
    .from(assessments)
    .where(and(eq(assessments.waveId, waveId), eq(assessments.conceptId, conceptId)))
    .orderBy(asc(assessments.assessedAt));
}

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
 * Uses raw SQL UPDATE to avoid `eslint-plugin-functional/immutable-data` crash
 * on `db.update().set()`. Re-fetches via a typed Drizzle select so the
 * returned row goes through Drizzle's camelCase mapping (mirrors the
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

// ---------------------------------------------------------------------------
// Mid-turn helpers (Task 11)
// ---------------------------------------------------------------------------

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
