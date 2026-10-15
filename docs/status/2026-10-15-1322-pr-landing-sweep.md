# Task Pickup

You are picking up a coordination session that lands fix PRs on Nalu through subagents, keeps the issue tracker true, and brings the agent and tool-use code to late-2026 practice (AI SDK v6, with Pydantic AI as a reference design). The human is Ollie. Ollie merges; agents stop at a green, reviewed PR.

## Orientation

- Main is at `d769cf3` or later. Merged on 2026-10-15: #183 #184 #185 #186 #188 #189 #190 #193 | Checked | `gh pr list --state merged --limit 15`
- The GitHub token (fine-grained PAT in `~/.config/gh/hosts.yml`) lost write access for about an hour, then got it back. On a 403 "Resource not accessible by personal access token", stop writes and give Ollie the body files | Open: may recur | `gh auth status`
- Ollie merges with `! gh pr merge N --merge --delete-branch`. Protection is strict, and `enforce_admins` is false. Merge the up-to-date PR normally. Give `--admin` for the rest only after `just check` passes on a scratch tree of main plus all of them | Checked: `gh api repos/olliegilbey/nalu/branches/main/protection`
- `gh pr merge --delete-branch` fails when the branch is checked out in a worktree. Before giving a merge line, `git -C <worktree> switch --detach` the clean worktree whose HEAD matches the remote | Checked
- Build a combined tree with `git worktree add --detach /tmp/nalu-landN origin/main`, then `git merge --no-commit --no-ff <branch>...` (an octopus merge works when no pair conflicts), `bun install --frozen-lockfile`, `just check`. Run pairwise `git merge-tree --write-tree --name-only A B` in `bash <<'EOF'` first (zsh rejects the array loop) | Checked
- `rerere.enabled=true` is shared across worktrees. It replayed the #185 × #192 test-file resolution | Checked: `git config rerere.enabled`
- The pre-commit hook fails green commits over its 60s budget when load is high (#143). Other projects (olympus mutmut, an Apalache run) push load to 30-50. Gate commits on both load averages: `while awk '{exit !($1 >= 16 || $2 >= 16)}' /proc/loadavg; do sleep 30; done` | Checked
- SSH push works only while 1Password is unlocked; otherwise give Ollie a `! git -C <worktree> push …` line. Never fall back to HTTPS or a token | Checked
- `streamText`'s default `onError` is `console.error(error)`; `ToolLoopAgentSettings` does not type `onError`, but `ToolLoopAgent.prepareCall` spreads constructor settings into `streamText` | Checked: `node_modules/ai/dist/index.mjs` (ai 6.0.306)
- With `LLM_TELEMETRY=true`, the SDK's `recordErrorOnSpan` writes `error.message` onto the span; a `TypeValidationError` message quotes raw model output | Checked: `grep -n "function recordErrorOnSpan" -A 12 node_modules/ai/dist/index.mjs`
- `courses.total_xp` never receives mid-turn answer XP: only the baseline (`submitBaseline.persist.ts`) and `WAVE.completionXp` (`persistWaveClose.ts`) bump it. Nothing reads it yet | Checked: `rg -n incrementCourseXpInTx src`
- Live runs: `just --command env CEREBRAS_LIVE=1 NALU_SMOKE_QUIET=1 bunx vitest run --project live <file>`. One `wave.live.test.ts` run costs about $0.07. Agents symlink `.env.local` into their worktree and delete it after | Inherited

**Method.**
- Give one worktree agent per issue a self-contained brief: red test first, `just check`, push, PR, stop at green, report ONCE, do not poll CI. Ban closing keywords in commit messages.
- Run a separate read-only reviewer per branch. Send must-fixes and nits back to the author via SendMessage; self-review the fix commit with `git diff <old-head> origin/<branch>`.
- Run `just check` on a combined scratch tree before every `--admin` merge line, and confirm the tree equals main plus the PRs (`git diff --stat <main> $(git write-tree)`).

**Proof.** `just check` exits 0 on main, and `LLM_DEBUG_GRADINGS=1 just smoke` passes 9/9 (~$0.14).

## Current State

Ollie approved, verbatim: "give me the command to merge all of them. and go for all the fixes as you recommend." That covers #192's UI change (quiz card before the teaching text), #198 option (b), and #205 option (a).

Reviewed, green, combined `just check` passed (863 unit, 190 integration). Ollie's merge command, not yet run at handoff:

```
for n in 195 194 192 200 201 202; do gh pr checks $n --watch --fail-fast >/dev/null && gh pr merge $n --merge --delete-branch --admin || { echo "stopped at #$n"; break; }; sleep 5; done
```

| PR | Fixes |
|---|---|
| #195 `chore/knip-production` | #177 |
| #194 `refactor/context-message-kind-role-pair` | #108 |
| #192 `fix/quiz-tool-before-prose` | refs #164 #145 |
| #200 `test/provider-wire-import-cost` | #199 |
| #201 `fix/agent-stream-onerror` | #173 |
| #202 `refactor/comprehension-signal-type` | #119 |

In flight:

| PR | Fixes | State |
|---|---|---|
| #206 `refactor/sm2-schema-from-tuning` | #197, #210 | reviewed SHIP WITH NITS; author folding in the #210 fix (CHECK `>= 1.3::real`, red integration test, a new migration) |
| #209 `fix/mid-turn-correct-from-score` | #198 (b) | reviewed CHANGES NEEDED: move `verdictForQualityScore` to `src/lib/scoring/`, file the `AppliedGrading.isCorrect` follow-up; author fixing; conflicts with #202 in `waveTurn.ts` TSDoc and `comprehensionSignal.ts` (keep #202's deletion, rewrite the #198 sentence to "the Harness derives correctness from `qualityScore`") |
| #211 `fix/telemetry-span-error-text` | #204 | reviewed SHIP WITH NITS; author adding tool-call and retry span tests, moving `sdk-trace-base` |
| #212 `fix/course-total-xp-assessments` | #205 (a) | review running; delta rule under a row lock; conflicts with #209 in `persistWaveMidTurn.integration.test.ts` (keep both tests) |
| #203 `docs/status-pr-landing-sweep` | this file | merge last |

Issues filed this session: #196 #197 #198 #199 #204 #205 #207 (schema change with no migration goes unnoticed) #208 (`total_xp` backfill, deferred) #210 (bug: the easiness-factor CHECK rejects 1.3 because the column is `real`; a learner who fails a concept twice gets a failing Wave close).

## Next Steps

1. Send review nits back via SendMessage; self-review each fix commit; watch CI.
2. After Ollie's command lands: merge `origin/main` into #209 (resolve the #202 conflict), then #212 (resolve the #209 conflict), run a combined check, and give one merge command for #206 #209 #211 #212, then #203.
3. Tell Ollie: #206 adds a migration; run `just db-migrate` on prod after merge (after #107's count query).
4. Cleanup once merged: agent worktrees and `worktree-agent-*` branches (clean and ancestor of main, `git worktree unlock`, `git worktree remove` without force, `git branch -d`), `/tmp/nalu-land*`.
5. Unfiled observations: the close free-text grading never writes `assessments.user_answer`; `user_profiles.total_xp` has no writer (#154); `ai.response.providerMetadata` is always recorded on spans (check before #67); levers on #145 (reasoning as tool-call `content`, forced tool choice).

## Context for the Work

Ollie reads only the last message: BLUF, short sentences, restate every open ask. Ollie's standing words: "keep going, keep using subagents, coordinate and keep landing fixes and updates. Make sure you are following best practices for tool use with agents, and late 2026 best practices. Refactor or apply updates where not. Pydantic is a good reference, as well as the ai sdk."

Decisions Ollie made: `feat/corti-path-a` stays parked; #99 closed, summary to #93; #46 moved into `src/db/queries`; #62 keep `lastQuality`; #19 extract the Composer.

Security, verbatim: copy `.env.local` "without reading it". Never print it.

Ollie's open asks:
1. Run the merge command above.
2. Run the count query in #107's PR body on prod (must return 0), then `just db-migrate`; again after #206 merges.
3. Mark the GitGuardian incident from #127 a false positive.
4. Decide #58, #93, #94, #116, #143, #154.
5. Eyeball #125's UI on production.
6. Set the OTLP env vars in Vercel (#67); `LLM_TELEMETRY=true` only after #211 merges.

Live spend this session: about $3.4 (no live runs since the last batch).

## Restart Hint

Nothing local is at risk: every branch is pushed. Resume at Next Steps 1.

## Suggested Skills

`mattpocock-skills:code-review` for PR reviews, `superpowers:systematic-debugging` for a red smoke, `debugging-nalu-llm-pipeline` for a production failure.
