# 🌊 Nalu

**Learn anything. AI-powered. Structured.**

Nalu is an AI-powered learning platform that generates personalised, conversational courses on any topic. Pick a subject, get assessed, and learn through dialogue with an adaptive tutor that tracks your progress, schedules spaced review, and awards XP as you grow.

Think Duolingo, but for anything.

## How It Works

1. **Choose a topic** — "Python programming", "South African wines", "music theory", anything.
2. **Scope it** — Nalu asks a few clarifying questions to tailor the curriculum.
3. **Get assessed** — A baseline quiz determines what you already know.
4. **Learn through conversation** — Nalu teaches, asks questions, surfaces blindspots, and adapts to your direction.
5. **Build knowledge** — Spaced repetition brings back concepts at the right time. XP tracks your progress across proficiency tiers.

## Tech Stack

- **Framework**: Next.js 16.2 (App Router, Turbopack)
- **Language**: TypeScript (strict mode)
- **API**: tRPC v11
- **Database**: Supabase (PostgreSQL) via Drizzle ORM
- **Auth**: Supabase anonymous auth (production)
- **LLM**: Vercel AI SDK v6 over an OpenAI-compatible API (provider-swappable). Default: Cerebras `gpt-oss-120b`.
- **Styling**: Tailwind CSS v4
- **Testing**: Vitest (unit, integration against a Postgres testcontainer, opt-in live smoke)
- **Task runner**: [just](https://github.com/casey/just)
- **Package manager**: [Bun](https://bun.sh)

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) 1.3.11 (pinned in `.bun-version`)
- [just](https://github.com/casey/just) (`brew install just`)
- Cerebras API key (free tier) or any OpenAI-compatible provider
- Docker, for the dev database and the integration tests
- Supabase account (free tier), for production only. Dev runs without it.

### Setup

```bash
git clone <repo-url>
cd nalu
bun install

# Environment: dev values only
cp .env.local.example .env.local
# Fill in your LLM provider key

# Dev database: Postgres in Docker on 127.0.0.1:54322
just db-up        # start (or reuse) the nalu-dev-db container
just db-migrate   # apply src/db/migrations/
just db-seed      # insert the dev user
```

`just db-down` stops the container and keeps its data. `just db-reset` wipes
and rebuilds the dev database. Production migrations run through
`just db-migrate-prod`; see `docs/DEPLOY.md`.

### Run

```bash
just dev        # Start dev server (localhost:3000)
```

`just dev` runs with `NODE_ENV=development`, which stubs auth. The client sends an `x-dev-user-id` header (`NEXT_PUBLIC_DEV_USER_ID`), and the server trusts it (`src/server/requestUser.ts`). Production signs each visitor in as a Supabase anonymous user instead (`src/proxy.ts`). See `docs/DEPLOY.md`.

## Development

```bash
just dev        # Start dev server
just test       # Run unit tests
just test-watch # Run tests in watch mode
just test-int   # Run integration tests (needs Docker)
just lint       # Lint
just typecheck  # Type check
just check      # Run all checks; mirrors CI (format + lint + typecheck + unit + integration + dead code)
just build      # Production build
```

`just --list` shows every recipe.

## Project Structure

```
src/
  app/              # Next.js pages and routes
  server/routers/   # tRPC API layer
  lib/
    llm/            # LLM client (provider-agnostic)
    prompts/        # All prompt templates (single source of truth)
    spaced-repetition/  # SM-2 algorithm and review scheduling
    scoring/        # XP calculation and tier advancement
    course/         # Scoping and Wave flows, one LLM-backed operation per file
    turn/           # Per-turn runner: load Context, call LLM, validate, persist
    agents/         # Tool-loop agent for streamed mid-Wave turns
    config/         # Tunables (tuning.ts)
    types/          # Shared TypeScript types
  components/       # React UI (thin rendering layer)
  db/schema/        # Drizzle schema, one file per table
  db/queries/       # Typed database access
docs/
  PRD.md            # Full product requirements document
```

Tests sit beside their source (`foo.test.ts`, `foo.integration.test.ts`).

Architecture rule: all business logic lives in `src/lib/`. Components render. Routers are tRPC transport. See `AGENTS.md` for the full set of conventions.

## Design

Visual identity inspired by Hokusai's Great Wave off Kanagawa. Glassmorphic UI with a clean, modern feel. Learning blocks are called "waves." XP shows as a badge in the chat header; a wave-shaped XP bar is planned (`docs/PRD.md`).

## Licence

<!-- TODO: Choose licence -->

## Contributing

This is currently a solo project in early MVP. If you're interested in contributing, open an issue to discuss.
