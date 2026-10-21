# Nalu development commands

# Auto-load .env.local for every recipe so drizzle-kit / seed scripts /
# any other recipe that reads process.env sees the same values the
# Next.js app does. Required because drizzle.config.ts reads DIRECT_URL
# from process.env, and seed.ts validates the full env schema via getEnv().
set dotenv-filename := ".env.local"

# `.env.local` holds plain values loaded via `set dotenv-filename` above
# (no `op://` refs), so no `op`/1Password is needed here.
# Start the dev server.
dev:
    bun run dev

# Start the dev server with AI SDK DevTools capture (dev-only middleware).
dev-devtools:
    LLM_DEVTOOLS=1 bun run dev

# AI SDK DevTools viewer (http://localhost:4983) — inspects .devtools/ runs.
llm-devtools:
    bun x @ai-sdk/devtools

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
# level. Env (incl. LLM_API_KEY) loads from `.env.local` via the `set
# dotenv-filename` above — `.env.local` holds plain values, so this runs
# fully unattended with no `op`/1Password prompt.
#
# Runs against whatever `LLM_MODEL` is set in `.env.local` (current default:
# gpt-oss-120b). No mid-test model swaps.
smoke:
    CEREBRAS_LIVE=1 bun run test:live

# One-shot probe for a Cerebras model. Overrides LLM_MODEL so the
# `.env.local` default isn't used; LLM_API_KEY and the rest load from
# `.env.local` via `set dotenv-filename` above. See scripts/probe-model.ts.
probe-model model *args:
    env LLM_MODEL="{{model}}" bun scripts/probe-model.ts {{args}}

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

# Find unused exports, deps, files. The --production pass skips tests, so it
# also fails on an export that only tests use.
deadcode:
    bun x knip
    bun x knip --production

# Run all checks (format + lint + typecheck + unit + integration + deadcode).
# Matches CI; green locally means green on PR.
check: format-check lint typecheck test test-int deadcode

# Start production server
start:
    bun run start

# === DB ===

# The dev database is a postgres:16-alpine container (the integration-test
# image) named nalu-dev-db, with user and database `postgres` and no
# password: postgresql://postgres@127.0.0.1:54322/postgres, as
# `.env.local.example` expects. Trust auth is safe here: the port is
# published on loopback only, and the data is throwaway. The nalu-dev-db
# volume keeps data across restarts. A rerun is a no-op: `docker start` on a
# running container does nothing. Plain Postgres is enough: `just dev` auth is
# the `x-dev-user-id` stub (src/server/requestUser.ts), and the migrations use
# no Supabase objects.
# Start (or reuse) the dev database on 127.0.0.1:54322.
db-up:
    #!/usr/bin/env bash
    set -euo pipefail
    if docker container inspect nalu-dev-db >/dev/null 2>&1; then
      docker start nalu-dev-db >/dev/null
    else
      docker run --detach --name nalu-dev-db \
        --publish 127.0.0.1:54322:5432 \
        --env POSTGRES_HOST_AUTH_METHOD=trust \
        --volume nalu-dev-db:/var/lib/postgresql/data \
        postgres:16-alpine >/dev/null
    fi
    # Probe over TCP: the first-boot init server listens on a Unix socket
    # only, so a TCP answer means the real server is up.
    for _ in $(seq 30); do
      if docker exec nalu-dev-db pg_isready --quiet --host 127.0.0.1 --username postgres; then
        echo "nalu-dev-db ready on 127.0.0.1:54322"
        exit 0
      fi
      sleep 1
    done
    echo "nalu-dev-db did not accept connections within 30s; see: docker logs nalu-dev-db" >&2
    exit 1

# Keeps the nalu-dev-db volume. `docker volume rm nalu-dev-db` deletes it.
# Stop the dev database; `just db-up` brings it back with its data.
db-down:
    docker stop nalu-dev-db

# Generate a new migration from schema TS changes
db-generate name:
    bunx drizzle-kit generate --name {{name}}

# The gate refuses unless every DIRECT_URL host is this machine, so
# `just db-migrate-prod` is the only path to a remote database.
# Apply pending migrations to the dev database (DIRECT_URL in `.env.local`).
db-migrate:
    bun src/db/assertLocalDirectUrl.ts
    bunx drizzle-kit migrate

# Production URLs live in the gitignored `.env.production.local`, never in
# `.env.local` (docs/DEPLOY.md). `unset` drops the dev URLs that
# `set dotenv-filename` exported, because an exported var beats
# `bun --env-file`. `--env-file` also stops bun from auto-loading
# `.env.local`. The guard refuses a missing or loopback DIRECT_URL, so this
# never migrates the dev database. `bun run`, not `bunx`: `bunx` drops the
# `--env-file` values, and drizzle-kit then sees no URL.
# Apply pending migrations to production, from `.env.production.local`.
db-migrate-prod:
    #!/usr/bin/env bash
    set -euo pipefail
    unset DATABASE_URL DIRECT_URL
    bun --env-file=.env.production.local src/db/assertRemoteDirectUrl.ts
    bun --env-file=.env.production.local run drizzle-kit migrate

# Wipe the local DB, then re-migrate and re-seed. src/db/reset.ts drops the
# app schemas at DIRECT_URL, and refuses unless every host is this machine:
# an exported DIRECT_URL or a stale `.env.local` can still name production.
db-reset:
    bun src/db/reset.ts
    just db-migrate
    just db-seed

# The gate refuses unless every DIRECT_URL host is this machine.
# Insert dev user idempotently
db-seed:
    bun src/db/assertLocalDirectUrl.ts
    bun src/db/seed.ts

# The XP repair (issue #208) sets courses.total_xp from its source rows. A dry
# run by default: it prints counts and writes nothing. Pass --apply to write.
# It connects through DIRECT_URL. The gate refuses unless every DIRECT_URL
# host is this machine, so `just recompute-course-xp-prod` is the only path to
# a remote database.
# Repair course XP totals on the dev database (DIRECT_URL in `.env.local`).
recompute-course-xp *args:
    bun src/db/assertLocalDirectUrl.ts
    bun scripts/recompute-course-total-xp.ts {{args}}

# Same env handling as `db-migrate-prod`: `unset` drops the dev URLs, and
# `--env-file` loads `.env.production.local` only. The guard refuses a missing
# or loopback DIRECT_URL, and the script connects through that same URL. The
# repair keeps no undo record: take a backup before `--apply`.
# Repair course XP totals on production, from `.env.production.local`.
recompute-course-xp-prod *args:
    #!/usr/bin/env bash
    set -euo pipefail
    unset DATABASE_URL DIRECT_URL
    bun --env-file=.env.production.local src/db/assertRemoteDirectUrl.ts
    bun --env-file=.env.production.local scripts/recompute-course-total-xp.ts {{args}}

# drizzle-kit history check: fails on an inconsistent migration chain. It does
# not diff schema TS against the migrations, so it misses an ungenerated change.
# `just test` catches that: see src/db/schemaMigrationDrift.test.ts.
db-check:
    bunx drizzle-kit check
