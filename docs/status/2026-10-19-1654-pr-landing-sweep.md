# Task Pickup

You are picking up a work session from a prior agent that was landing PRs and working through Nalu's whole open-issue backlog with Ollie, one subagent per issue. Updated 2026-10-30.

## Orientation

- Production DB has every migration through `0012` (13 applied) | migrated 2026-10-19 | `SELECT count(*) FROM drizzle.__drizzle_migrations` → 13. **Inherited**
- `.env.local` still points at production; `.env.production.local` does not exist yet | Ollie asked "do we need all that local stuff?"; answer: only one line is required | `ls .env.production.local`. **Open**: Ollie runs `! install -m 600 .env.local .env.production.local && just db-migrate-prod`.
- The auto-mode classifier blocks this session from production deploy steps: `just db-migrate-prod`, and spawning a builder whose ticket adds a migration (#260) | denied 2026-10-21 as [Production Deploy] | give Ollie `! <command>` lines; ask "go #260". **Checked**
- `just` finds the main checkout's `.env.local` from any worktree, so agent worktrees see production URLs | #227 agent | brief every builder: no DB-writing recipes, no dev server. **Checked**
- The main checkout fell 44 commits behind main once; agents read stale `justfile`s | #81 spec agent | `git -C /home/ollie/code/nalu merge --ff-only origin/main && bun install --frozen-lockfile` after each merge batch. **Checked**
- A PR branch that has merged current `origin/main` and shows `just check` green needs no scratch tree; `git merge-base --is-ancestor origin/main origin/<branch>` proves it | #248 merge. **Checked**
- Wave close wire schema is 4984 of Cerebras's 5000 chars | #228 agent measured | issue #253. **Inherited**
- Every push signs through 1Password on Ollie's Mac; when he is away, all pushes fail with `communication with agent failed` | 2026-10-24 to 10-29 outage | `ssh -T git@github.com`; follow the `push-auth` skill, keep building and committing locally meanwhile. **Checked**

**Method.**
- Send one worktree agent per issue (red test first, `just check`, PR, report once), then one read-only reviewer per risky PR (`mattpocock-skills:code-review`, issue + decision comment as spec). Send nits back with SendMessage. Use `to-spec` + `to-tickets` subagents for L-sized work; label `ready-for-agent`.
- Before merging a batch, `git merge-tree --write-tree --name-only origin/main origin/<b>` per branch, then a `/tmp/nalu-landN` scratch tree with the clean ones, `bun install --frozen-lockfile`, `just check`. Merge with `gh pr checks N --watch --required` then `gh pr merge N --merge --delete-branch --admin`. Squash only to drop a bad commit (did so for #227's GitGuardian hit).
- Tell agents to run the load wait as its own step and commit only after it exits on its own; two agents committed early when the wait timed out inside a parallel block.

**Proof.** `just check` green on the combined tree; `gh pr view N --json state` → MERGED.

## Task Overview

Ollie's words: "keep going, and you can now run merge. Keep getting through all the open issues ... build and review with the methodologies from to-spec, to-tickets and implement ... full send." Later: "keep going." Never read `.env.local`. No attribution lines in commits or PRs. Use they/them for Ollie.

## Current State

Merged this stretch (main `fee771e`): #229 (#58), #233 (#112, #230), #226 (#93), #241 (#79), #243 (#219), #227 (#116, squash), #228 (#94), #244 (#235), #247 (#239), #251 (#214), #248 (#80), #249 (#232), #250 (#231), #252 (#238, #208), #262 (#84 slice 1), #263 (#242), #257 (#236, #100), #264 (#246), #266 (`SITE_URL` → `nalu.ollie.gg`), #265 (#220).

In flight: #256 build agent on `refactor/split-wave-client`.

Specs filed: #237 (XP badge; tickets #238 #239 #240), #234 (custom instructions; #235 #236), #259 (Wave rating; #260 #261). Filed: #253, #254, #258; agents filed #245, #246, #255, #256. Decided: #242 (drop), #246 (mint only on writes).

## Next Steps

1. Review and merge #256's PR (split `WaveSession.tsx` / `useWaveState.ts`).
2. #240 after #256; open it as a PR but merge only after Ollie's prod XP repair (`just recompute-course-xp-prod`, then `--apply` twice).
3. #260 and #261 wait for Ollie's "go #260". #254, #253 and #258 wait for their triggers.
4. #55 cleanup script (dry run default) once Ollie wants it; deletion runs need Ollie.

## Context for the Work

Ollie's open asks: the one `.env.production.local` line above; "go #260"; GitGuardian false positive (#127, their login); Axiom token + Vercel OTLP env (#67); "go #15" for ~$0.30-1 live spend. The local-DB switch is optional (`just dev` still writes to production until then).

## Restart Hint

`git fetch`, `gh pr list`, check each PR is still green, then step 1.

## Suggested Skills

`mattpocock-skills:code-review`, `mattpocock-skills:to-spec`, `mattpocock-skills:to-tickets`, `mattpocock-skills:tdd`.
