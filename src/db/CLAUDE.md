# src/db

Persistence layer. Drizzle schema is the source of truth; SQL migrations
are generated, never hand-written. Two exceptions exist: the bootstrap
`CREATE EXTENSION pgcrypto;` prepended to `0000_init.sql`, and the
hand-written data migration `0005_jsonb_rewrite.sql` (journal entry, no
snapshot).

Layout:

- `schema/` — one file per table; barrel re-exports in `index.ts`.
  drizzle-kit loads every file in this folder, so tests for it live in
  `src/db/`. `concepts.ts` reads its SM-2 default and floor from `SM2` in
  `src/lib/config/tuning.ts`, so a retune is a schema change too.
- `migrations/` — drizzle-kit output, committed.
- `queries/` — typed query functions; the home for all SQL. See
  `queries/CLAUDE.md` for how transactions thread `tx` through them.
- `seed.ts` — idempotent dev-user seed.
- `reset.ts` — `just db-reset` wipe: drops the `public` and `drizzle`
  schemas at `DIRECT_URL`. Refuses unless `everyHostIsLoopback` passes the
  hosts postgres-js parsed: it is destructive.
- `everyHostIsLoopback.ts` — the one loopback rule, `isLoopbackHost`:
  `localhost` (any case, optional trailing dot), 127.0.0.0/8, `0.0.0.0`,
  `::1`. Every DB gate uses it.
- `assertLocalDirectUrl.ts` — gate for `just db-migrate` and `just db-seed`.
  Refuses unless every `DIRECT_URL` host is loopback, so `db-migrate-prod` is
  the only path to a remote database.
- `assertRemoteDirectUrl.ts` — `just db-migrate-prod` gate. Refuses a
  missing `DIRECT_URL`, or one with an empty or loopback host under the
  postgres-js or WHATWG parse.
- `testing/` — testcontainers harness for integration tests.
- `client.ts` — Drizzle singleton against `DATABASE_URL` (pooled).

Dev database: `just db-up` runs `postgres:16-alpine` (the integration-test
image) as the `nalu-dev-db` container on `127.0.0.1:54322`, with a named
volume and trust auth (loopback only, throwaway data), so its URL has no
password. `.env.local` points there and holds no production values. The
migrations need nothing Supabase-specific: `0008_enable_rls` enables RLS with
no policies, and the `postgres` superuser bypasses RLS.

Workflow: edit schema TS → `just db-generate <name>` → review SQL diff →
commit both. `just db-migrate` applies to dev. `just db-migrate-prod` applies
to production, reading `DIRECT_URL` from the gitignored
`.env.production.local`. CI re-runs in ephemeral Postgres.

`schemaMigrationDrift.test.ts` (unit tier) diffs the schema against the
newest committed snapshot, as `generate` does. Red prints the SQL that would
close the gap. If that SQL adds your schema or tuning edit, run
`just db-generate <name>` and commit it. If it undoes a committed migration,
restore the schema edit instead. A rename fails with "Interactive prompts
require a TTY"; `just db-generate` asks rename-or-recreate instead. The test
reads snapshots, never `.sql`: hand-written SQL (a journal entry with no
snapshot, like 0005, or `drizzle-kit generate --custom`) can disagree with
the schema and still pass.

A CHECK on a `real` column casts its bound to `::real`. Postgres compares a
bare decimal in float8, where real 1.3 (1.29999995) fails `>= 1.3` (issue
#210).
