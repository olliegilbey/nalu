import { asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { courses, type Course } from "@/db/schema";
import {
  clarificationJsonbSchema,
  frameworkJsonbSchema,
  baselineJsonbSchema,
} from "@/lib/types/jsonb";
import { NotFoundError } from "./errors";

/**
 * `courses` query surface (spec §8): row guard, create, and reads.
 *
 * JSONB columns (`clarification`, `framework`, `baseline`) are validated via
 * Zod on every read so consumers receive typed, safe payloads instead of
 * raw `unknown`.
 *
 * Writes live in siblings: `courses.scoping.ts` (scoping phase) and
 * `courses.tx.ts` (the close transactions).
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
// Params
// ---------------------------------------------------------------------------

/** Parameters required to create a new course row. */
export interface CreateCourseParams {
  /** FK to `user_profiles.id` — the learner who owns this course. */
  userId: string;
  /** Free-text description of what the learner wants to study. */
  topic: string;
}

// ---------------------------------------------------------------------------
// Create + reads
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

/**
 * Fetch a course by primary key; throws `NotFoundError` if absent.
 *
 * When `userId` is supplied, scopes ownership: a row owned by a different
 * user is reported as `NotFoundError` (not `Forbidden`) — info-leak-safe,
 * indistinguishable to a caller from "id does not exist". This prevents
 * an attacker from probing for the existence of other users' course IDs.
 */
export async function getCourseById(id: string, userId?: string): Promise<Course> {
  const [row] = await db.select().from(courses).where(eq(courses.id, id));
  if (!row) throw new NotFoundError("course", id);
  // Ownership mismatch is reported as NotFound to avoid leaking existence.
  if (userId !== undefined && row.userId !== userId) {
    throw new NotFoundError("course", id);
  }
  return courseRowGuard(row);
}

/**
 * Every course id, oldest first. The XP repair script
 * (`scripts/recompute-course-total-xp.ts`) loops over them.
 */
export async function listCourseIds(): Promise<readonly string[]> {
  const rows = await db
    .select({ id: courses.id })
    .from(courses)
    .orderBy(asc(courses.createdAt), asc(courses.id));
  return rows.map((r) => r.id);
}
