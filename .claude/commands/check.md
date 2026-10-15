Run all validation checks before committing:

1. `just format-check` — Prettier finds no drift (fix with `just format`)
2. `just lint` — ESLint passes
3. `just typecheck` — TypeScript compiles with no errors
4. `just test` — All unit tests pass
5. `just test-int` — All integration tests pass (boots a Postgres testcontainer; Docker must be running)
6. `just deadcode` — Knip finds no dead code, with tests and without them (`knip --production`)

`just check` runs all six in this order and mirrors CI (`.github/workflows/ci.yml`). It stops at the first failure.

Report results. If anything fails, diagnose and fix before proceeding.
