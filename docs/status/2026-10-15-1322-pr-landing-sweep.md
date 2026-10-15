# Task Pickup

You are picking up a coordination session that lands fix PRs on Nalu through subagents, keeps the issue tracker true, and brings the agent and tool-use code to late-2026 practice (AI SDK v6, with Pydantic AI as a reference design). The human is Ollie. Ollie merges; agents stop at a green, reviewed PR.

## Orientation

- Ollie's last command merges 11 PRs in order: #195 #194 #192 #200 #201 #202 #206 #211 #209 #212, then this file's PR #203. It stops at the first red check | Open: confirm what landed | `gh pr list --state merged --limit 15`
- #209 and #212 are stacked. #209 carries merges of #201 and #202; #212 carries #209 and #195. Each holds the conflict resolution for its partners, so the ordered merge is conflict-free | Checked: replaying the 10 merges in order with rerere off gives tree `0ad60f8`, the tree that passed `just check` | `git merge-tree --write-tree` per pair
- The GitHub token (fine-grained PAT in `~/.config/gh/hosts.yml`) lost write access for about an hour, then got it back. On a 403 "Resource not accessible by personal access token", stop writes and give Ollie the body files | Open: may recur | `gh auth status`
- Ollie merges with `! gh pr merge N --merge --delete-branch`. Protection is strict, and `enforce_admins` is false. Give `--admin` only after `just check` passes on a scratch tree of main plus every PR in the batch | Checked: `gh api repos/olliegilbey/nalu/branches/main/protection`
- `gh pr merge --delete-branch` fails when the branch is checked out in a worktree. Before giving a merge line, `git -C <worktree> switch --detach` the clean worktree whose HEAD matches the remote | Checked
- Build a combined tree with `git worktree add --detach /tmp/nalu-landN origin/main`, then `git merge --no-ff --no-edit <branch>...` (octopus works when no pair conflicts), `bun install --frozen-lockfile`, `just check`. Run pairwise `git merge-tree --write-tree --name-only A B` in `bash <<'EOF'` first (zsh rejects the array loop) | Checked
- Commit a conflicted scratch merge through the hooks, like any commit. The auto-mode classifier blocks `--no-verify` even in a scratch tree | Checked
- `rerere.enabled=true` is shared across worktrees. It replays a recorded conflict resolution, with sides swapped too. It does not replay an edit to a file that merged cleanly; carry that as a patch | Checked: `git config rerere.enabled`
- `knip --production` (#195) skips tests, so a new test-only helper outside a test file shows as an unused file. Add it to the `!path!` list in `knip.jsonc` with a comment naming its runtime use | Checked: `bun x knip --production`
- The pre-commit hook fails green commits over its 60s budget when load is high (#143). Gate commits on both load averages, and retry once on a timeout: `while awk '{exit !($1 >= 16 || $2 >= 16)}' /proc/loadavg; do sleep 30; done` | Checked
- SSH push works only while 1Password is unlocked; otherwise give Ollie a `! git -C <worktree> push …` line. Never fall back to HTTPS or a token | Checked
- With `LLM_TELEMETRY=true`, the SDK records `ai.response.providerMetadata` on every span, outside `recordOutputs`. It holds prediction-token counts only, because `provider.ts` sets no `metadataExtractor` | Checked: `grep -n '"ai.response.providerMetadata"' node_modules/ai/dist/index.mjs`; `rg metadataExtractor src`
- Live runs: `just --command env CEREBRAS_LIVE=1 NALU_SMOKE_QUIET=1 bunx vitest run --project live <file>`. One `wave.live.test.ts` run costs about $0.07. Agents symlink `.env.local` into their worktree and delete it after | Inherited

**Method.**
- Give one worktree agent per issue a self-contained brief: red test first, `just check`, push, PR, stop at green, report ONCE, do not poll CI. Ban closing keywords in commit messages.
- Run a separate read-only reviewer per branch. Send must-fixes and nits back to the author via SendMessage; self-review the fix commit with `git diff <old-head> origin/<branch>`.
- Stack a PR on its conflict partners when Ollie wants one merge command: merge the partner branches into it, resolve, push. Then prove the ordered merge reproduces the checked tree.

**Proof.** `just check` exits 0 on main, and `LLM_DEBUG_GRADINGS=1 just smoke` passes 9/9 (~$0.14).

## Current State

Ollie approved, verbatim: "give me the command to merge all of them. and go for all the fixes as you recommend." That covers #192's order change (quiz tool call before the message; the card still renders below it), #198 option (b), and #205 option (a).

Combined `just check` on main `d769cf3` plus all ten code PRs: 878 unit and 201 integration tests passed.

| PR | Fixes | Note |
|---|---|---|
| #195 `chore/knip-production` | #177 | |
| #194 `refactor/context-message-kind-role-pair` | #108 | |
| #192 `fix/quiz-tool-before-prose` | refs #164 #145 | |
| #200 `test/provider-wire-import-cost` | #199 | |
| #201 `fix/agent-stream-onerror` | #173 | |
| #202 `refactor/comprehension-signal-type` | #119 | |
| #206 `refactor/sm2-schema-from-tuning` | #197, #210 | adds migration `0011_easiness_factor_floor_real.sql` |
| #211 `fix/telemetry-span-error-text` | #204 | spans drop error message and stack |
| #209 `fix/mid-turn-correct-from-score` | #198 | stacked on #201 #202 |
| #212 `fix/course-total-xp-assessments` | #205 | stacked on #209 #195; adds the lock order in `src/db/queries/CLAUDE.md` |

#210 is a production bug that #206 fixes: the `easiness_factor` column is `real`, and `real` 1.3 is below float8 1.3, so the CHECK rejected the floor. A learner who fails a concept twice gets a failing Wave close (23514) until the migration runs.

Issues filed this session: #196 #197 #198 #199 #204 #205 #207 (a schema change with no migration goes unnoticed) #208 (`total_xp` backfill, deferred) #210 #213 (return `isCorrect` on `AppliedGrading`; unblocked once #209 and #212 land) #214 (close-graded free-text never writes `user_answer`, deferred) #215 (mid-turn message restates the quiz question, deferred). #145 has a comment on the untested reasoning-as-content lever.

## Next Steps

1. Confirm which PRs merged. For a stop, read the failing check, fix on the branch, and give a resume command for the rest.
2. Tell Ollie to run `just db-migrate` on prod once #206 is on main.
3. Clean up once merged: agent worktrees under `.claude/worktrees/agent-*` and their `worktree-agent-*` branches (clean and ancestor of main, `git worktree unlock`, `git worktree remove` without force, `git branch -d`), and `/tmp/nalu-land*`.
4. Pick up #213 next: a small refactor on top of #209 and #212.

## Context for the Work

Ollie reads only the last message: BLUF, short sentences, restate every open ask. Ollie's standing words: "keep going, keep using subagents, coordinate and keep landing fixes and updates. Make sure you are following best practices for tool use with agents, and late 2026 best practices. Refactor or apply updates where not. Pydantic is a good reference, as well as the ai sdk."

Decisions Ollie made: `feat/corti-path-a` stays parked; #99 closed, summary to #93; #46 moved into `src/db/queries`; #62 keep `lastQuality`; #19 extract the Composer.

Security, verbatim: copy `.env.local` "without reading it". Never print it.

Ollie's open asks:
1. Run the 11-PR merge command.
2. Run the count query in #107's PR body on prod (must return 0), then `just db-migrate`; again after #206 merges.
3. Mark the GitGuardian incident from #127 a false positive.
4. Decide #58, #93, #94, #116, #143, #154.
5. Eyeball #125's UI on production.
6. Set the OTLP env vars in Vercel (#67); `LLM_TELEMETRY=true` only after #211 merges.

Live spend this session: about $3.4 (no live runs since the last batch).

## Restart Hint

Nothing local is at risk: every branch is pushed. Resume at Next Steps 1.

## Suggested Skills

`mattpocock-skills:code-review` for PR reviews, `superpowers:systematic-debugging` for a red smoke or a red merge check, `debugging-nalu-llm-pipeline` for a production failure.
