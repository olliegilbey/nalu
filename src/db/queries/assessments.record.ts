import { eq, max, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { assessments, type Assessment } from "@/db/schema";
import type { QualityScore } from "@/lib/types/spaced-repetition";
import { NotFoundError } from "./errors";

/**
 * `assessments` single-probe insert (spec §8): one row, graded at insert.
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
  // advisory lock keyed by `waveId` (issue #53).
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
