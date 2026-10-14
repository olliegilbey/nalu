import { sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import type { BaselineClosedJsonb } from "@/lib/types/jsonb";

/**
 * `courses` queries for the close transactions: `persistScopingClose` and
 * `persistWaveClose`. Each takes the caller's `tx` and runs only on it.
 * Tests pass `db` to run one outside a transaction.
 *
 * A `courses` write on the `db` singleton inside a close transaction would
 * wait on the row lock the transaction holds, and the transaction would wait
 * on it: a deadlock. These helpers re-fetch nothing; the close transactions
 * need no row back.
 *
 * All statements use raw `tx.execute(sql\`...\`)` (house style).
 */

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
 * validates `amount`.
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
