import type { DB } from "@/db/client";
import { deleteUsersInTx, listAuthUserActivity } from "@/db/queries/authUsers";
import { ANONYMOUS_USERS } from "@/lib/config/tuning";
import { isOrphanAnonymousUser } from "./isOrphanAnonymousUser";

/** Milliseconds in one day: turns `ANONYMOUS_USERS.orphanIdleDays` into a cutoff. */
const MILLISECONDS_PER_DAY = 86_400_000;

/** Counts from one cleanup run. `deleted` is 0 on a dry run. */
export interface OrphanAnonymousUserCleanup {
  readonly scanned: number;
  readonly orphans: number;
  readonly deleted: number;
}

/**
 * Find the orphan anonymous users and, when `apply` is on, delete them with
 * their profile rows (issue #55). With `apply: false` it is a dry run: it
 * reads and counts only.
 *
 * One transaction: the read and the delete see the same users, so a second
 * run finds no orphans. A learner who returns in the milliseconds between
 * them can still lose their identity; an orphan has been idle for
 * `ANONYMOUS_USERS.orphanIdleDays`, so that is accepted.
 *
 * `database` is the cleanup script's own client on `DIRECT_URL`, the URL its
 * recipe's guard checks.
 */
export async function deleteOrphanAnonymousUsers(
  options: { readonly apply: boolean },
  database: DB,
): Promise<OrphanAnonymousUserCleanup> {
  const idleBefore = new Date(Date.now() - ANONYMOUS_USERS.orphanIdleDays * MILLISECONDS_PER_DAY);
  return database.transaction(async (tx) => {
    const users = await listAuthUserActivity(tx);
    const orphanIds = users
      .filter((user) => isOrphanAnonymousUser(user, idleBefore))
      .map((user) => user.id);
    const deleted = options.apply ? await deleteUsersInTx(orphanIds, tx) : 0;
    return { scanned: users.length, orphans: orphanIds.length, deleted };
  });
}
