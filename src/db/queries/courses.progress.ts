import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import type { Course } from "@/db/schema";
import { NotFoundError } from "./errors";
import { getCourseById } from "./courses";

/**
 * `courses` writes after scoping: summary, tier, XP, and archive.
 *
 * All UPDATE statements use raw `db.execute(sql\`...\`)` (house style).
 */

/**
 * Overwrite the cumulative course summary.
 *
 * No production caller today: Wave close writes `waves.summary`, not this.
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
 * Set `current_tier` to the tier the progression code chose.
 *
 * `checkTierAdvancement` (`src/lib/scoring/progression.ts`) decides; this
 * function just persists the decision. Advancement is one-way today; issue
 * #85 tracks demotion. Wave close runs in a transaction, so it calls the
 * twin `updateCourseTierInTx` instead.
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
