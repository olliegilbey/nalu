# src/db/queries

Intended home for all SQL. Callers import either the barrel `@/db/queries`
(`src/server/trpc.ts`, the wave-turn route) or a single module such as
`@/db/queries/courses` (all of `src/lib/`).

Exceptions: the transactional persist files in `src/lib/course/` open
`db.transaction` themselves. `submitBaseline.persist.ts`,
`persistWaveClose.ts`, and `persistWaveClose.helpers.ts` write `courses`
with raw ``tx.execute(sql`UPDATE courses ...`)``, because the `courses`
helpers here take no `tx` and run on the `db` singleton. Issue #46 tracks
moving these into tx-aware query helpers.

Modules: one base file per table (`userProfiles.ts`, `courses.ts`,
`scopingPasses.ts`, `waves.ts`, `contextMessages.ts`, `concepts.ts`,
`assessments.ts`). A base file past ~200 lines splits into dot-suffixed
siblings, one concern each:

- `courses.ts`: row guard, create, reads. `courses.scoping.ts`: scoping-phase
  writes. `courses.progress.ts`: summary, tier, XP, and archive writes.
- `waves.ts`: row guard and reads. `waves.writes.ts`: open, close, and the
  `chat_log` append.
- `concepts.ts`: reads. `concepts.writes.ts`: upsert, SM-2 results, and
  counters.
- `contextMessages.ts`: shared types and reads. `contextMessages.writes.ts`:
  single and batch append.
- `assessments.ts`: reads. `assessments.record.ts`: one probe, graded at
  insert. `assessments.open.ts`: a questionnaire's placeholder rows.
  `assessments.grade.ts`: grades an existing row. `assessments.fixtures.ts`
  seeds the three integration suites; tests import it, production never does.

Integration tests split the same way and sit beside their module
(`courses.scoping.integration.test.ts`). The barrel `index.ts` re-exports
every module. Add each new sibling there: knip sees test-only
exports as used only through the barrel. Shared `NotFoundError` lives in
`errors.ts`.

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
