/**
 * Repair `courses.total_xp` (issue #208). Recomputes every course's total from
 * the rows that record each award, through `recomputeCourseTotalXp`.
 *
 * Run it through a recipe, never bare: the recipe's guard checks the database
 * first. `just recompute-course-xp` runs on the dev database;
 * `just recompute-course-xp-prod` runs on production. Each is a dry run unless
 * passed `--apply`.
 *
 * A dry run reads and reports, and writes nothing. `--apply` writes. Each
 * course runs in its own transaction under its row lock, so a live Turn's
 * save queues behind it. A second `--apply` run changes nothing.
 *
 * It prints counts only: no course or learner ids, and no content. A failure
 * prints `errorLogLine`'s content-free line, because a DB error's message
 * lists its params.
 *
 * Connects through `DIRECT_URL`, the URL both recipe guards check, so the
 * guard and the connection agree. Reads it from `process.env`, not
 * `getEnv()`: `.env.production.local` holds only the database URLs, not the
 * LLM keys the full env schema requires. No LLM call.
 */

/* eslint-disable no-console -- CLI script: console is the output channel. */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { z } from "zod/v4";
import * as schema from "@/db/schema";
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

  const url = z.url().safeParse(process.env.DIRECT_URL);
  if (!url.success) {
    // Echo no value: a malformed URL can hold the password.
    console.error("DIRECT_URL is missing or malformed. Run through `just recompute-course-xp`.");
    process.exit(1);
  }
  // One connection: the loop runs one transaction at a time. A direct URL,
  // not the PgBouncer pool, so prepared statements are fine.
  const client = postgres(url.data, { max: 1 });
  // Without `end()`, the open socket keeps the process alive after `main`.
  try {
    const database = drizzle(client, { schema });
    const courseIds = await listCourseIds(database);
    // Sequential: one short transaction at a time, so the repair holds at
    // most one course row lock. A local array with `push` reads plainer than
    // an async reduce.
    const results: CourseTotalXpRecompute[] = [];
    for (const courseId of courseIds) {
      results.push(await recomputeCourseTotalXp(courseId, { apply }, database));
    }

    const changed = results.filter((r) => r.newTotal !== r.oldTotal);
    const delta = changed.reduce((sum, r) => sum + (r.newTotal - r.oldTotal), 0);
    console.log(apply ? "mode: apply (writes)" : "mode: dry run (no writes; pass --apply)");
    console.log(`courses scanned: ${results.length}`);
    console.log(`courses ${apply ? "changed" : "that would change"}: ${changed.length}`);
    console.log(`summed delta: ${delta >= 0 ? "+" : ""}${delta} XP`);
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(errorLogLine("[recompute-course-xp] failed", {}, error));
  // CLI entrypoint must signal failure to the shell.
  process.exitCode = 1;
});
