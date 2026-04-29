import { eq, and, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { scopingPasses, type ScopingPass } from "@/db/schema";
import { NotFoundError } from "./errors";

/**
 * `scopingPasses` query surface (spec §3.3).
 *
 * All UPDATE statements use raw `db.execute(sql\`...\`)` to avoid the
 * `eslint-plugin-functional/immutable-data` crash on `db.update().set()` —
 * confirmed pattern from D3/D4.
 */

// Re-export so callers have one import site for the error class.
export { NotFoundError } from "./errors";

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/**
 * Return the single open scoping pass for `courseId`, or `null` if none exists.
 *
 * Only one open pass per course is enforced at the DB level (UNIQUE on
 * `course_id`), so at most one row can satisfy `status = 'open'`.
 */
export async function getOpenScopingPassByCourse(courseId: string): Promise<ScopingPass | null> {
  const [row] = await db
    .select()
    .from(scopingPasses)
    .where(and(eq(scopingPasses.courseId, courseId), eq(scopingPasses.status, "open")));
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Insert a new scoping pass for `courseId` with `status = 'open'` and return it.
 *
 * The DB UNIQUE constraint on `course_id` will throw if a pass already exists
 * for this course (open or closed). Callers that need to handle that case
 * should check `getOpenScopingPassByCourse` first.
 */
export async function openScopingPass(courseId: string): Promise<ScopingPass> {
  const [row] = await db.insert(scopingPasses).values({ courseId }).returning();
  // The insert must return a row — no scenario where it doesn't on success.
  if (!row) throw new Error("openScopingPass: insert returned no row");
  return row;
}

/**
 * Flip a scoping pass to `status = 'closed'` and stamp `closed_at`.
 *
 * Uses raw SQL to avoid `immutable-data` lint crash on `db.update().set()`.
 * Re-fetches via typed Drizzle select so the returned row has correct
 * camelCase mapping (raw `RETURNING *` gives snake_case from the driver).
 *
 * @throws {NotFoundError} if `id` does not match any row.
 */
export async function closeScopingPass(id: string): Promise<ScopingPass> {
  // Raw SQL UPDATE — mirrors the D4 pattern exactly.
  await db.execute(
    sql`UPDATE scoping_passes SET status = 'closed', closed_at = NOW() WHERE id = ${id}`,
  );
  // Re-fetch for camelCase mapping via Drizzle's typed select.
  const [row] = await db.select().from(scopingPasses).where(eq(scopingPasses.id, id));
  if (!row) throw new NotFoundError("scoping_pass", id);
  return row;
}
