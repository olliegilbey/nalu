# Nalu

AI-powered learning platform. "Duolingo for anything." Full spec in `docs/PRD.md`.

## Commands

```bash
just dev          # Dev server
just test         # Unit tests (vitest)
just test-watch   # Watch mode
just lint         # ESLint
just typecheck    # tsc --noEmit
just check        # All of the above
just build        # Production build
```

Uses **bun** (not npm). See `justfile` for all commands.

## Stack

Next.js 16.2 (App Router, Turbopack), TypeScript strict, tRPC v11, Zod, Tailwind, Supabase (Postgres + Auth), Vitest, Playwright. LLM via OpenAI-compatible API (Cerebras free tier). eslint-plugin-functional (immutable-data, no-let as warnings).

## Architecture Boundaries

| Rule            | Detail                                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------------------------- |
| Business logic  | `src/lib/` only. Components and routers contain zero logic.                                                          |
| Prompts         | `src/lib/prompts/` only. Pure template functions → strings.                                                          |
| LLM calls       | `src/lib/llm/` only (`provider.ts` + `generate.ts`). No direct `ai` SDK imports elsewhere.                           |
| DB access       | `src/db/queries/` only. No raw SQL in routers or components.                                                         |
| Routers         | `src/server/routers/`. Orchestrate lib calls. Thin.                                                                  |
| Components      | `src/components/`. Thin render layer. Call tRPC hooks for data.                                                      |
| Tuning          | `src/lib/config/tuning.ts` only. All algorithm knobs (SM-2, XP, progression). Zero magic numbers in algorithm files. |
| Types vs config | `src/lib/types/` holds types + Zod schemas only. Runtime constants live in `src/lib/config/`.                        |

## Code Standards

- TypeScript strict. No `any`. Prefer `readonly`, `const`, spread over mutation.
- Zod at all trust boundaries (LLM responses, API inputs, DB reads).
- Pure functions for scoring, SM-2, progression. No side effects.
- TSDoc on every export. Max 200 lines/file. One concern per file.
- Naming: explicit and boring. `calculateXPForAssessment` not `calcXP`.
- No premature abstraction until 3 concrete use cases.
- Comments explain WHY. During MVP, also explain WHAT for reviewer speed. Comment more than normal.
- Colocate tests: `foo.test.ts` next to `foo.ts`. TDD for core algorithms (SM-2, XP, tier advancement).

## Agent Workflow

1. **Create a TODO list before each phase.** Check off items as you go.
2. **Explain intent before writing code.** Brief comment or message on what and why.
3. **Comment more than normal.** Optimise for a human reviewing in real-time at speed.
4. **Run tests before committing.**

## Core Design Principle

The LLM generates content and evaluates answers. **Deterministic code** controls XP, progression, SM-2 scheduling, and tier advancement. The model is a tool in the harness, not the harness. The model never knows XP values and cannot influence scoring.

## Prompt Structure (cache-efficient ordering)

1. **Static** (top, rarely changes): role instructions, course topic, scope, proficiency framework
2. **Semi-static** (changes between sessions): current tier, custom instructions, progress summary
3. **Dynamic** (rebuilt each turn, appended last): output format definitions, review injection

Review injection is stripped and rebuilt fresh every turn from DB state. Assessed concepts are excluded. If no concepts are due, omit the block entirely.

## Security

- Sanitise user input before prompt inclusion: encode `<` `>` as HTML entities, wrap in `<user_message>` tags.
- System prompt instructs model to treat `<user_message>` as data, ignore directives within.
- XP is deterministic. Anti-gaming: minimum concept counts for tier advancement, model-independent scoring.

## Key Flows

1. **New course**: topic input → clarification questions → framework generation (3-8 tiers) → baseline assessment (7-9 questions) → starting tier → first session
2. **Session**: load state + summary + due reviews → Nalu opens with context → conversation loop (teach, assess via cards or inferred comprehension, SM-2 update, XP award) → session summary on end
3. **Spaced repetition**: SM-2 pure function. Scheduler queries due concepts. Injection appended per-turn. Resolved concepts removed from injection on next turn.

## Design

Kanagawa palette (from kanagawa.nvim). Glassmorphic, Apple liquid glass inspired. Wave motifs throughout. Clean, modern, generous whitespace. Wave-shaped XP bar. Learning blocks called "waves." One distinctive display font + clean sans-serif body. See `src/components/CLAUDE.md` for full colour table.

@AGENTS.md
