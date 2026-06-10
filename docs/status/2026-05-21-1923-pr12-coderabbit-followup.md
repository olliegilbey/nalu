# PR #12 finalize — CodeRabbit follow-up (2 remaining threads)

## Task Overview

PR **#12** (`feat/teaching-loop` → `main`) — the AI wave teaching loop — is **open, mergeable, CI green**. This session ran `/review-pr` (triaged the big stale CodeRabbit review) and did the logo refresh — **both DONE**.

**One piece of work remains:** CodeRabbit has **2 unresolved review threads** that were never triaged (they post-date the review this session handled). The next session should `/review-pr` them.

Success criteria: triage both threads against current code, fix the valid one, push back on the invalid one with reasoning, reply in-thread + resolve. Use `superpowers:subagent-driven-development` (the user's standard workflow) if a fix is needed.

## Reference Docs

- `@docs/status/2026-05-21-1759-pr12-coderabbit-logo.md` — full context on the prior session (the 14 commits, the stale-review setup). Read only if you need the deeper history.
- `eslint.config.mjs` **lines 58-62** — test files (`**/*.test.{ts,tsx}`) have `"max-lines": "off"`. This is the decisive fact for Thread 1 below.
- `AGENTS.md` / `CLAUDE.md` / `KARPATHY.md` — project + agent guides. Subdir `CLAUDE.md` files auto-load.
- PR: https://github.com/olliegilbey/nalu/pull/12

## Current State

- Branch `feat/teaching-loop`, HEAD **`22b5696`**, all 5 of this session's commits pushed to origin.
- **5 commits added this session** (`3ac162e..22b5696`):
  - `d1cb39a` chore: MD040 doc fences, scheduler CLAUDE.md guideline fix, 2 race TODOs, TSDoc, `.toSorted()`
  - `af4a883` fix(prompts): reject unknown questionIds + close-turn schema hardening
  - `4ed27ec` fix(course): derive free-text close-grading tier from DB not LLM (scoring-boundary fix)
  - `02f475e` fix: NOT_FOUND assertion, justfile quoting, inspect-wave guard, QualityScore type, z.uuid(), notFound()
  - `22b5696` feat(ui): brand favicon/app icons + vectorized logo loading spinner
- **`/review-pr` of the original (11:42) CodeRabbit review: DONE.** 27 items triaged, 17 inline threads replied + resolved, summary comment posted. CodeRabbit re-reviewed and **passes**.
- **Logo: DONE.** `public/nalu-logo.png` cropped to 1024². `public/nalu-logo.svg` (vectorized, 75 KB). `src/app/favicon.ico` + `icon.png` + `apple-icon.png` generated. `WaveSpinner` in `src/components/chat/MessageBubble.tsx` now rotates the vectorized logo. 5 boilerplate `public/*.svg` deleted.
- **Working tree:** `git status` shows only `.claude/settings.json` (M — user's `/plugin` toggle, **leave it**) and `docs/status/` (untracked — holds these handoffs). **No WIP, nothing to stash.**
- **CI on `22b5696`:** CodeRabbit ✅, Commitlint ✅, GitGuardian ✅, `Check` was pending at handoff (the full suite — typecheck/lint/knip/build/unit 353/integration 153 — was verified **green locally**).
- A separate `feat/anonymous-auth` worktree at `.claude/worktrees/anonymous-auth` — unrelated, **leave it entirely**.
- **`vtracer` is installed globally** at `~/.cargo/bin/vtracer` — available if future asset/vectorization work comes up.

## Important Discoveries

**The 2 unresolved CodeRabbit threads (this is the remaining task):**

1. **`src/lib/course/findOpenQuestionnaire.test.ts:220`** — "Split this test file to satisfy the 200-line cap (file is 221 lines); move the `buildMcCorrectKeyMap` suite to its own file." → **REJECT.** This is the _same finding class_ as items #19/#20 triaged this session: ESLint **exempts test files** from `max-lines` (`eslint.config.mjs:58-62`, `"max-lines": "off"` for `**/*.test.{ts,tsx}`). 221 lines in a test file is **not a rule violation**. Reply with that reasoning + resolve. Do not split the file.

2. **`src/lib/llm/cerebrasRateLimit.ts:135`** — "Serialize slot acquisition to avoid concurrent bypass of spacing/token gates. `awaitCerebrasCallSlot()` is racy: concurrent calls compute waits from the same stale state and dispatch together." → **Likely VALID — triage properly.** This is a _real, narrower_ race than the cross-invocation one already documented. CodeRabbit proposes a single in-process promise queue (`let limiterQueue: Promise<void> = Promise.resolve();` + chain each call through it, with one `// eslint-disable-next-line functional/no-let` justified). The fix is ~10 lines and reasonable. **Note:** this is a SEPARATE race from the two deferred to `TODO.md` this session (`executeWaveMid` / `submitWaveTurn`) — do not conflate. If fixing, add a colocated test for concurrent `awaitCerebrasCallSlot()` calls (`cerebrasRateLimit.test.ts` already exists). Consider whether concurrent in-process calls actually occur (two requests on one serverless instance) before deciding fix-vs-acknowledge — but the limiter's whole purpose is pacing, so a cheap serialization is probably worth it.

**Other discoveries this session:**

- CodeRabbit **re-reviews on every push** and auto-resolves threads it can verify as fixed (7 of this session's 17 were auto-resolved before manual resolution).
- The original review was **stale** — posted at commit `4b32871`, predating 14 commits. Always verify CodeRabbit comments against current code.
- **Approach that failed:** a hand-drawn SVG yin-yang as the loading spinner — the user rejected it ("not an adequate replacement for the true logo… it doesn't look like the actual logo"). Must derive UI assets from the real artwork.
- **Vectorizing the painterly logo:** a faithful `vtracer` trace = 1,772 paths / 470 KB (heavier than the PNG). Flattening to **10 flat colours first** (`magick … -colors 10`) then tracing → 123 paths / 75 KB, still vibrant. 6 colours muddied the orange. svgo `--precision=1` shaved it further.

## Next Steps

1. **`/review-pr` for PR #12.** Re-fetch unresolved threads fresh — CodeRabbit may have added more since this handoff:
   `gh api graphql -f query='{repository(owner:"olliegilbey",name:"nalu"){pullRequest(number:12){reviewThreads(first:80){nodes{isResolved comments(first:1){nodes{databaseId path line body}}}}}}}'`
   (Note: thread comment IDs from GraphQL `databaseId` 404 on the REST `pulls/12/comments/{id}` endpoint — fetch bodies via GraphQL, but **reply** via `gh api repos/olliegilbey/nalu/pulls/12/comments/{id}/replies` and **resolve** via the `resolveReviewThread` GraphQL mutation with the thread `id`.)
2. **Thread 1** (`findOpenQuestionnaire.test.ts`) — reject, reply with the ESLint test-file exemption reasoning, resolve.
3. **Thread 2** (`cerebrasRateLimit.ts`) — triage; if valid, fix via `subagent-driven-development` (Opus implementer + two-stage review), add a concurrency test, commit (`fix(llm):`), push, reply, resolve.
4. Post a brief summary PR comment if multiple items handled.

**Verbatim — the user's instruction at wrap-up (where work stopped):**

> "and /review-pr because coderabbit has some more comments, but we also need to clear context"

## Context to Preserve

- **Workflow:** user runs **subagent-driven-development** as controller — fresh **Opus 4.7** subagent per task, two-stage review (spec compliance → code quality), controller verifies green **locally**, never defers to CI. Subagents check out the branch directly (no worktrees).
- **Ask first:** git commits, pushes, PRs; destructive ops; architecture decisions with multiple valid approaches.
- **Never bypass git hooks** — no `--no-verify`, no `HUSKY=0`. Pre-commit (secret scan → format → lint → typecheck → unit tests) is thorough; fix root causes.
- **Receiving code review:** verify against current code before implementing; no performative agreement; push back on stale/incorrect items with technical reasoning; reply in-thread, not as top-level PR comments.
- **Do NOT touch:** `.claude/settings.json` (user's toggle), the `.claude/worktrees/anonymous-auth` worktree.
- **Core design principle (security boundary):** the LLM generates content/evaluates answers; **deterministic code controls XP/scoring/progression**. The LLM must never influence XP. (This session's `4ed27ec` fixed a violation of exactly this.)
- Project standards: TS strict, no `any`, max 200 lines/file (**test files exempt**), TSDoc on exports, Zod at trust boundaries, business logic in `src/lib/` only, conventional commits, `bun` not npm.
- `just lint` reports ~18 spurious errors from the unrelated `.claude/worktrees/` worktree — rely on `just typecheck` + tests, or lint specific files.
- Integration tests (`just test-int`) boot a Postgres testcontainer and run fine locally (153/153). `just dev` / `just smoke` need Touch ID (`op run`).

## Restart Hint

All committed and pushed, CI green-locally — **safe to `/clear`**. No WIP. Resume by running `/review-pr` for PR #12 and triaging the 2 threads in Important Discoveries.
