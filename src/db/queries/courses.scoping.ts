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
 * `courses` writes for the scoping phase: the per-stage JSONB columns, then
 * the flip to `active` when scoping closes.
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

/**
 * Data written when scoping completes and the first Wave is seeded.
 *
 * `startingTier` is frozen here and never mutated again; `currentTier` starts
 * equal but may diverge via `updateCourseTier` as the learner progresses.
 */
export interface StartingStatePatch {
  /** LLM-generated course summary from the baseline evaluation. */
  initialSummary: string;
  /** Tier determined by the baseline grading — immutable after this call. */
  startingTier: number;
  /** Initial current tier; equals `startingTier` at first Wave open. */
  currentTier: number;
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

/**
 * Transition a course from `scoping` to `active` and record the baseline
 * outputs that never change again (`starting_tier`, `summary`).
 *
 * Also sets `current_tier` — it starts equal to `starting_tier` but may
 * diverge as the learner moves through Waves.
 *
 * The `WHERE status = 'scoping'` scope makes the UPDATE a no-op if the course
 * is in any other status. `getCourseById` throws `NotFoundError` if the id is
 * unknown; the explicit status check surfaces the lifecycle mismatch clearly.
 *
 * Re-fetches after update to get Drizzle's camelCase-mapped row.
 */
export async function setCourseStartingState(
  id: string,
  patch: StartingStatePatch,
): Promise<Course> {
  // App-layer activation invariant: at the moment scoping closes, current_tier
  // must equal starting_tier (divergence only happens later via updateCourseTier).
  // Tiers are 1-indexed (matches `framework.tiers` ordinals); the DB CHECKs
  // `courses_current_tier_positive` / `courses_starting_tier_positive_or_null`
  // would also catch a non-positive value, but a typed error here surfaces the
  // bug at the call site rather than as a generic constraint violation.
  if (!Number.isInteger(patch.startingTier) || patch.startingTier < 1) {
    throw new Error(
      `setCourseStartingState: startingTier must be a positive integer (got ${patch.startingTier})`,
    );
  }
  if (patch.currentTier !== patch.startingTier) {
    throw new Error(
      `setCourseStartingState: currentTier (${patch.currentTier}) must equal startingTier (${patch.startingTier}) at activation`,
    );
  }
  // Scope to 'scoping' status so a concurrent call or re-play can never
  // accidentally overwrite starting_tier on an already-active course.
  await db.execute(sql`
    UPDATE courses
    SET status = 'active',
        summary = ${patch.initialSummary},
        summary_updated_at = NOW(),
        starting_tier = ${patch.startingTier},
        current_tier = ${patch.currentTier},
        updated_at = NOW()
    WHERE id = ${id}
      AND status = 'scoping'
  `);
  // getCourseById throws NotFoundError if the id is unknown.
  // If the id existed but was not in 'scoping' status, the row is unchanged
  // and we surface that as a domain-level error.
  const row = await getCourseById(id);
  if (row.status !== "active") {
    throw new Error(
      `setCourseStartingState: course ${id} was in status='${row.status}', expected 'scoping'`,
    );
  }
  return row;
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
