# src/db/queries

Only place SQL leaves `src/db/`. Callers (tRPC procedures, scripts) import
from `@/db/queries` (the barrel) — never reach into individual files.

Modules (one per domain): `userProfiles.ts`, `courses.ts`, `scopingPasses.ts`,
`waves.ts`, `contextMessages.ts`, `concepts.ts`, `assessments.ts`. Shared
`NotFoundError` lives in `errors.ts`.

Conventions:

- Typed param objects in; `readonly` Drizzle row types out.
- Single-row reads that can miss throw `NotFoundError(entity, id)`.
- JSONB columns are re-validated on read via Zod row-guards
  (e.g. `waveRowGuard`, `courseRowGuard`) — never trust the DB shape.
- Parameterised SQL only (`${value}` in `sql\`\``); never string-concatenate
  user input.

Drizzle gotchas (codified after hitting them):

- `db.update().set()` is BANNED — `eslint-plugin-functional/immutable-data`
  crashes the build on it. Use raw `db.execute(sql\`UPDATE ... SET ...\`)`with parameterised values, then re-fetch via a typed`.select()`so
Drizzle's camelCase mapping applies. Do not use`RETURNING \*` — it returns
  snake_case keys that don't match the inferred row type.
- `db.insert().onConflictDoUpdate({ target: sql\`...\` })` is BANNED for
functional-index targets in this Drizzle version (`escapeName`rejects SQL
expressions). Use raw`INSERT ... ON CONFLICT (...) DO UPDATE` plus a
  Drizzle re-fetch on the natural key.
- `Date` values in raw SQL: pass `.toISOString()`.
- Atomic counter bumps: raw `SET col = col + 1` (avoids read-modify-write).
