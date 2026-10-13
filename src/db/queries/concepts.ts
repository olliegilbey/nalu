import { and, asc, eq, lte, sql } from "drizzle-orm";
import { db, type DbOrTx } from "@/db/client";
import { concepts, type Concept } from "@/db/schema";
import type { SM2CardState } from "@/lib/types/spaced-repetition";
import { NotFoundError } from "./errors";

/**
 * `concepts` query surface (spec §3.6 / §8): reads.
 *
 * `getDueConceptsByCourse` is the hot Wave-start query, backed by
 * `concepts_due_idx` (partial WHERE next_review_at IS NOT NULL).
 *
 * Writes (upsert, SM-2 results, counters) live in `concepts.writes.ts`.
 */

/** Re-exported domain error for missing query targets — single import site for callers. */
export { NotFoundError } from "./errors";

/** Re-exported SM-2 card-state shape for callers that step SM-2 directly from a row. */
export type { SM2CardState };

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Fetch a concept by primary key.
 *
 * Lets callers look up a single concept without loading the full course
 * list.
 *
 * Optional `tx` opts the read into a caller's transaction so writes earlier
 * in the same tx are visible. Visibility (not mutability) is the reason
 * callers inside a transaction should thread `tx`: `db` (the singleton) is
 * a separate connection and won't see uncommitted writes from `tx`.
 *
 * @throws {NotFoundError} if `id` does not match any row.
 */
export async function getConceptById(id: string, tx?: DbOrTx): Promise<Concept> {
  const exec = tx ?? db;
  const [row] = await exec.select().from(concepts).where(eq(concepts.id, id));
  if (!row) throw new NotFoundError("concept", id);
  return row;
}

/**
 * Return all concepts for a course, unordered.
 *
 * Callers that need a stable presentation order should sort client-side;
 * no ORDER BY here keeps the query plan simple.
 *
 * Optional `tx` opts the read into a caller's transaction so writes earlier
 * in the same tx are visible (e.g. SM-2 advances applied in step 2 of
 * `persistWaveClose` before the tier-advancement check reads concept state).
 */
export async function getConceptsByCourse(
  courseId: string,
  tx?: DbOrTx,
): Promise<readonly Concept[]> {
  const exec = tx ?? db;
  return exec.select().from(concepts).where(eq(concepts.courseId, courseId));
}

/**
 * Return concepts whose `next_review_at` is at or before `now`.
 *
 * Backed by `concepts_due_idx` (partial WHERE next_review_at IS NOT NULL).
 * Never-reviewed rows (next_review_at = NULL) are excluded by both the
 * index and the `lte` predicate (SQL `<=` returns false for NULL).
 *
 * Optional `limit` caps the result in SQL (`LIMIT`), after the ORDER BY, so
 * it keeps the most overdue rows. The agent lookup tool passes its cap;
 * Wave-boundary callers want the full list and pass `undefined`.
 *
 * Optional `tx` opts the read into a caller's transaction so SM-2 advances
 * earlier in the same tx are observed (e.g. the Wave-close transaction
 * captures the next Wave's due-snapshot AFTER applying its own conceptUpdates).
 *
 * @param courseId - Scopes results to a single course.
 * @param now      - Caller-supplied reference time; inject for deterministic tests.
 */
export async function getDueConceptsByCourse(
  courseId: string,
  now: Date,
  limit?: number,
  tx?: DbOrTx,
): Promise<readonly Concept[]> {
  const exec = tx ?? db;
  const query = exec
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
    .orderBy(asc(concepts.nextReviewAt), asc(concepts.id));
  return limit === undefined ? query : query.limit(limit);
}

/**
 * Fetch a concept by case-insensitive name within a course.
 *
 * Mirrors the unique index `concepts_course_name_lower_unique` on
 * `(course_id, lower(name))` — at most one row matches. Returns `null` when
 * absent (NOT a throw) so callers can distinguish "missing concept" from
 * other failure modes (e.g. `applySm2Update` raises a typed error explaining
 * the schema-build/persist race that produced the miss).
 *
 * Optional `tx` opts the read into a caller's transaction so writes earlier
 * in the same tx are visible.
 */
export async function getConceptByNameForCourse(
  courseId: string,
  name: string,
  tx?: DbOrTx,
): Promise<Concept | null> {
  const exec = tx ?? db;
  const [row] = await exec
    .select()
    .from(concepts)
    .where(and(eq(concepts.courseId, courseId), sql`lower(${concepts.name}) = lower(${name})`));
  return row ?? null;
}
