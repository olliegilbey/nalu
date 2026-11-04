# src/lib/anonymous-users

The lifecycle of Supabase anonymous users. Today it holds the orphan cleanup only (issue #55).

- `isOrphanAnonymousUser.ts`: the orphan rule, pure and unit-tested. An orphan is an anonymous auth user who owns no course, and whose last activity is before the cutoff. Last activity is the latest of `auth.users.created_at`, `auth.users.last_sign_in_at`, and the user's `auth.sessions` `refreshed_at` and `updated_at`. A user with no known activity time is kept. A session row alone proves nothing: every anonymous user keeps one, live or dead.
- `deleteOrphanAnonymousUsers.ts`: runs the rule over every auth user and, with `apply`, deletes each orphan's `user_profiles` row, then its `auth.users` row. The cutoff is `ANONYMOUS_USERS.orphanIdleDays` in `src/lib/config/tuning.ts`. One transaction holds the read and the delete. It returns counts only.
- The queries live in `src/db/queries/authUsers.ts`. Supabase owns the `auth` schema, so it has no Drizzle table: the queries are raw SQL, Zod-parsed through `authUserActivitySchema` (`src/lib/types/authUserActivity.ts`).
- `user_profiles.id` mirrors `auth.users.id` with no foreign key, so deleting an auth user leaves its profile. The cleanup deletes both. Deleting a profile cascades to its courses; an orphan owns none.
- `scripts/delete-orphan-anonymous-users.ts` is the only caller. Run it through `just delete-orphan-anon-users` (dev) or `just delete-orphan-anon-users-prod` (production). Each is a dry run unless passed `--apply`. The deletion keeps no undo record.
- The integration test stubs the `auth` tables it reads: plain Postgres has no `auth` schema.
