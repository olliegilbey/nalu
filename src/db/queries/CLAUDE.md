# src/db/queries

Only place SQL or Supabase client calls exist in the codebase.

- One file per domain: `courses.ts`, `concepts.ts`, `sessions.ts`, `assessments.ts`, `users.ts`
- Typed params in, Zod-validated readonly results out
- Parameterised queries only. Never interpolate user input into SQL.
