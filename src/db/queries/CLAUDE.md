# src/db/queries

Intended home for all SQL. Callers import either the barrel `@/db/queries`
(`src/server/trpc.ts`, the wave-turn route) or a single module such as
`@/db/queries/courses` (all of `src/lib/`).

Exceptions: the transactional persist files in `src/lib/course/` open
`db.transaction` themselves. `submitBaseline.persist.ts`,
`persistWaveClose.ts`, and `persistWaveClose.helpers.ts` write `courses`
with raw ``tx.execute(sql`UPDATE courses ...`)``, because the `courses`
helpers here take no `tx` and run on the `db` singleton.
`persistWaveMidTurn.ts` runs a Drizzle select on `context_messages`
inside its transaction.

Modules (one per domain): `userProfiles.ts`, `courses.ts`, `scopingPasses.ts`,
`waves.ts`, `contextMessages.ts`, `concepts.ts`, `assessments.ts`. Shared
`NotFoundError` lives in `errors.ts`.

Conventions:

- Typed param objects in; `readonly` Drizzle row types out.
- Single-row reads by id throw `NotFoundError(entity, id)`. Lookups that
  can legitimately find nothing (e.g. `getOpenWaveByCourse`) return `null`.
- JSONB columns are re-validated on read via Zod row-guards
  (e.g. `waveRowGuard`, `courseRowGuard`) — never trust the DB shape.
- Parameterised SQL only — interpolate values via `${value}` inside
  `` sql`...` ``; never string-concatenate user input.

Drizzle gotchas (codified after hitting them):

- Updates use raw ``db.execute(sql`UPDATE ...`)`` with parameterised
  values, then re-fetch via a typed `.select()` so Drizzle's camelCase
  mapping applies. This is house style. Its original reason (an
  `eslint-plugin-functional` crash on `db.update().set()`) is gone; that
  plugin was removed. Do not use `RETURNING *` on raw SQL — it returns
  snake_case keys that don't match the inferred row type.
- `db.insert().onConflictDoUpdate` rejects a SQL-expression `target` in
  this Drizzle version (`escapeName` only accepts column references). For
  functional-index targets (e.g. `lower(name)`), use raw
  `INSERT ... ON CONFLICT (...) DO NOTHING` plus a Drizzle re-fetch on the
  natural key (`upsertConcept`).
- `Date` values in raw SQL: pass `.toISOString()`.
- Atomic counter bumps: raw `SET col = col + 1` (avoids read-modify-write).
