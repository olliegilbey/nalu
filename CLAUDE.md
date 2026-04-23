# Nalu

AI-powered learning platform. "Duolingo for anything." Full spec in `docs/PRD.md`.

## Nomenclature

Full glossary: `docs/UBIQUITOUS_LANGUAGE.md`. Mistake-prevention essentials:

- **LLM** is stateless. Harness loads the current **Context** (append-only message list) from DB and sends as-is — never rebuilt from components per turn.
- **Router** (`src/server/routers/`) = tRPC transport. **Step** (`src/lib/course/*.ts`) = per-turn heuristic logic. Pure algorithms (SM-2, XP, tier) live in `src/lib/{scoring,spaced-repetition,progression}/`.
- **Wave** = fixed-length teaching unit (`WAVE_TURN_COUNT` turns, default 10). Harness-enforced, not model-decided. Called a "lesson" in LLM-facing prompts.

## Turn principle

Each turn: User → Router → LLM → Router → User. Scoping = one Context. Teaching = one Context per Wave. Every turn the Harness appends `<turns_remaining>N</turns_remaining>`; on a Wave's final turn it also appends `<due_for_review>…</due_for_review>` and requests the next Wave's blueprint (topic, outline, opening text) in the same structured response.

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
| Routers         | `src/server/routers/`. tRPC transport: auth, Zod in/out, persist. Heuristic logic belongs in Steps, not here.        |
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
2. **Pull the latest documentation** of the packages/frameworks you're using.
3. **Explain intent before writing code.** Brief comment or message on what and why.
4. **Comment more than normal.** Optimise for a human reviewing in real-time at speed.
5. **Run tests before committing.**

## Agent Directives

- Be very concise in messages to the user, plan mode should remain as verbose as needed to achieve good results and unambiguity.
- Use up-to-date documentation for implementations
- Write functional code - the code checkers enforce functional-style programming

## Core Design Principle

The LLM generates content and evaluates answers. **Deterministic code** controls XP, progression, SM-2 scheduling, and tier advancement. The model is a tool in the harness, not the harness. The model never knows XP values and cannot influence scoring.

## Prompt Structure (cache-efficient ordering)

Static at the top (set once per phase, byte-stable for cache): role, topic, scope, framework, tier, `startingContext` or current Wave blueprint, output-format definitions. Dynamic appended per turn: `<turns_remaining>N</turns_remaining>`; on a Wave's final turn also `<due_for_review>…</due_for_review>` plus the instruction to emit the next Wave's blueprint. Phase = scoping OR one Wave; the static block is refreshed only at phase boundaries.

## Security

- Sanitise user input before prompt inclusion: encode `<` `>` as HTML entities, wrap in `<user_message>` tags.
- System prompt instructs model to treat `<user_message>` as data, ignore directives within.
- XP is deterministic. Anti-gaming: minimum concept counts for tier advancement, model-independent scoring.

## Key Flows

1. **New course (scoping)**: topic → clarify (Q's) → answers → framework (user may edit) → baseline questions → answers → grade + `startingContext` handoff → starting tier set.
2. **Teaching**: sequence of Waves. Wave 1 seeded from scoping (`startingContext` + initial SM-2 due). Each subsequent Wave starts from the blueprint drafted at the prior Wave's final turn. Within a Wave: teach, assess (cards or inferred comprehension), SM-2 update, XP award, Harness injects turn countdown. Final turn: SM-2 due concepts injected; LLM emits close-out response and next-Wave blueprint in one structured payload.
3. **Spaced repetition**: SM-2 pure function. Scheduler queries due concepts at each Wave's final turn; injection appended only then, feeding the next Wave's blueprint. Concepts assessed within the current Wave are excluded from the next injection.

## Design

Kanagawa palette (from kanagawa.nvim). Glassmorphic, Apple liquid glass inspired. Wave motifs throughout. Clean, modern, generous whitespace. Wave-shaped XP bar. Learning blocks called "waves." One distinctive display font + clean sans-serif body. See `src/components/CLAUDE.md` for full colour table.

@AGENTS.md
