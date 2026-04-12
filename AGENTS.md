<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.

<!-- END:nextjs-agent-rules -->

# Nalu — Agent Guide

AI-powered learning platform. See `docs/PRD.md` for full spec, `CLAUDE.md` for detailed conventions.

## Commands

- `just dev` — dev server
- `just test` — unit tests
- `just lint` — ESLint
- `just typecheck` — tsc --noEmit
- `just check` — all of the above
- Uses **bun**, not npm.

## Critical Rules

- **All business logic in `src/lib/`** — not in components or routers.
- **All prompts in `src/lib/prompts/`** — no prompt text anywhere else.
- **All LLM calls through `src/lib/llm/client.ts`** — no direct provider API calls.
- **All DB access through `src/db/queries/`** — no raw SQL elsewhere.
- TypeScript strict. No `any`. Zod at all trust boundaries.
- Max 200 lines per file. Colocated tests (`foo.test.ts` next to `foo.ts`).
- The LLM generates content. **Deterministic code** controls XP, progression, and scoring.
- **Never bypass git hooks.** No `--no-verify`, no `HUSKY=0`, no hook deletion. If a hook fails, fix the root cause. CI re-runs every check and will reject the PR anyway.
- **All algorithm tunables in `src/lib/config/tuning.ts`.** Scoring and spaced-repetition files enforce `no-magic-numbers` via ESLint.
