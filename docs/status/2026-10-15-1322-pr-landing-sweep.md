# Task Pickup

You are picking up a coordination session that lands fix PRs on Nalu through subagents, keeps the issue tracker true, and brings the agent and tool-use code to late-2026 practice (AI SDK v6, with Pydantic AI as a reference design). The human is Ollie. Ollie merges; agents stop at a green, reviewed PR.

## Orientation

- Main is at `d769cf3` or later. Merged on 2026-10-15: #183 #184 #185 #186 #188 #189 #190 #193 | Checked | `gh pr list --state merged --limit 15`
- The GitHub token (fine-grained PAT in `~/.config/gh/hosts.yml`) lost write access mid-session: `gh pr create` and `gh issue create` return 403 "Resource not accessible by personal access token". Reads work. Ollie's `gh` uses the same token | Open: retry one `gh issue create` dry write only after Ollie says the token is fixed | `gh auth status`
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

Open PRs, all reviewed and green:

| PR | Closes | Merge |
|---|---|---|
| #195 `chore/knip-production` | #177 | normal (up to date) |
| #194 `refactor/context-message-kind-role-pair` | #108 | `--admin` after #195 |
| #192 `fix/quiz-tool-before-prose` | refs #164 #145 | `--admin`; waits on Ollie's UI yes |

Pushed, reviewed, no PR yet (the token cannot open PRs). Body files are in `/tmp`:

| Branch | Closes | Head | Body |
|---|---|---|---|
| `fix/agent-stream-onerror` | #173 | `30485d5` | `/tmp/pr-173.md` |
| `refactor/comprehension-signal-type` | #119 | `67a54be` | `/tmp/pr-119.md` |
| `test/provider-wire-import-cost` | #199 | `785633e` | `/tmp/pr-199.md` |

Issues drafted but not filed (token): `/tmp/nalu-issue-span-leak.md` (telemetry spans record raw error messages; blocks `LLM_TELEMETRY=true` in #67), `/tmp/nalu-issue-total-xp.md` (`courses.total_xp` misses mid-turn XP).

Issues filed this session: #196 (`deferred`, derive `role` from `kind`), #197 (`tech-debt`, SM-2 default and floor duplicated in the schema), #198 (`needs-decision`, mid-turn verdict and `qualityScore` not tied), #199 (`tech-debt`, the flaky `provider.test.ts` wire test).

`just check` passed on main plus #195, #194, #192 and the #199 fix (858 unit, 190 integration). A six-branch check (adding #173 and #119) was running at handoff.

## Next Steps

1. When Ollie restores PR and Issues write, open the three PRs from the table and file the two drafted issues. Watch CI.
2. After each merge, merge `origin/main` into the next stale branch, or give `--admin` after a combined check.
3. Cleanup once merged: the `.claude/worktrees/agent-*` dirs and `worktree-agent-*` branches for these branches (check clean and ancestor of main, then `git worktree unlock`, `git worktree remove` without force, `git branch -d`), and `/tmp/nalu-land*`.
4. Open levers on #145: reasoning sent as the tool-call message's `content` reaches gpt-oss and needs its own probe; forced tool choice is untested.
5. Possible issue: Wave prose often restates the quiz question the card already shows (both arms of #192's A/B).

## Context for the Work

Ollie reads only the last message: BLUF, short sentences, restate every open ask. Ollie's standing words: "keep going, keep using subagents, coordinate and keep landing fixes and updates. Make sure you are following best practices for tool use with agents, and late 2026 best practices. Refactor or apply updates where not. Pydantic is a good reference, as well as the ai sdk."

Decisions Ollie made: `feat/corti-path-a` stays parked; #99 closed, summary to #93; #46 moved into `src/db/queries`; #62 keep `lastQuality`; #19 extract the Composer.

Security, verbatim: copy `.env.local` "without reading it". Never print it.

Ollie's open asks:
1. Restore Pull requests and Issues write on the token, or open the PRs and issues above by hand.
2. Merge #195, then #194, then #192.
3. Say whether the quiz card may appear before the teaching text (#192). Recommendation: yes, it works like a pretest. It changes `docs/PRD.md:267`.
4. Decide #198. Recommendation: (b), the Harness derives `is_correct` from `qualityScore`.
5. Run the count query in #107's PR body on prod (must return 0), then `just db-migrate`.
6. Mark the GitGuardian incident from #127 a false positive.
7. Decide #58, #93, #94, #116, #143, #154.
8. Eyeball #125's UI on production.
9. Set the OTLP env vars in Vercel (#67), with `LLM_TELEMETRY` off until the span leak is fixed.

Live spend this session: about $3.4 (no live runs since the last batch).

## Restart Hint

Nothing local is at risk: every branch is pushed. Resume at Next Steps 1 once the token can write.

## Suggested Skills

`mattpocock-skills:code-review` for PR reviews, `superpowers:systematic-debugging` for a red smoke, `debugging-nalu-llm-pipeline` for a production failure.
