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
- **Database**: Supabase (PostgreSQL)
- **LLM**: OpenAI-compatible API (provider-swappable)
- **Styling**: Tailwind CSS
- **Testing**: Vitest + Playwright
- **Task runner**: [just](https://github.com/casey/just)
- **Package manager**: [Bun](https://bun.sh)

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) >= 1.0
- [just](https://github.com/casey/just) (`brew install just`)
- Supabase account (free tier)
- Cerebras API key (free tier) or any OpenAI-compatible provider

### Setup

```bash
git clone <repo-url>
cd nalu
bun install

# Environment
cp .env.local.example .env.local
# Fill in your Supabase and LLM provider credentials
```

### Run

```bash
just dev        # Start dev server (localhost:3000)
```

Dev mode (`NEXT_PUBLIC_DEV_MODE=true` in `.env.local`) enables auto-login and skips auth for rapid testing.

## Development

```bash
just dev        # Start dev server
just test       # Run unit tests
just test-watch # Run tests in watch mode
just lint       # Lint
just typecheck  # Type check
just check      # Run all checks (lint + typecheck + test)
just build      # Production build
```

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
    course/         # Course state management
    types/          # Shared TypeScript types
  components/       # React UI (thin rendering layer)
  db/queries/       # Typed database access
tests/
  e2e/              # Playwright end-to-end tests
  fixtures/         # Mock LLM responses
docs/
  PRD.md            # Full product requirements document
```

Architecture rule: all business logic lives in `src/lib/`. Components render. Routers orchestrate. See `CLAUDE.md` for the full set of conventions.

## Design

Visual identity inspired by Hokusai's Great Wave off Kanagawa. Glassmorphic UI with a clean, modern feel. Learning blocks are called "waves." The XP progress bar is wave-shaped.

## Licence

<!-- TODO: Choose licence -->

## Contributing

This is currently a solo project in early MVP. If you're interested in contributing, open an issue to discuss.
