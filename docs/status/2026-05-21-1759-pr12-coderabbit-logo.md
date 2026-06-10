# PR #12 finalize — CodeRabbit triage + logo refresh

## Task Overview

PR **#12** (`feat/teaching-loop` → `main`) — the AI wave teaching loop — is **open, CI green, and mergeable**. The 5 ultrareview bugs are fixed and a Cerebras rate limiter was added (all done this session — see Current State).

**Two pieces of work remain to finalise PR #12:**

1. **Triage CodeRabbit's review.** CodeRabbit posted **17 inline + 3 outside-diff comments** — but the review is **stale** (see Important Discoveries). Triage each with `/review-pr` + `receiving-code-review` discipline: verify against _current_ code, fix the valid ones, push back on stale/wrong ones, reply + resolve threads. CodeRabbit does not block CI; this is quality cleanup.
2. **Logo refresh.** The user created a new logo at `public/nalu-logo.png` (untracked) to replace **all logos and the loading spinner** — the spinner "currently looks awful." The logo PNG "might need to crop it square anchored on the center pixel" before use.

## Reference Docs

- `@docs/status/2026-05-21-1309-teaching-loop-review-fixes.md` + `@docs/status/2026-05-21-1309-ultrareview-findings.md` — full detail of the 5 ultrareview bugs. **Those bugs are now DONE** — only read these if a CodeRabbit comment touches that code and you need the rationale.
- `AGENTS.md` / `CLAUDE.md` / `KARPATHY.md` — project + agent guides. Subdir `CLAUDE.md` files auto-load.
- PR: https://github.com/olliegilbey/nalu/pull/12

## Current State

- Branch `feat/teaching-loop`, HEAD `3ac162e`, **all pushed to origin**. PR #12 CI **fully green** (Check / CodeRabbit / Commitlint / GitGuardian all pass).
- Local verification at HEAD: `just typecheck` clean, unit **352/352**, integration **152/152**.
- **14 commits added this session** (`4b32871..3ac162e`):
  - 5 ultrareview bug fixes + doc/refactor follow-ups: `cffd3f8` `836e674` `915dbcb` `b048509` `def01d7` `4dede32` `5cc173d` `4b74cef` `0c47bf7`
  - Cerebras rate limiter: `d0dacb1` `5335fd3` `9adc510` `254ae30`
  - CI fix: `3ac162e`
- **Working tree** (do NOT commit/touch unless the task needs it):
  - `.claude/settings.json` — modified, the user's `/plugin` toggle. **Leave it.**
  - `public/nalu-logo.png` — untracked. **This is the INPUT asset for the logo task.**
  - `docs/status/` — untracked (holds this file).
- A separate `feat/anonymous-auth` worktree lives at `.claude/worktrees/anonymous-auth` — unrelated work, **leave it entirely**. (It makes local `just lint` report ~18 spurious errors; CI is unaffected because the worktree is not in the repo tree. Optionally add `.claude/worktrees/` to ESLint ignores — minor, not required.)

## Important Discoveries

- **CodeRabbit's review is STALE.** It posted ONE review at `2026-05-21T11:42:30Z` — _before_ all 14 commits (last commit `3ac162e` is `17:51`). CodeRabbit has not re-reviewed since. So a meaningful fraction of the 17 inline + 3 outside-diff comments point at code that has since been modified, fixed, or moved. **Verify every comment against current code before acting** — expect many to be already-resolved or no-longer-applicable. Fetch them: `gh api repos/olliegilbey/nalu/pulls/12/comments?per_page=100 --paginate`. Review body: `gh pr view 12 --json reviews`.
  - One known outside-diff item: `src/lib/course/executeWaveClose.integration.test.ts` flagged as over the 200-line cap — and this session's bug_003 work _added_ tests to that file, so it's likely still valid (possibly more so).
- **Cerebras free tier = 5 RPM / 30k TPM / 1M tokens-day** (confirmed from docs). The codebase originally assumed ~30 RPM — wrong by 6×. The rate limiter (`src/lib/llm/cerebrasRateLimit.ts`) paces at **13s/call**; the knob is `LLM.minRequestSpacingMs` in `tuning.ts`. Token backoff reads `x-ratelimit-*` response headers.
- The Cerebras API key is **shared** with the user's separate speech-to-text workload — Nalu's budget is "whatever STT leaves." The header-driven backoff handles this automatically.
- The rate limiter is **in-process** (module state) — racy across Vercel serverless invocations. Deliberate, accepted; a shared-store (Postgres) cross-invocation version is explicit **future work**, not done.
- **Live smoke NOT verified end-to-end.** The limiter is unit + integration tested and sound by analysis but never confirmed against real Cerebras. A run is slow by design: ~13-16 min full `just smoke`, ~7-9 min for `wave.live.test.ts` alone. `just smoke` needs Touch ID (`op run`).
- **knip:** any directly-run script in `scripts/` must be added to `knip.json` `entry[]` or the CI dead-code check fails (this was the `3ac162e` fix).
- **Approaches ruled out** (do not retry): bug_003 — rejecting `mc-index` at parse-time converts a 500 into retry-exhaustion (must grade mechanically). Rate limiter — a fixed per-_turn_ delay is insufficient; `executeTurn` retries fire multiple calls per turn, so pacing must be per-_call_ at `generateChat`.

## Next Steps

1. **CodeRabbit triage** — `/review-pr` for PR 12. Fetch the 17 inline + 3 outside-diff comments. For each: verify against current code; fix if valid; if stale/wrong, reply in-thread with technical reasoning and resolve. Do NOT performatively agree; do NOT blind-implement. Reply to inline comments in-thread (`gh api repos/olliegilbey/nalu/pulls/12/comments/{id}/replies`), not as top-level PR comments. Commit fixes, push to `feat/teaching-loop`.
2. **Logo refresh** — input asset is `public/nalu-logo.png`. (a) It may need to be cropped **square, anchored on the center pixel** — the user flagged this. (b) Replace all existing logo usages and the loading spinner. Current usage is NOT yet mapped — investigate: `public/` holds Next.js boilerplate SVGs (`next.svg`, `vercel.svg`, `file.svg`, `globe.svg`, `window.svg`) likely standing in as logos; `src/components/chat/MessageBubble.tsx` is a lead for the loading/spinner. **Ask the user to confirm exactly which logos and where the loading spinner is** if investigation is ambiguous — the spinner "looks awful" so they have a specific thing in mind.
3. **Optional:** verify the rate limiter live — `wave.live.test.ts` alone (~7-9 min, Touch ID). Not a merge blocker.

**Verbatim — the user's most recent instruction (where work stopped):**

> "and /review-pr are both needed to check what coderabbit came back with first. But it would also be good to clear your context with a wrap-up. And, there's a new logo png file I created to replace all the logos and the loading spinner, which currently looks awful. Might need to crop it square anchored on the center pixel."

This session: fetched CodeRabbit's review (found it stale — predates the 14 commits), recommended deferring the 20-item triage + logo work to a fresh session rather than triaging in an exhausted context. The user agreed via the wrap-up request.

## Context to Preserve

- **Workflow:** user runs **subagent-driven development** as controller — fresh **Opus 4.7** subagent per task, two-stage review (spec compliance → code quality), controller verifies green **locally**, never defers verification to CI. Subagents check out the branch directly (no worktrees).
- **Ask first:** git commits, pushes, PRs; destructive ops; architecture decisions with multiple valid approaches.
- **Never bypass git hooks** — no `--no-verify`, no `HUSKY=0`. Pre-commit is thorough; fix root causes.
- **Receiving code review:** verify before implementing; no performative agreement ("you're absolutely right" etc.); push back on stale/incorrect CodeRabbit items with technical reasoning; one item at a time.
- **Do NOT touch:** `.claude/settings.json` (user's toggle), the `.claude/worktrees/anonymous-auth` worktree.
- **Logo (verbatim user constraint):** "Might need to crop it square anchored on the center pixel."
- Project standards: TS strict, no `any`, `readonly`/`const`, TSDoc on exports, max 200 lines/file, Zod at trust boundaries, business logic in `src/lib/` only, prompts in `src/lib/prompts/` only, DB access in `src/db/queries/` only. Conventional commits. bun, not npm.
- Secrets: never echo values; `just smoke`/`just dev` wrap with `op run` → Touch ID.

## Restart Hint

All work committed and pushed, CI green — **safe to `/clear`**. Working tree has only the user's `.claude/settings.json`, the untracked `public/nalu-logo.png` (the logo-task input), and `docs/status/`. No WIP to stash.
