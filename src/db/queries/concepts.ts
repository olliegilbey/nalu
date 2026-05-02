import { and, asc, eq, lte, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { concepts, type Concept } from "@/db/schema";
import type { QualityScore, SM2CardState } from "@/lib/types/spaced-repetition";
import { NotFoundError } from "./errors";

/**
 * `concepts` query surface (spec §3.6 / §8).
 *
 * Dedup: `INSERT … ON CONFLICT (course_id, lower(name)) DO UPDATE`. On
 * conflict the existing `tier` is preserved — it is immutable post-first-sight
 * (spec §3 decisions). The conflict SET clause is a no-op that keeps the
 * existing row while still ensuring the row is present.
 *
 * `getDueConceptsByCourse` is the hot Wave-start query, backed by
 * `concepts_due_idx` (partial WHERE next_review_at IS NOT NULL).
 *
 * All UPDATE statements use raw `db.execute(sql\`...\`)` because
 * `db.update().set()` crashes `eslint-plugin-functional/immutable-data`.
 * After updates that need the return value, we re-fetch via `getConceptById`
 * so Drizzle's camelCase mapping applies (mirrors the `closeWave` pattern).
 */

/** Re-exported domain error for missing query targets — single import site for callers. */
export { NotFoundError } from "./errors";

/** Re-exported SM-2 card-state shape for callers that step SM-2 directly from a row. */
export type { SM2CardState };

// ---------------------------------------------------------------------------
// Params / patch types
// ---------------------------------------------------------------------------

/** Parameters required to upsert a concept. */
export interface UpsertConceptParams {
  /** FK to `courses.id` — the course this concept belongs to. */
  readonly courseId: string;
  /** Human-readable concept name; deduped case-insensitively per course. */
  readonly name: string;
  /** Optional explanation shown in teaching prompts; null if absent. */
  readonly description?: string | null;
  /** Learning tier at which this concept was first seen — immutable after insert. */
  readonly tier: number;
}

/**
 * SM-2 fields to persist after a review event.
 *
 * All six fields are written atomically; callers compute them via
 * `src/lib/spaced-repetition/` before calling `updateConceptSm2`.
 */
export interface Sm2Update {
  readonly easinessFactor: number;
  readonly intervalDays: number;
  readonly repetitionCount: number;
  /** Integer 0–5 quality score assigned by the LLM assessment step. */
  readonly lastQualityScore: QualityScore;
  readonly lastReviewedAt: Date;
  readonly nextReviewAt: Date;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Fetch a concept by primary key.
 *
 * Used internally by `updateConceptSm2` to re-fetch after a raw SQL UPDATE.
 * Exported so callers can look up a single concept without loading the full
 * course list.
 *
 * @throws {NotFoundError} if `id` does not match any row.
 */
export async function getConceptById(id: string): Promise<Concept> {
  const [row] = await db.select().from(concepts).where(eq(concepts.id, id));
  if (!row) throw new NotFoundError("concept", id);
  return row;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Return all concepts for a course, unordered.
 *
 * Callers that need a stable presentation order should sort client-side;
 * no ORDER BY here keeps the query plan simple.
 */
export async function getConceptsByCourse(courseId: string): Promise<readonly Concept[]> {
  return db.select().from(concepts).where(eq(concepts.courseId, courseId));
}

/**
 * Return concepts whose `next_review_at` is at or before `now`.
 *
 * Backed by `concepts_due_idx` (partial WHERE next_review_at IS NOT NULL).
 * Never-reviewed rows (next_review_at = NULL) are excluded by both the
 * index and the `lte` predicate (SQL `<=` returns false for NULL).
 *
 * @param courseId - Scopes results to a single course.
 * @param now      - Caller-supplied reference time; inject for deterministic tests.
 */
export async function getDueConceptsByCourse(
  courseId: string,
  now: Date,
): Promise<readonly Concept[]> {
  return (
    db
      .select()
      .from(concepts)
      .where(
        and(
          eq(concepts.courseId, courseId),
          // Belt-and-suspenders: IS NOT NULL makes index use explicit; lte
          // already returns false for NULL but the planner benefits from the hint.
          sql`${concepts.nextReviewAt} IS NOT NULL`,
          lte(concepts.nextReviewAt, now),
        ),
      )
      // Deterministic ordering: nextReviewAt ASC means oldest-due first (matches
      // SM-2's "review what's most overdue" semantics); id ASC is a stable
      // tie-breaker for rows due at the exact same instant. WHY this matters:
      // these rows feed the Wave-start prompt, and the rendered byte sequence
      // must be stable across calls or the OpenAI-compatible prompt cache misses.
      .orderBy(asc(concepts.nextReviewAt), asc(concepts.id))
  );
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Insert a concept, or silently skip if one already exists with the same
 * case-insensitive name in the same course.
 *
 * Switched from `DO UPDATE SET name = EXCLUDED.name` to `DO NOTHING` (Codex
 * review). The previous no-op SET still acquired a row-level lock on conflict;
 * `DO NOTHING` avoids that lock entirely — important for Wave-start bulk upserts
 * where many previously-seen concept names are re-submitted.
 *
 * The ON CONFLICT target mirrors the functional unique index
 * `concepts_course_name_lower_unique` on `(course_id, lower(name))`.
 * `tier` immutability is preserved because we never touch the existing row.
 *
 * Uses raw SQL for the insert because Drizzle's
 * `onConflictDoUpdate({ target: sql\`...\` })` only accepts column references
 * in this version (it calls `escapeName` internally on the target, which rejects
 * SQL expression objects). After the upsert, re-fetches via a typed Drizzle
 * select keyed on `(courseId, lower(name))` for camelCase mapping.
 *
 * @throws {Error} if the re-fetch returns no row (should never happen).
 */
export async function upsertConcept(params: UpsertConceptParams): Promise<Concept> {
  // Raw INSERT … ON CONFLICT DO NOTHING: functional index target
  // `(course_id, lower(name))` cannot be passed to Drizzle's insert builder
  // in this version. DO NOTHING skips the write without locking the existing
  // row — cheaper than the prior `DO UPDATE SET name = EXCLUDED.name` no-op.
  await db.execute(sql`
    INSERT INTO concepts (course_id, name, description, tier)
    VALUES (
      ${params.courseId},
      ${params.name},
      ${params.description ?? null},
      ${params.tier}
    )
    ON CONFLICT (course_id, lower(name))
    DO NOTHING
  `);

  // Re-fetch via typed Drizzle select on the natural key so the returned row
  // goes through Drizzle's camelCase mapping.
  // `lower(name) = lower(incoming name)` matches both the insert and conflict paths.
  const [row] = await db
    .select()
    .from(concepts)
    .where(
      and(
        eq(concepts.courseId, params.courseId),
        sql`lower(${concepts.name}) = lower(${params.name})`,
      ),
    );
  if (!row) throw new Error("upsertConcept: no row found after upsert");
  return row;
}

/**
 * Persist SM-2 review results for a concept.
 *
 * Uses raw SQL UPDATE to avoid `eslint-plugin-functional/immutable-data` crash
 * on `db.update().set()`. Re-fetches via `getConceptById` so the returned row
 * goes through Drizzle's camelCase mapping (mirrors the `closeWave` pattern).
 *
 * @throws {NotFoundError} if `id` does not match any row.
 */
export async function updateConceptSm2(id: string, sm2: Sm2Update): Promise<Concept> {
  await db.execute(sql`
    UPDATE concepts
    SET easiness_factor    = ${sm2.easinessFactor},
        interval_days      = ${sm2.intervalDays},
        repetition_count   = ${sm2.repetitionCount},
        last_quality_score = ${sm2.lastQualityScore},
        last_reviewed_at   = ${sm2.lastReviewedAt.toISOString()},
        next_review_at     = ${sm2.nextReviewAt.toISOString()}
    WHERE id = ${id}
  `);

  // Re-fetch via typed Drizzle select for camelCase mapping.
  // Throws NotFoundError if the id was unknown (mirrors getWaveById in waves.ts).
  return getConceptById(id);
}

/**
 * Atomically increment `times_correct` by 1.
 *
 * SQL expression avoids lost-update races when concurrent assessments fire.
 * Returns void — callers don't need the updated row for counter bumps.
 */
export async function incrementCorrect(id: string): Promise<void> {
  await db.execute(sql`UPDATE concepts SET times_correct = times_correct + 1 WHERE id = ${id}`);
}

/**
 * Atomically increment `times_incorrect` by 1.
 *
 * SQL expression avoids lost-update races when concurrent assessments fire.
 * Returns void — callers don't need the updated row for counter bumps.
 */
export async function incrementIncorrect(id: string): Promise<void> {
  await db.execute(sql`UPDATE concepts SET times_incorrect = times_incorrect + 1 WHERE id = ${id}`);
}
