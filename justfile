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

# Run unit tests
test:
    bun run test

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

# Run all checks (format + lint + typecheck + test + deadcode).
# Matches CI; green locally means green on PR.
check: format-check lint typecheck test deadcode

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
