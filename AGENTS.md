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
- Tunables → `src/lib/config/tuning.ts`. No magic numbers in scoring/SR/progression code.
- Types → `src/lib/types/`. Runtime constants → `src/lib/config/`.

## Core Design Principle

LLM generates content and evaluates answers. **Deterministic code** controls XP, progression, SM-2 scheduling, and tier advancement. The LLM never sees XP and cannot influence scoring.

## Conventions

You are expected to follow the conventions below. Optimise for what these are protecting against.

Automated gates are intentionally thin. Pre-commit and CI block only on things that are silent, expensive, or compounding if missed: secrets, broken types, broken tests, stray `console.log`, committed `.only`, format drift, and dead code (knip). Everything else below is convention — agents are expected to follow it, but it's not gate-kept by tooling. Don't optimize for lint compliance; optimize for what these are protecting against.

If knip flags an export as dead, fix it (delete or wire up) — don't blanket-ignore in `knip.json`. Narrow per-file justifications are fine when an export is genuinely used at runtime in a way the static analyzer can't see.

- TypeScript strict. No `any`. Prefer `readonly`, `const`, spread over mutation. `let` is fine when there's no clean alternative (singleton caches, rate-limiter clocks, test-fixture slots) — make the necessity obvious from context, not via lint-disables.
- Functional style by default: prefer immutable patterns. Reach for `let`/mutation when the alternative would be contorted, not as a default.
- Zod at all trust boundaries (LLM responses, API inputs, DB reads).
- TSDoc on every export. One line, terse, agent-targeted. Skim `src/lib/llm/tagVocabulary.ts` for the Zod-inferred-type style. No filler, no `@param`/`@returns` on self-evident shapes. The docs exist so the next agent knows what a symbol is _in context_ without reading the body.
- Aim for ~200 lines/file. Split when it gets uncomfortable. Tests exempt.
- Colocated tests (`foo.test.ts` next to `foo.ts`).
- TDD for pure algorithms (SM-2, XP, tier advancement). Pre-commit runs the full unit suite; CI re-runs unit + integration. A red test blocks the commit, intentionally.
- Naming explicit and boring (`calculateXPForAssessment`, not `calcXP`).
- Comments explain WHY; during MVP also explain WHAT for reviewer speed.
- No premature abstraction until 3 concrete use cases.

## Key Flows

Full detail in `docs/PRD.md`.

1. **Scoping**: topic → clarify → framework → baseline → grade + `startingContext` + starting tier.
2. **Teaching**: sequence of Waves; each seeded from the prior Wave's final-turn blueprint (Wave 1 from scoping). Within a Wave: teach → assess → SM-2 update → XP award.
3. **Spaced repetition**: SM-2 due concepts injected at Wave boundaries only — Wave start (static prompt) and final turn (for next Wave's blueprint). Append-only within a Wave.

## Workflow

1. Pull latest docs of frameworks/packages before writing code. The things we are building are often not in your training data, so you need to defer to the docs.
2. Explain intent before code (brief comment or message).
3. Run tests before committing.
4. **Never bypass git hooks** (no `--no-verify`, no `HUSKY=0`, no hook deletion). Fix the root cause; CI re-runs every check anyway.
5. Be concise in messages; plan mode can be verbose for unambiguity.

- Note any TODOs in TODO.md when they arise for future agents to work on.
- Use TDD frequently when appropriate
- Comment code extensively - more than usual.
- As an AI model, your training data likely doesn't contain extensive AI platform development - use web search extensively to discover best practices where appropriate, and where understanding the status quo and modern techniques is helpful.
- RTFM
- Read the docs for anything that could contain helpful information or examples.
