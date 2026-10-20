import { sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";

/**
 * `courses` writes for the course XP repair, `recomputeCourseTotalXp`
 * (issue #208). It runs them in its own transaction, after
 * `lockCourseRowInTx` (`courses.tx.ts`), and reads through `courses.tx.ts`.
 *
 * All statements use raw `tx.execute(sql\`...\`)` (house style).
 */

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
