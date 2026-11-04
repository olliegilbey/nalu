import type { AuthUserActivity } from "@/lib/types/authUserActivity";

/**
 * The orphan rule (issue #55): true for an anonymous user who owns no course
 * and whose last activity is before `idleBefore`. The cleanup deletes exactly
 * these users.
 *
 * A user with no known activity time is kept: an unknown age is not proof
 * of idleness. A session row alone proves nothing either: every anonymous
 * user keeps one, live or dead, so only its timestamps count.
 */
export function isOrphanAnonymousUser(user: AuthUserActivity, idleBefore: Date): boolean {
  if (!user.isAnonymous || user.ownsCourse) return false;
  const lastActivity = lastActivityAt(user);
  return lastActivity !== null && lastActivity < idleBefore;
}

/**
 * The latest of the user's creation, last sign-in, and session refresh and
 * update times. Null when every one is null.
 */
function lastActivityAt(user: AuthUserActivity): Date | null {
  const times = [
    user.createdAt,
    user.lastSignInAt,
    user.lastSessionRefreshedAt,
    user.lastSessionUpdatedAt,
  ].filter((time) => time !== null);
  if (times.length === 0) return null;
  return new Date(Math.max(...times.map((time) => time.getTime())));
}
