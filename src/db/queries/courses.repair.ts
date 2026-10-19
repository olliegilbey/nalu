import { sql } from "drizzle-orm";
import { z } from "zod";
import type { DbOrTx } from "@/db/client";
import { NotFoundError } from "./errors";

/**
 * `courses` queries for the course XP repair, `recomputeCourseTotalXp`
 * (issue #208). It runs them in its own transaction, after
 * `lockCourseRowInTx` (`courses.tx.ts`). Each takes the caller's `tx`.
 *
 * All statements use raw `tx.execute(sql\`...\`)` (house style).
 */

/** The repair's read of one course row. `baseline` stays raw; the caller parses it. */
const courseXpAndBaselineSchema = z.object({
  totalXp: z.int().nonnegative(),
  baseline: z.unknown(),
});

/** A course's `total_xp` and raw `baseline` JSONB, as the XP repair reads them. */
export type CourseXpAndBaseline = z.infer<typeof courseXpAndBaselineSchema>;

/**
 * Read a course's `total_xp` and `baseline` inside the caller's tx. The XP
 * repair reads them after `lockCourseRowInTx`, so the total it reads is the
 * total it replaces.
 *
 * @throws {NotFoundError} if `courseId` does not match any row.
 */
export async function getCourseXpAndBaselineInTx(
  courseId: string,
  tx: DbOrTx,
): Promise<CourseXpAndBaseline> {
  // Raw SQL returns snake_case keys, so alias `total_xp` to the camelCase field.
  const rows = await tx.execute(
    sql`SELECT total_xp AS "totalXp", baseline FROM courses WHERE id = ${courseId}`,
  );
  const row = rows[0];
  if (!row) throw new NotFoundError("course", courseId);
  // Trust boundary: `tx.execute` rows are untyped.
  return courseXpAndBaselineSchema.parse(row);
}

/**
 * Set `courses.total_xp` to an absolute value inside the caller's tx. Only
 * the XP repair sets the total; the live writers add a change through
 * `incrementCourseXpInTx`.
 */
export async function setCourseTotalXpInTx(
  courseId: string,
  totalXp: number,
  tx: DbOrTx,
): Promise<void> {
  await tx.execute(sql`
    UPDATE courses
    SET total_xp = ${totalXp},
        updated_at = NOW()
    WHERE id = ${courseId}
  `);
}
