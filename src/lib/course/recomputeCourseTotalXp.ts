import { db } from "@/db/client";
import {
  getCourseBaselineAndFrameworkInTx,
  getCourseTotalXpInTx,
  lockCourseRowInTx,
} from "@/db/queries/courses.tx";
import { setCourseTotalXpInTx } from "@/db/queries/courses.repair";
import { countClosedWavesInTx } from "@/db/queries/waves";
import { sumCourseAssessmentXpInTx } from "@/db/queries/assessments";
import { WAVE } from "@/lib/config/tuning";
import { calculateBaselineXp } from "@/lib/scoring/xp";
import { baselineJsonbSchema } from "@/lib/types/jsonb";

/** One course's `total_xp` before and after a recompute. Equal when nothing changed. */
export interface CourseTotalXpRecompute {
  readonly oldTotal: number;
  readonly newTotal: number;
}

/**
 * Recompute one course's `courses.total_xp` from the rows that record each
 * award, and set it when `apply` is on (issue #208):
 *
 *   total = baseline XP
 *         + WAVE.completionXp × closed Waves
 *         + Σ assessments.xp_awarded over the course's Waves
 *
 * The three terms mirror the three live writers: `persistScopingClose`,
 * `persistWaveClose` and `applyAssessmentGrading`. Baseline XP comes from
 * `calculateBaselineXp`, the formula the scoping close uses. Assessment XP
 * is the stored per-row XP; the repair never re-scores a row.
 *
 * One transaction. It locks the course row first, as every XP writer does,
 * so it queues behind a live Turn's save and reads a settled total. It writes
 * only when the total differs, so a second run changes nothing, not even
 * `updated_at`. With `apply: false` it is a dry run: it reads and reports
 * only.
 *
 * @throws {NotFoundError} if `courseId` does not match any row.
 */
export async function recomputeCourseTotalXp(
  courseId: string,
  options: { readonly apply: boolean },
): Promise<CourseTotalXpRecompute> {
  return db.transaction(async (tx) => {
    // Throws NotFoundError for an unknown id. Under the lock, the row stays.
    await lockCourseRowInTx(courseId, tx);
    const oldTotal = await getCourseTotalXpInTx(courseId, tx);
    const course = await getCourseBaselineAndFrameworkInTx(courseId, tx);
    const closedWaves = await countClosedWavesInTx(courseId, tx);
    const assessmentXp = await sumCourseAssessmentXpInTx(courseId, tx);

    const baselineXp = baselineXpOf(course?.baseline ?? null);
    const newTotal = baselineXp + WAVE.completionXp * closedWaves + assessmentXp;
    if (options.apply && newTotal !== oldTotal) {
      await setCourseTotalXpInTx(courseId, newTotal, tx);
    }
    return { oldTotal, newTotal };
  });
}

/**
 * Baseline XP from a course's raw `baseline` JSONB. Only a closed baseline
 * (it carries `startingTier`) earned XP. A course still in scoping has no
 * baseline yet, or an open one, so it earned none.
 *
 * Parses with the row-guard union every course read uses
 * (`courseRowGuard`). Its closed arm is the closed schema, so a malformed
 * baseline throws here instead of scoring.
 */
function baselineXpOf(baseline: unknown): number {
  if (baseline === null) return 0;
  const parsed = baselineJsonbSchema.parse(baseline);
  return "startingTier" in parsed ? calculateBaselineXp(parsed.startingTier, parsed.gradings) : 0;
}
