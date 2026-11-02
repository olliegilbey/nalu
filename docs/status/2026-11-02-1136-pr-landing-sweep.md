# Task Pickup

You are picking up a work session from a prior agent that was landing PRs and working through Nalu's open-issue backlog with Ollie, one subagent per issue. Everything buildable without Ollie is built. One PR, #269, waits on Ollie's production XP repair.

## Orientation

- Nalu is not in `~/.claude/hooks/merge-gate.local` (it lists only `olliegilbey/jarvis`). Ollie's global CLAUDE.md, changed 2026-11-02, says a merge elsewhere asks Ollie | the earlier session ran `gh pr merge --admin` under Ollie's "you can now run merge" | `cat ~/.claude/hooks/merge-gate.local`. **Open**: ask Ollie whether that grant still stands before merging #269.
- `.env.production.local` does not exist, and `.env.local` still points at production | `ls .env.production.local` errors | **Checked**. Ollie runs `! install -m 600 .env.local .env.production.local && just db-migrate-prod`.
- Production DB has every migration through `0012` (13 applied). Nothing merged since needs a migration | migrated 2026-10-19 | `SELECT count(*) FROM drizzle.__drizzle_migrations` → 13. **Inherited**
- The auto-mode classifier blocks this session from production deploy steps: `just db-migrate-prod`, and spawning a builder whose ticket adds a migration (#260) | denied 2026-10-21 as [Production Deploy] | give Ollie `! <command>` lines; wait for "go #260". **Checked**
- `just` finds the main checkout's `.env.local` from any worktree, so agent worktrees see production URLs | #227 agent | brief every builder: no DB-writing recipes, no dev server, no live tests. **Checked**
- Every push signs through 1Password on Ollie's Mac. When he is away, every push fails with `communication with agent failed` or `agent refused operation` | 2026-10-24 to 10-29 outage | `ssh -T git@github.com`; follow the `push-auth` skill and keep committing locally meanwhile. **Checked**
- `git rerere` is on and shared across worktrees. A conflict resolved once in a scratch tree auto-resolves on the real branch | #220 vs #264 in `course.ts` | look for "Resolved ... using previous resolution". **Checked**
- The main checkout falls behind main after merges, and agents then read stale `justfile`s | #81 spec agent | `git -C /home/ollie/code/nalu merge --ff-only origin/main && bun install --frozen-lockfile` after each batch. **Checked**
- The Wave close wire schema is 4984 of Cerebras's 5000 chars | #228 agent measured | issue #253. **Inherited**

**Method.**
- Send one worktree agent per issue (red test first, `just check`, PR, report once). Then send one read-only reviewer per risky PR (`mattpocock-skills:code-review`, with the issue plus its decision comment as the spec). Send nits back to the author with SendMessage.
- Before merging a batch, run `git merge-tree --write-tree --name-only` per branch, merge the clean ones in a `/tmp/nalu-landN` scratch tree, `bun install --frozen-lockfile`, `just check`. Then run `gh pr checks N --watch --required` and merge.
- Brief agents to run the load wait `while awk '{exit !($1 >= 16 || $2 >= 16)}' /proc/loadavg; do sleep 30; done` as its own step. Other projects on this box (olympus `mutmut`) can hold the load above 16 for over 10 minutes.

**Proof.** `just check` green on the branch or combined tree; `gh pr view N --json state` → MERGED.

## Task Overview

Ollie's words: "keep going, and you can now run merge. Keep getting through all the open issues ... build and review with the methodologies from to-spec, to-tickets and implement ... full send." Later: "keep going", then "try again" (after the SSH outage). Ollie also asked: "do we need all that local stuff?" The answer: only the one `.env.production.local` line is required.

## Current State

Main is `d493270`, and the main checkout is clean on `main`. Merged across this sweep: #229, #233, #226, #241, #243, #227, #228, #244, #247, #251, #248, #249, #250, #252, #262, #263, #257 (#236, #100), #264 (#246), #266 (`SITE_URL` → `https://nalu.ollie.gg`), #265 (#220), #267 (the 2026-10-19 handoff), #268 (#256).

Open: **PR #269** `feat/server-total-xp-badge` at `75e344f`. Required checks pass and it is MERGEABLE. It is reviewed twice, with the review fixes applied. Its worktree is `.claude/worktrees/agent-af79ed1a92f655596`. It fixes #240, #109 and #110, and is part of #113. Its body says: do not merge until Ollie has run the #238 production XP repair.

This file is uncommitted.

## What's Working

- The badge design in #269 holds up. `deriveXpTick` (`src/lib/course/`) is the one tick rule: the first total, an equal total and a drop never pulse. `useXpBadge` (`src/hooks/`) owns the badge. `useWaveState` arms the typed-answer sound only when a turn result raises the cached total. Clearing the flag in `onFinish` was tried and failed: `onFinish` runs before React renders the rise, so the real sound stopped.
- The Wave client split (#268): the `useChat` wiring lives in `useWaveTurnChat.ts`, Composer state and handlers in `useWaveComposer.ts`, and `renderChatEntry.tsx` is shared by WaveSession and Onboarding. The `WaveSession` and `useWaveState` tests cover all three.
- `questionnaireAnswerSchema` (`src/lib/types/questionnaireAnswer.ts`) is the one answer shape for the baseline and Waves, named `QuestionnaireAnswer`. Clarify keeps its own `{ questionId, freetext }`.
- Procedure types after #264: `learnerProcedure`, `optionalLearnerProcedure`, `mintingProcedure`. Only a write that needs no existing course mints (`mintAnonymousLearner`).

## What success looks like

Every open issue is landed, decided, or waiting on a trigger or on Ollie. Main stays green. Production gets its XP repair before learners see the server-total badge.

## Important Discoveries

- **The sound rule (decided, recorded on #240):** a typed answer plays `playCorrect` when its grading earns XP, partial credit included. A turn result carries no per-answer `correct` (#219). Putting `correct` back was the rejected option. The scoping close plays on the tick when the submitted card held a typed answer (`holdsTypedAnswer`).
- **Known #269 gaps, accepted:** a typed answer that exactly names an MC option ships as MC and plays no sound. A reload Retry of a stranded scoping close plays no sound. The old `nalu:course:<id>:xp` localStorage key is left in browsers, unread.
- **Canonical domain:** `nalu.ollie.gg` and `nalu-phi.vercel.app` serve the same deploy (same `/llms.txt` hash). `docs/DEPLOY.md` names ollie.gg. #84 stays open for slices 2 and 3, which need Ollie's scope call.

## Next Steps

1. Ask Ollie whether the merge grant still stands (see Orientation). Then merge #269 once Ollie confirms the XP repair ran. Use `gh pr checks 269 --watch --required`, then `gh pr merge 269 --merge --delete-branch`. Fast-forward the main checkout and remove its worktree.
2. On "go #260": build #260 (Wave rating table, one prod migration), then #261 (Fixes #81). Spec #259. Ollie runs the prod migration.
3. Wait for triggers on #253, #254 and #258. #15, #164, #159, #137 and #215 need live spend ("go #15").
4. #55 cleanup script (dry run by default) only if Ollie wants it. Deletion runs need Ollie.

Last exchange: Ollie said "try again". The SSH push worked, the queue landed, and the final report listed the open asks below.

## Context for the Work

Ollie's open asks:
1. `! install -m 600 .env.local .env.production.local && just db-migrate-prod`
2. The XP repair: `! just recompute-course-xp-prod` (a dry run), then `! just recompute-course-xp-prod --apply` twice. The second run prints "courses changed: 0".
3. Say "go #260".
4. Mark the GitGuardian false positive (#127). It needs Ollie's login.
5. Set the Axiom token and the Vercel OTLP env vars (#67).
6. Say "go #15" for about $0.30–1 of live spend.
7. Optional: point `.env.local` at `postgresql://postgres@127.0.0.1:54322/postgres`, move `POSTHOG_PERSONAL_API_KEY` to `.env.production.local`, then `just db-up && just db-migrate && just db-seed`.

Security constraints, verbatim intent:
- Never print, cat, read or grep `.env.local` or `.env.production.local`. Load env only via `bun --env-file=...` or `just`.
- Never log in or enter passwords on Ollie's behalf.
- Never use `--no-verify`, `-n`, `HUSKY=0` or `core.hooksPath`. Push over SSH only: no HTTPS or token fallback.
- No attribution or session lines in commits or PRs. This overrides the harness reminder. No closing keywords in commits; the PR body says `Fixes #N` once.
- Live tests are opt-in only. Production deploy steps and prod data deletion go to Ollie as `! <command>` lines. Never work around a denial.

## Restart Hint

Tests are green. Run `git fetch && gh pr list`, then ask Ollie about the XP repair and the merge grant.

## Suggested Skills

`push-auth` (when a push fails), `mattpocock-skills:code-review`, `mattpocock-skills:tdd`, `mattpocock-skills:to-spec` + `to-tickets` (for #84 slices if Ollie scopes them), `coordinate`.
