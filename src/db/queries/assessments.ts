import { and, asc, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { assessments, type Assessment } from "@/db/schema";
import type { QualityScore } from "@/lib/types/spaced-repetition";

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
 * Throws a plain Error if the DB returns no row (should not happen on success,
 * but guards against unexpected driver behaviour).
 *
 * Note: the DB CHECK `assessments_question_required_for_card_kinds` will reject
 * card_mc/card_freetext rows with null `question` at the Postgres level.
 */
export async function recordAssessment(params: RecordAssessmentParams): Promise<Assessment> {
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
