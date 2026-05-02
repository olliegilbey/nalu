import { desc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { courses, type Course } from "@/db/schema";
import {
  clarificationJsonbSchema,
  frameworkJsonbSchema,
  baselineJsonbSchema,
} from "@/lib/types/jsonb";
import { NotFoundError } from "./errors";

/**
 * `courses` query surface (spec §8).
 *
 * JSONB columns (`clarification`, `framework`, `baseline`) are validated via
 * Zod on every read so consumers receive typed, safe payloads instead of
 * raw `unknown`.
 *
 * All UPDATE statements use raw `db.execute(sql\`...\`)` because
 * `db.update().set()` crashes `eslint-plugin-functional/immutable-data` —
 * a known lint-config gap confirmed in D3. The generated SQL is identical.
 */

/** Re-exported domain error for missing query targets — single import site for callers. */
export { NotFoundError } from "./errors";

// ---------------------------------------------------------------------------
// Internal guard
// ---------------------------------------------------------------------------

/**
 * Validate the three JSONB columns on a raw `courses` row.
 *
 * `clarification`, `framework`, and `baseline` are nullable in the schema.
 * We only parse them when non-null so callers don't have to handle Zod errors
 * on empty columns. Returns the same row shape with columns replaced by their
 * parsed values (Zod strips unknown keys; structure is preserved).
 */
export function courseRowGuard(row: Course): Course {
  return {
    ...row,
    // Only validate when the column has been populated.
    clarification:
      row.clarification != null
        ? clarificationJsonbSchema.parse(row.clarification)
        : row.clarification,
    framework: row.framework != null ? frameworkJsonbSchema.parse(row.framework) : row.framework,
    baseline: row.baseline != null ? baselineJsonbSchema.parse(row.baseline) : row.baseline,
  };
}

// ---------------------------------------------------------------------------
// Params / patches
// ---------------------------------------------------------------------------

/** Parameters required to create a new course row. */
export interface CreateCourseParams {
  /** FK to `user_profiles.id` — the learner who owns this course. */
  userId: string;
  /** Free-text description of what the learner wants to study. */
  topic: string;
}

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
// Reads
// ---------------------------------------------------------------------------

/**
 * Insert a new course row and return it.
 *
 * `status` defaults to `"scoping"` at the DB level; `totalXp` and
 * `currentTier` default to `0`/`1` respectively.
 */
export async function createCourse(params: CreateCourseParams): Promise<Course> {
  const [row] = await db
    .insert(courses)
    .values({ userId: params.userId, topic: params.topic })
    .returning();
  // The insert must return a row — no scenario where it doesn't.
  if (!row) throw new Error("createCourse: insert returned no row");
  return courseRowGuard(row);
}

/** Fetch a course by primary key; throws `NotFoundError` if absent. */
export async function getCourseById(id: string): Promise<Course> {
  const [row] = await db.select().from(courses).where(eq(courses.id, id));
  if (!row) throw new NotFoundError("course", id);
  return courseRowGuard(row);
}

/**
 * List all courses for a user, newest first.
 *
 * Ordered by `created_at DESC` so the most recently started course appears
 * at index 0 — the natural ordering for a learner's dashboard.
 */
export async function listCoursesByUser(userId: string): Promise<readonly Course[]> {
  const rows = await db
    .select()
    .from(courses)
    .where(eq(courses.userId, userId))
    .orderBy(desc(courses.createdAt));
  return rows.map(courseRowGuard);
}

// ---------------------------------------------------------------------------
// Writes — all via raw SQL to avoid immutable-data lint crash
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

  // Build the SET fragment list functionally (no push — immutable-data rule).
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

  await db.execute(sql`
    UPDATE courses
    SET ${combined}
    WHERE id = ${id}
  `);

  // Re-fetch so the row goes through Drizzle's camelCase mapping.
  return getCourseById(id);
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

/**
 * Overwrite the cumulative course summary.
 *
 * Called after every Wave close when the LLM emits `<course_summary_update>`.
 * `summary_updated_at` is stamped so callers can detect staleness.
 * Throws `NotFoundError` explicitly at the UPDATE site (rather than only via
 * the re-fetch) so the failure is visible at the mutation rather than the read.
 * Re-fetches after update to get Drizzle's camelCase-mapped row.
 */
export async function updateCourseSummary(id: string, summary: string): Promise<Course> {
  const result = await db.execute(sql`
    UPDATE courses
    SET summary = ${summary},
        summary_updated_at = NOW(),
        updated_at = NOW()
    WHERE id = ${id}
  `);
  // postgres-js exposes affected-row count on `result.count` (not `rowCount`).
  if ((result as { count?: number | null }).count === 0) {
    throw new NotFoundError("course", id);
  }
  return getCourseById(id);
}

/**
 * Update `current_tier` after a tier promotion or demotion.
 *
 * Deterministic progression code in `src/lib/progression/` decides the new
 * tier; this function just persists the decision.
 * Throws `NotFoundError` explicitly at the UPDATE site for clarity.
 * Re-fetches after update to get Drizzle's camelCase-mapped row.
 */
export async function updateCourseTier(id: string, newTier: number): Promise<Course> {
  const result = await db.execute(sql`
    UPDATE courses
    SET current_tier = ${newTier},
        updated_at = NOW()
    WHERE id = ${id}
  `);
  // postgres-js exposes affected-row count on `result.count` (not `rowCount`).
  if ((result as { count?: number | null }).count === 0) {
    throw new NotFoundError("course", id);
  }
  return getCourseById(id);
}

/**
 * Atomically add `amount` XP to the course's running total.
 *
 * SQL expression `total_xp + amount` avoids lost-update races when multiple
 * assessment completions arrive concurrently (same reason as `incrementUserXp`).
 * Throws `NotFoundError` explicitly at the UPDATE site for clarity.
 * Re-fetches after update to get Drizzle's camelCase-mapped row.
 */
export async function incrementCourseXp(id: string, amount: number): Promise<Course> {
  // App-layer guard: XP awards are monotonically non-negative (a "0 XP" outcome
  // is permitted for a wrong answer; "negative XP" is never a valid outcome).
  // The DB CHECK `courses_total_xp_nonneg` is a backstop, not the primary line
  // of defense — surface a typed error here so call sites get a clear message.
  if (!Number.isInteger(amount) || amount < 0) {
    throw new Error(`incrementCourseXp: amount must be a non-negative integer (got ${amount})`);
  }

  const result = await db.execute(sql`
    UPDATE courses
    SET total_xp = total_xp + ${amount},
        updated_at = NOW()
    WHERE id = ${id}
  `);
  // postgres-js exposes affected-row count on `result.count` (not `rowCount`).
  if ((result as { count?: number | null }).count === 0) {
    throw new NotFoundError("course", id);
  }
  return getCourseById(id);
}

/**
 * Mark a course as archived.
 *
 * Archived courses are hidden from the learner's active dashboard but kept
 * for history and potential resumption. No return value — callers don't need
 * the updated row for this terminal transition.
 *
 * @throws {NotFoundError} if `id` does not match any row.
 */
export async function archiveCourse(id: string): Promise<void> {
  const result = await db.execute(sql`
    UPDATE courses
    SET status = 'archived',
        updated_at = NOW()
    WHERE id = ${id}
  `);
  // postgres-js exposes affected-row count on `result.count` (not `rowCount`).
  if ((result as { count?: number | null }).count === 0) {
    throw new NotFoundError("course", id);
  }
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
