import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import type { Course } from "@/db/schema";
import {
  clarificationJsonbSchema,
  frameworkJsonbSchema,
  baselineJsonbSchema,
} from "@/lib/types/jsonb";
import { CourseNotScopingError } from "./errors";
import { getCourseById } from "./courses";

/**
 * `courses` writes for the scoping phase: the per-stage JSONB columns. The
 * flip to `active` when scoping closes lives in `courses.tx.ts`.
 *
 * All UPDATE statements use raw `db.execute(sql\`...\`)` (house style).
 */

// ---------------------------------------------------------------------------
// Patches
// ---------------------------------------------------------------------------

/**
 * Partial JSONB update for the scoping phase.
 *
 * Any combination of the three JSONB columns may be set in a single call.
 * Columns absent from the patch are left untouched.
 */
export interface ScopingStatePatch {
  clarification?: unknown;
  framework?: unknown;
  baseline?: unknown;
}

// ---------------------------------------------------------------------------
// Writes — all via raw SQL (house style)
// ---------------------------------------------------------------------------

/**
 * Partially update JSONB scoping columns.
 *
 * Builds a dynamic SET clause that only touches columns present in `patch`.
 * Uses string concatenation to join fragments because `sql.join` is not
 * available in drizzle-orm 0.45. The raw SQL template tag handles all
 * parameterisation, so there is no injection risk.
 *
 * Re-fetches via `getCourseById` after the update so the returned row goes
 * through Drizzle's camelCase mapping instead of being hand-mapped from
 * the snake_case columns that `RETURNING *` provides.
 *
 * Writes only while the course is in `scoping`. A write that races a scoping
 * close must not overwrite the closed baseline with a pre-close shape: that
 * course would fail `getState`'s invariant on every load.
 *
 * @throws {CourseNotScopingError} when the course has left `scoping`; nothing was written.
 */
export async function updateCourseScopingState(
  id: string,
  patch: ScopingStatePatch,
): Promise<Course> {
  // Parse-before-persist: validate every JSONB field against its schema BEFORE
  // touching the DB. This surface is a trust boundary (scoping router hands
  // arbitrary objects from LLM-parsed responses); we want ZodErrors to surface
  // here rather than as opaque DB failures or silent corruption on read.
  // WHY here and not only on read? Because invalid data that reaches Postgres
  // would corrupt the scoping context that seeds the first Wave blueprint.
  if (patch.clarification !== undefined) {
    clarificationJsonbSchema.parse(patch.clarification);
  }
  if (patch.framework !== undefined) {
    frameworkJsonbSchema.parse(patch.framework);
  }
  if (patch.baseline !== undefined) {
    baselineJsonbSchema.parse(patch.baseline);
  }

  // Build the SET fragment list functionally (no push; immutable by default).
  // Spread concat to accumulate only the columns present in the patch.
  // `updated_at = NOW()` is always appended.
  const setClauses: readonly ReturnType<typeof sql>[] = [
    // Cast to jsonb so Postgres stores it correctly even when the driver
    // sends the value as a string.
    ...(patch.clarification !== undefined
      ? [sql`clarification = ${JSON.stringify(patch.clarification)}::jsonb`]
      : []),
    ...(patch.framework !== undefined
      ? [sql`framework = ${JSON.stringify(patch.framework)}::jsonb`]
      : []),
    ...(patch.baseline !== undefined
      ? [sql`baseline = ${JSON.stringify(patch.baseline)}::jsonb`]
      : []),
    sql`updated_at = NOW()`,
  ];

  // `sql.join` does not exist in drizzle-orm 0.45; reduce the array into a
  // single comma-separated SQL fragment via the helper below.
  const combined = joinSqlFragments(setClauses);

  // `RETURNING id` tells a write the status guard skipped apart from one it applied.
  const updated = await db.execute<{ readonly id: string }>(sql`
    UPDATE courses
    SET ${combined}
    WHERE id = ${id}
      AND status = 'scoping'
    RETURNING id
  `);

  // Re-fetch so the row goes through Drizzle's camelCase mapping. An unknown
  // id throws NotFoundError here.
  const course = await getCourseById(id);
  if (updated.length === 0) throw new CourseNotScopingError(id, course.status);
  return course;
}

// ---------------------------------------------------------------------------
// Internal utility
// ---------------------------------------------------------------------------

/**
 * Merge an array of drizzle `sql\`...\`` fragments into one, separated by
 * commas. Used to build dynamic SET clauses in `updateCourseScopingState`.
 *
 * `sql.join` is absent in drizzle-orm 0.45, so we reduce the array manually.
 * The Drizzle `SQL` objects carry a `queryChunks` array internally; spreading
 * them into a new `sql\`...\`` template lets the driver parameterise correctly.
 *
 * Precondition: `fragments` must be non-empty (callers always push `updated_at`
 * last, so this is always satisfied).
 */
function joinSqlFragments(fragments: readonly ReturnType<typeof sql>[]): ReturnType<typeof sql> {
  // Reduce left-to-right, inserting a comma-and-space between each pair.
  // `reduce` without an initial value throws on an empty array, but callers
  // always include at least `updated_at = NOW()` so this is safe.
  return fragments.reduce((acc, frag) => sql`${acc}, ${frag}`);
}
