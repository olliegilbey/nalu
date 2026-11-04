import { z } from "zod/v4";

/**
 * One Supabase auth user, reduced to the facts the orphan rule reads
 * (issue #55). `listAuthUserActivity` parses each `auth.users` row with it:
 * Supabase owns that schema, so the shape is asserted, not trusted.
 *
 * The session fields are the latest value across all of the user's
 * `auth.sessions` rows, or null when they have none. Supabase writes
 * `refreshed_at` on every token refresh, as UTC in a column without a time
 * zone; the query reads it as UTC. Every other column here is `timestamptz`.
 *
 * Drizzle's postgres-js driver returns a raw query's timestamps as Postgres
 * text, such as `2026-08-06 15:49:25.123456+00`. `coerce` parses it with
 * `new Date`, as Drizzle's own timestamp columns do. Unparseable text gives
 * an invalid date, which fails the parse.
 */
export const authUserActivitySchema = z.object({
  id: z.uuid(),
  isAnonymous: z.boolean(),
  // True when a `courses` row names this user. `courses.user_id` references
  // `user_profiles.id`, which mirrors `auth.users.id`.
  ownsCourse: z.boolean(),
  createdAt: z.coerce.date().nullable(),
  lastSignInAt: z.coerce.date().nullable(),
  lastSessionRefreshedAt: z.coerce.date().nullable(),
  lastSessionUpdatedAt: z.coerce.date().nullable(),
});

/** Inferred from {@link authUserActivitySchema}; one auth user's activity facts. */
export type AuthUserActivity = z.infer<typeof authUserActivitySchema>;
