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
  `src/lib/config/tuning.ts`; `schemaTuningDrift.test.ts` pins the latest
  migration snapshot to them.
- `migrations/` — drizzle-kit output, committed.
- `queries/` — typed query functions; the home for all SQL. See
  `queries/CLAUDE.md` for how transactions thread `tx` through them.
- `seed.ts` — idempotent dev-user seed.
- `reset.ts` — `just db-reset` wipe: drops the `public` and `drizzle`
  schemas at `DIRECT_URL`. Refuses unless `everyHostIsLoopback` (`everyHostIsLoopback.ts`)
  passes the hosts postgres-js parsed; `.env.local` may point at production.
- `testing/` — testcontainers harness for integration tests.
- `client.ts` — Drizzle singleton against `DATABASE_URL` (pooled).

Workflow: edit schema TS → `just db-generate <name>` → review SQL diff →
commit both. `just db-migrate` applies. CI re-runs in ephemeral Postgres.

A CHECK on a `real` column casts its bound to `::real`. Postgres compares a
bare decimal in float8, where real 1.3 (1.29999995) fails `>= 1.3` (issue
#210).
