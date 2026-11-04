/**
 * Delete orphan anonymous users (issue #55): anonymous Supabase auth users
 * who own no course and have been idle for `ANONYMOUS_USERS.orphanIdleDays`.
 * `isOrphanAnonymousUser` holds the rule; `deleteOrphanAnonymousUsers` runs
 * it and deletes each orphan's `user_profiles` row, then its `auth.users`
 * row.
 *
 * Run it through a recipe, never bare: the recipe's guard checks the database
 * first. `just delete-orphan-anon-users` runs on the dev database;
 * `just delete-orphan-anon-users-prod` runs on production. Each is a dry run
 * unless passed `--apply`.
 *
 * A dry run reads and reports, and writes nothing. `--apply` deletes, in one
 * transaction, and keeps no undo record. A second `--apply` run deletes
 * nothing.
 *
 * It prints counts only: no user ids, and no content. A failure prints
 * `errorLogLine`'s content-free line, because a DB error's message lists its
 * params.
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
import { deleteOrphanAnonymousUsers } from "@/lib/anonymous-users/deleteOrphanAnonymousUsers";
import { ANONYMOUS_USERS } from "@/lib/config/tuning";
import { errorLogLine } from "@/lib/security/errorLogLine";

const USAGE = "usage: delete-orphan-anonymous-users [--apply]";

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
    console.error(
      "DIRECT_URL is missing or malformed. Run through `just delete-orphan-anon-users`.",
    );
    process.exit(1);
  }
  // One connection: the cleanup runs one transaction. A direct URL, not the
  // PgBouncer pool, so prepared statements are fine.
  const client = postgres(url.data, { max: 1 });
  // Without `end()`, the open socket keeps the process alive after `main`.
  try {
    const database = drizzle(client, { schema });
    const result = await deleteOrphanAnonymousUsers({ apply }, database);
    console.log(apply ? "mode: apply (deletes)" : "mode: dry run (no writes; pass --apply)");
    console.log(`idle cutoff: ${ANONYMOUS_USERS.orphanIdleDays} days`);
    console.log(`auth users scanned: ${result.scanned}`);
    console.log(`orphan anonymous users: ${result.orphans}`);
    // A dry run deletes nothing, so it reports what `--apply` would delete.
    console.log(
      apply ? `users deleted: ${result.deleted}` : `users that would be deleted: ${result.orphans}`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error: unknown) => {
  console.error(errorLogLine("[delete-orphan-anon-users] failed", {}, error));
  // CLI entrypoint must signal failure to the shell.
  process.exitCode = 1;
});
