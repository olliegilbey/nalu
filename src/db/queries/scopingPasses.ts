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

/** Re-exported domain error for missing query targets — single import site for callers. */
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
 * Return the open scoping pass for `courseId`, opening one if absent.
 *
 * Idempotent under the single-writer invariant: a re-entrant call returns
 * the same row. The DB UNIQUE constraint on `course_id` is the backstop
 * if two writers ever raced — the previous implementation surfaced that
 * race as a UNIQUE-violation exception. Now we catch the violation and
 * re-fetch, restoring idempotency under genuine concurrency.
 *
 * @throws when the second read after a unique-violation still finds no row
 *   (only possible if another writer closed the pass mid-flight).
 */
export async function ensureOpenScopingPass(courseId: string): Promise<ScopingPass> {
  const existing = await getOpenScopingPassByCourse(courseId);
  if (existing) return existing;
  try {
    return await openScopingPass(courseId);
  } catch (err) {
    // postgres-js surfaces the unique-violation code (SQLSTATE 23505) on `.code`.
    // A different writer beat us; re-read should now find the open row.
    if (isUniqueViolation(err)) {
      const after = await getOpenScopingPassByCourse(courseId);
      if (after) return after;
    }
    throw err;
  }
}

/** Narrow an unknown thrown value to a Postgres unique-violation (SQLSTATE 23505). */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "23505"
  );
}

/**
 * Flip a scoping pass to `status = 'closed'` and stamp `closed_at`.
 *
 * Idempotent: `COALESCE(closed_at, NOW())` means a second call returns the
 * same `closed_at` as the first — the timestamp never re-stamps. The
 * `status = 'open'` scope prevents accidentally updating a row that another
 * path already closed via a different status value.
 *
 * 0-row UPDATE is ambiguous (id unknown vs already closed), so we re-fetch
 * unconditionally to distinguish. If the row exists in any status, return it.
 *
 * @throws {NotFoundError} if `id` does not match any row at all.
 */
export async function closeScopingPass(id: string): Promise<ScopingPass> {
  // COALESCE makes closed_at sticky — calling closeScopingPass twice returns
  // the same closed_at both times. Status-scope prevents accidentally
  // re-stamping a row that some other path closed.
  await db.execute(
    sql`UPDATE scoping_passes
        SET status = 'closed',
            closed_at = COALESCE(closed_at, NOW())
        WHERE id = ${id}
          AND status = 'open'`,
  );
  // 0-row UPDATE is ambiguous: id unknown OR already closed. Re-fetch to
  // distinguish. If the row exists at all, return it (idempotent close).
  const [row] = await db.select().from(scopingPasses).where(eq(scopingPasses.id, id));
  if (!row) throw new NotFoundError("scoping_pass", id);
  return row;
}
