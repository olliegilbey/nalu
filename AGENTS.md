# This is NOT the Next.js you know

Next.js 16.2 has breaking changes vs your training data — APIs, conventions, and file structure may differ. Read `node_modules/next/dist/docs/` before writing Next.js code. Heed deprecation notices.

# Nalu

AI-powered learning platform. "Duolingo for anything." Spec: `docs/PRD.md`. Glossary: `docs/UBIQUITOUS_LANGUAGE.md`.

## Nomenclature

- **LLM** is stateless. Harness loads the current **Context** (append-only message list) from DB and sends as-is — never rebuilt from components per turn.
- **Router** (`src/server/routers/`) = tRPC transport. **Step** (`src/lib/course/*.ts`) = per-turn heuristic. Pure algorithms live in `src/lib/{scoring,spaced-repetition,progression}/`.
- **Wave** = fixed-length teaching unit (`WAVE_TURN_COUNT` turns, default 10). Harness-enforced, not model-decided. Called a "lesson" in LLM-facing prompts.

## Turn principle

User → Router → LLM → Router → User. Scoping = one Context. Teaching = one Context per Wave. Each turn the Harness appends `<turns_remaining>N</turns_remaining>`; on a Wave's final turn it also appends `<due_for_review>…</due_for_review>` and requests the next Wave's blueprint in the same structured response.

## Stack

Next.js 16.2 (App Router, Turbopack), TypeScript strict, tRPC v11, Zod, Tailwind, Supabase (Postgres + Auth), Vitest, Playwright. LLM via OpenAI-compatible API (Cerebras free tier). Uses **bun**, not npm.

## Commands

- `just dev` — dev server
- `just test` / `just test-watch` — vitest
- `just lint` — ESLint
- `just typecheck` — tsc --noEmit
- `just check` — all of the above
- `just build` — production build

## Architecture Boundaries

Each subdirectory has its own `CLAUDE.md` with detail. Top-level rules:

- Business logic → `src/lib/` only. Components and routers contain zero logic.
- Prompts → `src/lib/prompts/` only.
- LLM calls → `src/lib/llm/` only (`provider.ts` + `generate.ts`). No direct `ai` SDK imports elsewhere.
- DB access → `src/db/queries/` only. No raw SQL elsewhere.
- Tunables → `src/lib/config/tuning.ts`. ESLint enforces `no-magic-numbers` in scoring/SR files.
- Types → `src/lib/types/`. Runtime constants → `src/lib/config/`.

## Core Design Principle

LLM generates content and evaluates answers. **Deterministic code** controls XP, progression, SM-2 scheduling, and tier advancement. The LLM never sees XP and cannot influence scoring.

## Code Standards

- TypeScript strict. No `any`. Prefer `readonly`, `const`, spread over mutation.
- Zod at all trust boundaries (LLM responses, API inputs, DB reads).
- TSDoc on every export. Max 200 lines/file. Colocated tests (`foo.test.ts` next to `foo.ts`).
- TDD for pure algorithms (SM-2, XP, tier advancement).
- Naming explicit and boring (`calculateXPForAssessment`, not `calcXP`).
- Comments explain WHY; during MVP also explain WHAT for reviewer speed.
- No premature abstraction until 3 concrete use cases.
- Functional style: `eslint-plugin-functional` enforces `immutable-data` and `no-let`.

## Key Flows

Full detail in `docs/PRD.md`.

1. **Scoping**: topic → clarify → framework → baseline → grade + `startingContext` + starting tier.
2. **Teaching**: sequence of Waves; each seeded from the prior Wave's final-turn blueprint (Wave 1 from scoping). Within a Wave: teach → assess → SM-2 update → XP award.
3. **Spaced repetition**: SM-2 due concepts injected at Wave boundaries only — Wave start (static prompt) and final turn (for next Wave's blueprint). Append-only within a Wave.

## Workflow

1. Pull latest docs of frameworks/packages before writing code.
2. Explain intent before code (brief comment or message).
3. Run tests before committing.
4. **Never bypass git hooks** (no `--no-verify`, no `HUSKY=0`, no hook deletion). Fix the root cause; CI re-runs every check anyway.
5. Be concise in messages; plan mode can be verbose for unambiguity.

- Note any TODOs in TODO.md when they arise for future agents to work on.
- Comment code extensively - more than usual.
