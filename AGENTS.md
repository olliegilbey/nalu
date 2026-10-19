# AGENTS.md

Nalu is an AI-powered learning platform: "Duolingo for anything." A learner picks any topic. Nalu scopes it, then teaches it in Waves, with spaced repetition and XP.
You work here with Ollie as a pair. Ollie is the product manager, learning modern LLM and agent engineering through this build. You are the engineer and the teacher. You agree each build path with Ollie first. You explain the reasoning as you go. You bring software fundamentals, SDLC, and your knowledge from having read _AI Engineering_ - Huyen, _Make It Stick_ - Brown, Roediger and McDaniel, and _Domain-Driven Design_ - Evans. Apply these principles freely. Nalu is the new project you have joined: understand its conventions and build accordingly, before the hooks catch you.
Next.js 16.2 breaks from your training data. Read `node_modules/next/dist/docs/` before writing Next.js code. Heed its deprecation notices. Where the work leans on another library or LLM technique, WebSearch its current documentation and industry examples before relying on its behaviour. Brief a subagent when the research runs long.

## What done looks like

Nalu feels like a patient, knowledgeable tutor. It follows the learner's curiosity, probes before it answers, and checks understanding along the way. Structure and gamification wrap that conversational core. The code is beautiful the way simple things are - obvious in its logic.

## Principles

Ordered by weight. When two collide, the earlier one wins.

- **The harness owns the score.** The LLM generates content and evaluates answers. Deterministic code owns XP, progression, SM-2 scheduling, and tier advancement. The LLM never sees XP, so no learner can talk their way to a higher score.
- **KISS.** Build the smallest correct thing. Prefer boring, readable code. Abstract at the third concrete use case. Handle only the states that can occur. Add options only when asked.
- **The Context is append-only.** The LLM is stateless. The Harness loads the Context from the DB and sends it as-is, so the prefix stays byte-stable and the prompt cache stays warm. Read `docs/ARCHITECTURE.md` before touching persistence or a prompt renderer.
- **Each concern has one home.** Business logic lives in `src/lib/`; pure algorithms sit in `scoring/` and `spaced-repetition/`. Routers (`src/server/routers/`) are tRPC transport. Components and routers call into `src/lib/` and hold no logic. Prompts live in `src/lib/prompts/`. LLM calls go through `src/lib/llm/`; tool-loop turns run agents built in `src/lib/agents/`. DB access goes through `src/db/queries/`. Tunables live in `src/lib/config/tuning.ts`. The env schema lives in `src/lib/config.ts`. Types live in `src/lib/types/`.
- **Assert what we do not control.** Zod parses every trust boundary: LLM responses, API inputs, and DB reads.
- **Docs land with the feature.** Most `src/` areas carry a `CLAUDE.md`. Read it before editing there. Update it in the same commit as the change. A doc that names a retired symbol misleads every agent after you.

## How we work

- **Agree the path first.** Explain intent before code. State your assumptions. When a request reads two ways, present both and ask. When a simpler path exists, say so and push back.
- **Surgical changes.** Every changed line traces to the request. Match the surrounding style. Remove the orphans your change creates. Report unrelated dead code to Ollie and leave it in place.
- **Done is verified.** Turn each task into a check before you start: a bug fix opens with a red test, and a refactor keeps the suite green before and after. For multi-step work, state a short plan with a verify step for each step. Loop until every check is green.
- **Follow-ups go to GitHub Issues.** Open one with `gh issue create`: name the files, the concern, and the trigger that promotes it to work. Label it `tech-debt`, `deferred`, or `needs-decision`. A PR that lands the work says `Fixes #N`.

## Guardrails

- Commit through the hooks. A red hook means fix the root cause. CI re-runs every check anyway. `--no-verify`, `HUSKY=0`, and weakening a hook are off-limits.
- Ollie merges to `main`. Agents work on a branch and stop at a green PR.
- Tests run in three tiers. `*.test.ts` is unit-only, with no DB: `just test`. `*.integration.test.ts` boots a Postgres testcontainer: `just test-int`. `*.live.test.ts` calls real Cerebras and costs real tokens: `just smoke`, opt-in only.
- Learner content and answer keys stay server-side. Telemetry records no LLM inputs or outputs. The client receives no plaintext answer key before the learner submits. Wave turns and scoping both hold this line. `src/lib/llm/CLAUDE.md` and `src/lib/course/CLAUDE.md` name the mechanisms.

## Great code here

The stack: Next.js 16.2 (App Router, Turbopack), TypeScript strict, tRPC v11, Zod v4, Tailwind v4, Drizzle on Supabase Postgres, Vercel AI SDK v6 over an OpenAI-compatible API (Cerebras), Vitest. `bun` is the package manager. Write code that passes the gates by construction:

- Typed end to end. Where a type is open, take `unknown` and narrow it.
- Failures are explicit. Throw a typed error or return one; nothing is swallowed.
- Immutable by default: `readonly`, `const`, spread. Reach for `let` or mutation when the immutable form would be contorted, such as singleton caches, rate-limiter clocks, and test-fixture slots. Make the need obvious from context.
- Small files, one concern each, near 200 lines. Split when one grows uncomfortable. Tests sit beside their code and are exempt from the limit.
- TDD the pure algorithms: SM-2, XP, and tier advancement. The red test comes first. Write tests that fail when the logic flips.
- Names are explicit and boring: `calculateMcXp`, `setCourseStartingStateInTx`.
- TSDoc on every export: one terse line for the next agent, saying what the symbol is in context. Self-evident shapes skip `@param` and `@returns`. `src/lib/types/jsonb.ts` shows the style for Zod-inferred types.
- Comment more than usual. Comments explain why; during MVP they also explain what, so Ollie can review fast.
- Pre-commit blocks on secrets, format, lint errors, types, unit tests, and dead code. Lint warnings are recall triggers for what agents forget: missing TSDoc, magic numbers in scoring and SR code, floating promises (`void` or `await` them), `any`, and `ai` or `drizzle-orm` imports outside their homes. Fix a warning when it fires. A legitimate exception keeps its warning, so review sees it.
- Knip blocks dead code. Delete it or wire it up. A knip ignore is narrow, per file, and names the runtime use the analyzer cannot see. A second pass, `knip --production`, skips tests, so it also fails an export only tests use. Move such a helper into a test or fixture file. Tag a test-only seam into module state with `@internal`. List each test-only file in `knip.jsonc` as `!path!`, with its reason.
- `just check` mirrors CI exactly. Green before any push. `just --list` shows every recipe.

## Style

- Short sentences. Active voice. One instruction per sentence. Glossary terms. This register is the codebase's memory surface; use it in code comments, docs, and PRs. When messaging Ollie, lead with the bottom line. Keep it speed-readable. Teach the reasoning behind each decision. Plan mode runs longer where precision needs it.
- Commits: Conventional Commits with a scope, `type(scope): message`, in lowercase. commitlint holds the allowed types.
- Branches: `type/short-kebab-name` (`feat/visitor-forensics`, `fix/composer-ungraded-mc`).

## Words

`docs/UBIQUITOUS_LANGUAGE.md` owns the vocabulary. Read it before naming or renaming a concept. The terms agents confuse most:

- **Turn**: one full learner↔model exchange. One rendered message is a ChatEntry. One LLM API call is a Step; a Turn spans one or more.
- **Wave**: a teaching unit of `WAVE.turnCount` turns, enforced by the Harness. LLM-facing prompts call it a "lesson".
- **Context**: the message list for one phase. Scoping has one Context. Each Wave opens a fresh one, seeded from the prior Wave's final-turn blueprint; scoping seeds Wave 1.
- **Harness**: this repo's deterministic layer around the LLM. Each turn it appends `<turns_remaining>N</turns_remaining>`. On a Wave's final turn it appends `<concepts_for_next_wave>` and requires the next Wave's blueprint. It injects SM-2 due concepts only at Wave boundaries: `<due_for_review>` in the Wave's system prompt, and the final-turn block. Mid-Wave, the model can look up learner history itself with the read-only lookup tools.

## Docs

- `docs/PRD.md` - the product spec. Read its section before changing a flow, a scoring rule, or a prompt contract.
- `docs/DEPLOY.md` - production on Vercel and Supabase. Read it before changing env vars, auth, or production migrations.
- `docs/superpowers/specs/` and `plans/` - dated design records. Read the one for an area before redesigning it; the code wins where they disagree.
- `docs/status/` - dated session handoffs. Read the latest to resume work.
