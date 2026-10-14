import { and, eq, sql } from "drizzle-orm";
import { db, type DbOrTx } from "@/db/client";
import { concepts, type Concept } from "@/db/schema";
import type { QualityScore } from "@/lib/types/spaced-repetition";
import { NotFoundError } from "./errors";

/**
 * `concepts` writes: upsert and SM-2 review results.
 *
 * Dedup: `INSERT … ON CONFLICT (course_id, lower(name)) DO NOTHING`. On
 * conflict the existing `tier` is preserved — it is immutable post-first-sight
 * (spec §3 decisions). `upsertConcept` then re-fetches the row by natural key.
 *
 * All UPDATE statements use raw `db.execute(sql\`...\`)` (house style).
 * After updates that need the return value, we re-fetch via a typed select
 * so Drizzle's camelCase mapping applies (mirrors the `closeWave` pattern).
 */

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
 * Optional `tx` opts the INSERT and re-fetch into a caller's transaction. The
 * INSERT and SELECT share the same executor — using `db` for the SELECT after
 * a tx INSERT would query a different connection that cannot see the
 * uncommitted row.
 *
 * @throws {Error} if the re-fetch returns no row (should never happen).
 */
export async function upsertConcept(params: UpsertConceptParams, tx?: DbOrTx): Promise<Concept> {
  // Use the caller's transaction handle if supplied, else the singleton.
  // BOTH the INSERT and the re-fetch must run on the same executor — see
  // docstring.
  const exec = tx ?? db;
  // Raw INSERT … ON CONFLICT DO NOTHING: functional index target
  // `(course_id, lower(name))` cannot be passed to Drizzle's insert builder
  // in this version. DO NOTHING skips the write without locking the existing
  // row — cheaper than the prior `DO UPDATE SET name = EXCLUDED.name` no-op.
  await exec.execute(sql`
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
  const [row] = await exec
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
 * Uses raw SQL UPDATE (house style). Re-fetches via `getConceptById` so the
 * returned row goes through Drizzle's camelCase mapping (mirrors the
 * `closeWave` pattern).
 *
 * Optional `tx` opts the UPDATE and re-fetch into a caller's transaction.
 * BOTH operations must run on the same executor — using `db` for the re-fetch
 * after a tx UPDATE would query a different connection that cannot see the
 * uncommitted change. Mirrors the `upsertConcept` optional-tx pattern.
 *
 * @throws {NotFoundError} if `id` does not match any row.
 */
export async function updateConceptSm2(id: string, sm2: Sm2Update, tx?: DbOrTx): Promise<Concept> {
  // Use the caller's transaction handle if supplied, else the singleton.
  // BOTH the UPDATE and the re-fetch must run on the same executor.
  const exec = tx ?? db;
  await exec.execute(sql`
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
  // Inlined to share the `exec` handle — getConceptById always uses `db`.
  const [row] = await exec.select().from(concepts).where(eq(concepts.id, id));
  if (!row) throw new NotFoundError("concept", id);
  return row;
}
