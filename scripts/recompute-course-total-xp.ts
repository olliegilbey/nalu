/**
 * Repair `courses.total_xp` (issue #208). Recomputes every course's total from
 * the rows that record each award, through `recomputeCourseTotalXp`.
 *
 * Run: `just recompute-course-xp` (dry run), then `just recompute-course-xp --apply`.
 *
 * A dry run by default: it reads and reports, and writes nothing. `--apply`
 * writes. Each course runs in its own transaction under its row lock, so a
 * live Turn's save queues behind it. A second `--apply` run changes nothing.
 *
 * It prints counts only: no course or learner ids, and no content. A failure
 * prints `errorLogLine`'s content-free line, because a DB error's message
 * lists its params.
 *
 * DB-only: needs the env schema (`DATABASE_URL`), no LLM call.
 */

/* eslint-disable no-console -- CLI script: console is the output channel. */

import { listCourseIds } from "@/db/queries/courses";
import {
  recomputeCourseTotalXp,
  type CourseTotalXpRecompute,
} from "@/lib/course/recomputeCourseTotalXp";
import { errorLogLine } from "@/lib/security/errorLogLine";

const USAGE = "usage: recompute-course-total-xp [--apply]";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // Refuse a typo such as `--aply`: it would silently run a dry run.
  if (args.some((a) => a !== "--apply")) {
    console.error(USAGE);
    process.exit(1);
  }
  const apply = args.includes("--apply");

  const courseIds = await listCourseIds();
  // Sequential: one short transaction at a time, so the repair holds at most
  // one course row lock. A local array with `push` reads plainer than an
  // async reduce.
  const results: CourseTotalXpRecompute[] = [];
  for (const courseId of courseIds) {
    results.push(await recomputeCourseTotalXp(courseId, { apply }));
  }

  const changed = results.filter((r) => r.newTotal !== r.oldTotal);
  const delta = changed.reduce((sum, r) => sum + (r.newTotal - r.oldTotal), 0);
  console.log(apply ? "mode: apply (writes)" : "mode: dry run (no writes; pass --apply)");
  console.log(`courses scanned: ${results.length}`);
  console.log(`courses ${apply ? "changed" : "that would change"}: ${changed.length}`);
  console.log(`summed delta: ${delta >= 0 ? "+" : ""}${delta} XP`);
  process.exit(0);
}

main().catch((error: unknown) => {
  console.error(errorLogLine("[recompute-course-xp] failed", {}, error));
  process.exit(1);
});
