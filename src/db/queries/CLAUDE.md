# src/db/queries

Home for all SQL. Within `src/`, only `src/db/`, tests, and
`src/lib/testing/` import `drizzle-orm` (the eslint `no-restricted-imports`
rule, which lints `src/` only; `scripts/` sits outside it). Callers
import either the barrel `@/db/queries` (`src/server/trpc.ts`, the
wave-turn route) or a single module such as `@/db/queries/courses` (all of
`src/lib/`).

Transactions: the persist files in `src/lib/course/` open `db.transaction`
and pass `tx` to every helper they call, so the writes commit or roll back
together. Most helpers take an optional trailing `tx`. A helper whose
name ends in `InTx` requires it. `courses.tx.ts` holds the `courses` reads
and writes the close transactions run; each re-fetches nothing. The
mid-turn grading tx runs one of them too: `incrementCourseXpInTx`. A
`courses` UPDATE on the `db` singleton inside any of these transactions
would deadlock on the transaction's row lock. A test that needs one of these
writes passes `db` as the handle; do not add a `db`-bound twin.

Lock order: a transaction that writes course XP locks the course row first.
`persistWaveMidTurn` and `persistWaveClose` open with `lockCourseRowInTx`.
`persistScopingClose` opens with a `courses` UPDATE. Every such transaction
then queues on the course row before it locks a Wave or assessment row, so
no two of them can deadlock (`persistWaveLockOrder.integration.test.ts`).

Modules: one base file per table (`userProfiles.ts`, `courses.ts`,
`scopingPasses.ts`, `waves.ts`, `contextMessages.ts`, `concepts.ts`,
`assessments.ts`). A base file past ~200 lines splits into dot-suffixed
siblings, one concern each:

- `courses.ts`: row guard, create, reads. `courses.scoping.ts`: scoping-phase
  writes. `courses.tx.ts`: the close transactions' reads and writes:
  activation, tier, and XP, plus the course-row lock.
- `waves.ts`: row guard and reads. `waves.writes.ts`: open, close, and the
  `chat_log` append.
- `concepts.ts`: reads. `concepts.writes.ts`: upsert and SM-2 results.
- `contextMessages.ts`: shared types and reads. `contextMessages.writes.ts`:
  single and batch append.
- `assessments.ts`: reads. `assessments.open.ts`: a questionnaire's
  placeholder rows. `assessments.grade.ts`: grades an existing row, and
  locks it first (`lockAssessmentForGradingInTx`) so the course XP bump
  follows the row. `assessments.fixtures.ts` seeds the two integration
  suites; tests import it, production never does.

Integration tests split the same way and sit beside their module
(`courses.scoping.integration.test.ts`). The barrel `index.ts` re-exports
every module; add each new sibling there. Knip follows the barrel's
`export *` and flags an export that nothing imports. Keep query modules
out of knip's `entry` list: knip counts every export of an entry as used.
Knip also counts a test import as use, so `just deadcode` runs a second
pass, `knip --production`, that skips tests and fails on an export only
tests call. Shared `NotFoundError` lives in `errors.ts`.

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
