# src/db

Persistence layer. Drizzle schema is the source of truth; SQL migrations
are generated, never hand-written (one allowed bootstrap edit:
prepending `CREATE EXTENSION pgcrypto;` to `0000_init.sql`).

Layout:

- `schema/` — one file per table; barrel re-exports in `index.ts`.
- `migrations/` — drizzle-kit output, committed.
- `queries/` — typed query functions; the only place SQL leaves this dir.
- `seed.ts` — idempotent dev-user seed.
- `testing/` — testcontainers harness for integration tests.
- `client.ts` — Drizzle singleton against `DATABASE_URL` (pooled).

Workflow: edit schema TS → `just db-generate <name>` → review SQL diff →
commit both. `just db-migrate` applies. CI re-runs in ephemeral Postgres.
