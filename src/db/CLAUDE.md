# src/db

Persistence layer. Drizzle schema is the source of truth; SQL migrations
are generated, never hand-written. Two exceptions exist: the bootstrap
`CREATE EXTENSION pgcrypto;` prepended to `0000_init.sql`, and the
hand-written data migration `0005_jsonb_rewrite.sql` (journal entry, no
snapshot).

Layout:

- `schema/` — one file per table; barrel re-exports in `index.ts`.
- `migrations/` — drizzle-kit output, committed.
- `queries/` — typed query functions; the intended home for all SQL. See
  `queries/CLAUDE.md` for the transactional exceptions in `src/lib/course/`.
- `seed.ts` — idempotent dev-user seed.
- `testing/` — testcontainers harness for integration tests.
- `client.ts` — Drizzle singleton against `DATABASE_URL` (pooled).

Workflow: edit schema TS → `just db-generate <name>` → review SQL diff →
commit both. `just db-migrate` applies. CI re-runs in ephemeral Postgres.
