# Nalu development commands

# Auto-load .env.local for every recipe so drizzle-kit / seed scripts /
# any other recipe that reads process.env sees the same values the
# Next.js app does. Required because drizzle.config.ts and seed.ts
# read DIRECT_URL / DEV_USER_ID directly from process.env.
set dotenv-filename := ".env.local"

# Start dev server
dev:
    bun run dev

# Production build
build:
    bun run build

# Unit tests (fast; no DB)
test:
    bun run test

# Integration tests (boots Postgres testcontainer; slower)
test-int:
    bun run test:integration

# Live Cerebras smoke test — opt-in only. Calls real Cerebras + real Postgres.
# Never runs in `just check` or CI. Gated by CEREBRAS_LIVE=1 at the describe
# level; LLM_API_KEY is resolved from 1Password via `op run` so the secret
# never lands on disk. `.env.local` holds an `op://` reference, not the key
# itself. Requires `op signin` once per shell.
#
# Default model is llama3.1-8b (.env.local). `submitBaseline.live.test.ts`
# swaps to qwen-3-235b-a22b-instruct-2507 mid-test for the close-scoping turn
# only — llama's 8192-token ceiling overflows on that single turn after the
# prior three are appended. See the test's HACK comment for details.
smoke:
    CEREBRAS_LIVE=1 op run --account my.1password.com --env-file=.env.local -- bun run test:live

# Run unit tests in watch mode
test-watch:
    bun run test:watch

# Lint
lint:
    bun run lint

# Type check without emitting
typecheck:
    bunx tsc --noEmit

# Format all files with Prettier
format:
    bun x prettier --write .

# Check formatting without writing
format-check:
    bun x prettier --check .

# Find unused exports, deps, files
deadcode:
    bun x knip

# Run all checks (format + lint + typecheck + unit + integration + deadcode).
# Matches CI; green locally means green on PR.
check: format-check lint typecheck test test-int deadcode

# Start production server
start:
    bun run start

# === DB ===

# Generate a new migration from schema TS changes
db-generate name:
    bunx drizzle-kit generate --name {{name}}

# Apply pending migrations (uses DIRECT_URL)
db-migrate:
    bunx drizzle-kit migrate

# Drop and re-create local Supabase DB, then re-migrate and re-seed
db-reset:
    supabase db reset
    just db-migrate
    just db-seed

# Insert dev user idempotently
db-seed:
    bun src/db/seed.ts

# drizzle-kit drift check — fails if schema TS and migrations are out of sync
db-check:
    bunx drizzle-kit check
