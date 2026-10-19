import { sql } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "@/db/client";
import type { BaselineClosedJsonb } from "@/lib/types/jsonb";
import { NotFoundError } from "./errors";

/**
 * `courses` queries for the transactions that write course state:
 * `persistScopingClose`, `persistWaveClose` and `persistWaveMidTurn` (the
 * mid-turn grading tx bumps XP through `applyAssessmentGrading`). Each takes
 * the caller's `tx` and runs only on it. Tests pass `db` to run one outside a
 * transaction.
 *
 * A `courses` write on the `db` singleton inside one of these transactions
 * would wait on the row lock the transaction holds, and the transaction would
 * wait on it: a deadlock. The writes re-fetch nothing. The Wave saves read
 * the new total once, last, through `getCourseTotalXpInTx`.
 *
 * All statements use raw `tx.execute(sql\`...\`)` (house style).
 */

/**
 * Lock a course row inside the caller's tx. The Wave save transactions call
 * it first, so every transaction that writes course XP queues on the course
 * row before it locks a Wave or assessment row. One shared first lock means
 * no lock cycle between them.
 *
 * `FOR NO KEY UPDATE` is the lock a `total_xp` UPDATE takes anyway. It
 * blocks the other writers of this row, but not inserts that only reference
 * the course (a concept or Wave insert's foreign-key check).
 *
 * @throws {NotFoundError} if `courseId` does not match any row.
 */
export async function lockCourseRowInTx(courseId: string, tx: DbOrTx): Promise<void> {
  const rows = await tx.execute(
    sql`SELECT id FROM courses WHERE id = ${courseId} FOR NO KEY UPDATE`,
  );
  if (rows.length === 0) throw new NotFoundError("course", courseId);
}

/**
 * A course's raw `baseline` and `framework` JSONB, unparsed. The caller
 * parses with the schema it expects. A type alias, not an interface:
 * `tx.execute<T>` needs `T` assignable to `Record<string, unknown>`.
 */
export type CourseBaselineAndFramework = {
  readonly baseline: unknown;
  readonly framework: unknown;
};

/**
 * Read a course's `baseline` and `framework` JSONB inside the caller's tx.
 *
 * Returns `null` when no row matches. Raw `tx.execute` returns snake_case
 * keys; both columns are single words, so they map as-is.
 */
export async function getCourseBaselineAndFrameworkInTx(
  courseId: string,
  tx: DbOrTx,
): Promise<CourseBaselineAndFramework | null> {
  const rows = await tx.execute<CourseBaselineAndFramework>(
    sql`SELECT baseline, framework FROM courses WHERE id = ${courseId}`,
  );
  return rows[0] ?? null;
}

/**
 * Overwrite `courses.baseline` with the closed (widened) shape inside the
 * caller's tx. The caller parses `baseline` before it calls this.
 */
export async function setCourseBaselineInTx(
  courseId: string,
  baseline: BaselineClosedJsonb,
  tx: DbOrTx,
): Promise<void> {
  await tx.execute(sql`
    UPDATE courses
    SET baseline = ${JSON.stringify(baseline)}::jsonb,
        updated_at = NOW()
    WHERE id = ${courseId}
  `);
}

/** What scoping close writes when it activates a course. */
export interface CourseActivation {
  /** The evolving summary seed. The immutable summary lives in the baseline JSONB. */
  readonly summary: string;
  /** Tier from the baseline grading. Sets both `starting_tier` and `current_tier`. */
  readonly startingTier: number;
}

/**
 * Flip a course from `scoping` to `active` inside the caller's tx: status,
 * summary, and both tiers.
 *
 * `WHERE status = 'scoping'` makes it a no-op on a course that already left
 * scoping (idempotency at the row level). The caller validates `startingTier`.
 */
export async function setCourseStartingStateInTx(
  courseId: string,
  activation: CourseActivation,
  tx: DbOrTx,
): Promise<void> {
  await tx.execute(sql`
    UPDATE courses
    SET status = 'active',
        summary = ${activation.summary},
        summary_updated_at = NOW(),
        starting_tier = ${activation.startingTier},
        current_tier = ${activation.startingTier},
        updated_at = NOW()
    WHERE id = ${courseId}
      AND status = 'scoping'
  `);
}

/**
 * Overwrite `courses.summary` inside the caller's tx. Wave close calls it
 * with the close turn's summary, which rewrites the whole course summary.
 *
 * Each Wave turn renders this column into the system prompt. Call it only
 * at a Wave close: the closing Wave takes no more turns, so only the next
 * Wave's prompt sees the new value.
 */
export async function setCourseSummaryInTx(
  courseId: string,
  summary: string,
  tx: DbOrTx,
): Promise<void> {
  await tx.execute(sql`
    UPDATE courses
    SET summary = ${summary},
        summary_updated_at = NOW(),
        updated_at = NOW()
    WHERE id = ${courseId}
  `);
}

/** Set `courses.current_tier` inside the caller's tx. */
export async function updateCourseTierInTx(
  courseId: string,
  newTier: number,
  tx: DbOrTx,
): Promise<void> {
  await tx.execute(sql`
    UPDATE courses
    SET current_tier = ${newTier},
        updated_at = NOW()
    WHERE id = ${courseId}
  `);
}

/**
 * Add `amount` XP to `courses.total_xp` inside the caller's tx.
 *
 * `total_xp + amount` in SQL avoids a read-modify-write race. The caller
 * validates `amount`. It is negative only when a re-grade lowers a row's
 * XP (`applyAssessmentGrading`).
 */
export async function incrementCourseXpInTx(
  courseId: string,
  amount: number,
  tx: DbOrTx,
): Promise<void> {
  await tx.execute(sql`
    UPDATE courses
    SET total_xp = total_xp + ${amount},
        updated_at = NOW()
    WHERE id = ${courseId}
  `);
}

/**
 * The `total_xp` row shape. Raw `tx.execute` skips Drizzle's typing, so the
 * read is parsed. The CHECK `courses_total_xp_nonneg` keeps it at zero or above.
 */
const courseTotalXpRowSchema = z.object({ total_xp: z.number().int().nonnegative() });

/**
 * Read `courses.total_xp` inside the caller's tx. The Wave saves call it after
 * their last XP write. They hold the course-row lock, so the value read is the
 * value the tx commits.
 *
 * @throws {NotFoundError} if `courseId` does not match any row.
 */
export async function getCourseTotalXpInTx(courseId: string, tx: DbOrTx): Promise<number> {
  const rows = await tx.execute(sql`SELECT total_xp FROM courses WHERE id = ${courseId}`);
  if (rows.length === 0) throw new NotFoundError("course", courseId);
  return courseTotalXpRowSchema.parse(rows[0]).total_xp;
}
