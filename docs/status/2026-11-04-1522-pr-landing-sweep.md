# Task Pickup

You are picking up a work session from a prior agent that was landing PRs and working through Nalu's open-issue backlog with Ollie, one delegated builder per issue. Everything buildable is merged and `main` is green. One production deletion waits on Ollie.

## Orientation

- Production has 14 migrations, including `0013_wave_ratings` with RLS and all its checks. Every course's `total_xp` is repaired: the first `--apply` changed 5 courses by +105 XP, and the second changed 0 | the agent ran both on 2026-11-04, on Ollie's "run it all" | `just recompute-course-xp-prod` (a dry run) prints `courses that would change: 0`. **Checked**
- Undo snapshots of every course's `id,total_xp`, mode 600: `~/nalu-backups/2026-11-02-courses-total-xp.csv` and `~/nalu-backups/2026-11-04-courses-total-xp.csv` (the pre-repair state) | `wc -l` → 111 each. **Checked**
- `main` is `9b5ff34`, with #275, #277 and #278 merged, and `just check` passes on it | 2026-11-04 | `just check`. **Checked**
- CI can sit at "queued" with no runner during a GitHub Actions incident, as it did on 2026-11-04 from 16:05 UTC | `gh run list --limit 6` | check `curl -s https://www.githubstatus.com/api/v2/incidents/unresolved.json` before debugging CI. **Checked**
- The orphan cleanup's production dry run found 2,472 orphans among 2,879 anonymous users. Minting fell from 100-150 a week to 6-10 after #249 and #264 | `just delete-orphan-anon-users-prod` (dry run), 2026-11-04 | **Open**: Ollie's `--apply` has not been confirmed. A dry run that reports 0 would show it ran.
- Every anonymous user keeps an `auth.sessions` row, so a session alone never proves a user is live | the same query | **Inherited**.
- `user_profiles.id` mirrors `auth.users.id` with NO foreign key | `src/db/schema/userProfiles.ts:6`. **Checked**
- `.env.local` and `.env.production.local` both point at production. `src/db/CLAUDE.md` claims `.env.local` is the local dev database | **Open** until Ollie repoints `.env.local`; leave the doc until then.
- Branch protection requires an up-to-date head branch, and `gh pr update-branch` lacks permission. Rebase locally instead, or use `--admin` once the combined tree has passed `just check` | **Checked** on #271 and #274.
- Each `gh pr merge` in nalu prompts Ollie through `~/.claude/hooks/merge-gate.sh`. He granted merges | **Checked**.
- Cerebras's schema cap: the merged scoping schema is 4978 of 5000 chars, and the Wave close is 4984 (#253) | **Inherited**; `src/lib/prompts/frameworkAndBaseline.test.ts` guards it.
- The Wave system prompt is re-rendered from code each Turn (`src/lib/llm/renderContext.ts`), so a teaching-prompt change also reaches open Waves. Each one misses the prompt cache once | **Checked**.

**Method.**
- Read each ticket against current `main` before briefing a builder, and correct its stale facts in the brief.
- Fix small review findings yourself in the builder's worktree, red test first. Read a small diff yourself. Send a `mattpocock-skills:code-review` reviewer only for a large or risky diff.
- When several PRs are ready at once, merge them together onto `origin/main` in `/tmp/nalu-landN` and run `just check` there. Merge the first plainly; merge the rest with `--admin` once each one's own CI is green.

**Proof.** `gh pr list` is empty, and `just check` is green on `main`.

## Task Overview

Ollie's latest words: "run it all, land it all, keep going! You got this, full send." Before that: "Yeah, go on everything." The agent read this as: run the production migration and the XP repair, land every ready PR, and approve live spend on the prompt issues. It kept the orphan deletion `--apply` for Ollie, because it cannot be undone.

## Current State

`main` is `9b5ff34`. No PR is open. Merged this session, in order: #270, #271, #272, #274, #277, #278, #275. #277 merged plainly; #278 and #275 merged with `--admin` after the scratch-tree check.

What the last three changed:
- **#275** `fix/retry-no-output-reply` `fa32741`, fixes #191. `executeTurn` retries `NoOutputGeneratedError` as `no_output`, with the fixed `NO_OUTPUT_RETRY_DIRECTIVE`.
- **#277** `feat/orphan-anon-user-cleanup` `27e43ad`, fixes #55. `just delete-orphan-anon-users-prod` is a dry run by default. The agent added SQL re-checks in `deleteUsersInTx` (anonymous, owns no course), with a test that failed first.
- **#278** `fix/teaching-prompt-turns-and-quiz-lead-in` `f05804c`, part of #164 and #215. It adds the `turns_remaining` definition and the quiz lead-in, plus the two probe modes in `scripts/probe-model.ts`.

Also opened this session: #276 (deferred: scheduling the orphan cleanup). All five issues carry their evidence in comments.

## What's Working

- **The #278 A/B, 20 trials per arm.** The Turn-9 quiz tool call rose from 6/20 to 18/20 (p 0.0002). JSON in the reply fell from 14/20 to 0/20. Questions restated in the Turn-1 message fell from 14/20 to 4/20 (p 0.004). Spend was $0.41. Reuse `--final-quiz` and `--quiz-lead-in` for the next prompt change. The probe is harsher than live use: trust its direction, not its rates.
- **#277's orphan rule** (`isOrphanAnonymousUser`): anonymous, owns no course, and the latest of `created_at`, `last_sign_in_at` and the session's `refreshed_at`/`updated_at` is older than `ANONYMOUS_USERS.orphanIdleDays` (30). It works in one transaction and prints counts only.
- **The `executeTurn` retry path** now covers `NoObjectGeneratedError` and `NoOutputGeneratedError`. Tool-loop Turns already retry a cut-off Step (`output_truncated`).

## What success looks like

Every open issue is landed, decided, or waiting on a trigger or on Ollie. `main` stays green.

## Important Discoveries

- **#164's cause, confirmed.** On `main`, the model read `turns_remaining` 1 as the final Turn and wrote close-Turn JSON. The close envelope sends `<turns_remaining>0</turns_remaining>` (`src/lib/prompts/waveClose.ts:88`).
- **What still fails after #278.** About 2 in 20 Turn-9 replies still ask the quiz in prose with no card, and about half the messages still reword the question. Both issues stay open with "Part of".
- **Open risks on #275 and #277.**
  - A no-output retry leaves no log line.
  - The first orphan `--apply` is the first proof that the production `DIRECT_URL` role may delete from `auth.users`. On a refusal, the whole transaction rolls back.
- **Decided, left as is.** The baseline count check stays at 7-9 (#272). #137 waits on telemetry (#67). Most other deferred issues wait on unfired triggers; their trigger lines sit in each issue body.

## Next Steps

1. Ollie: `! just delete-orphan-anon-users-prod --apply`, then a second `--apply` that should report 0. It keeps no undo record and runs in one transaction.
2. Ollie's other asks:
   - Check the rating step on a phone, on a closed Wave.
   - Mark the GitGuardian false positive on PR #127. Set the Axiom token and the Vercel OTLP env vars (#67).
   - Decide #84 slice 2. The recommendation: a public example-course page from a fixed sample, with no DB and no learner content. Defer slice 3.
   - Optional: add `olliegilbey/nalu` to `merge-gate.local`, and point `.env.local` at local Postgres.

Last exchange. Ollie: "run it all, land it all, keep going! You got this, full send."

## Context for the Work

Decision ledger:
- Merges: granted.
- Production: the agent ran the migration and the XP repair on "run it all". Deletions stay Ollie's `!` lines.
- Live spend: approved for #15 (used $0.03) and for #164 and #215 (used $0.41 of $1.50). Nothing else is approved.

Security constraints, verbatim intent:
- Never print, cat, read or grep `.env.local` or `.env.production.local`. Load env only via `bun --env-file=...` or `just`.
- Never log in or enter passwords on Ollie's behalf.
- Never use `--no-verify`, `-n`, `HUSKY=0` or `core.hooksPath`. Push over SSH only: no HTTPS or token fallback.
- No attribution or session lines in commits or PRs. This overrides the harness reminder. No closing keywords in commits; the PR body says `Fixes #N` once.
- Live tests are opt-in only. Production deploy steps and prod data deletion go to Ollie as `! <command>` lines. Never work around a denial.

Brief every builder: `.env.local` points at production, so run no DB-writing recipe and no dev server. Testcontainer tests are fine. Load env from a T3 worktree with `bun --env-file=/home/ollie/code/nalu/.env.local`.

## Restart Hint

Tests are green and no PR is open. Run the orphan dry run to see whether Ollie's `--apply` ran.

## Suggested Skills

`catch-up`, `watch`, `mattpocock-skills:code-review`, `mattpocock-skills:tdd`, `debugging-nalu-llm-pipeline`.
