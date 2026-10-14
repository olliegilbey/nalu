# Task Pickup

You are picking up a coordination session that lands fix PRs on Nalu through subagents, keeps the issue tracker true, and brings the agent and tool-use code to late-2026 practice (AI SDK v6, with Pydantic AI as a reference design). The human is Ollie. He merges; agents stop at a green, reviewed PR.

## Orientation

- Main is at `bfc9f5c` or later. Merged in this sweep: #107 #111 #120 #122 #125-#128 #131 #135 #136 #138 #141 #148 #152 #153 #158 #160 | Checked | `gh pr list --state merged --limit 25`
- Ollie merges with `! gh pr merge N --merge --delete-branch`. Protection is strict (up to date with main), and `enforce_admins` is false. When several green PRs wait, merge the up-to-date one normally. Give `--admin` for the rest only after `just check` passes on a local tree of main plus all of them | Checked: `gh api repos/olliegilbey/nalu/branches/main/protection`
- The combined-tree check catches cross-PR breaks that each PR's own CI cannot. On 2026-10-13, #153 deleted `setCourseStartingState` while #158's new live test imported it; both were green alone | Checked: build it with `git checkout --detach origin/main && git merge <branches…>` in a scratch worktree, then `just check`
- I cannot run `gh pr merge` (permission-denied). SSH push works only while 1Password is unlocked; when it fails with "Permission denied (publickey)", give Ollie one batched `! git -C <worktree> push …` line. Never fall back to HTTPS or a token | Checked
- Live runs: `just --command env CEREBRAS_LIVE=1 NALU_SMOKE_QUIET=1 bunx vitest run --project live <file>` loads `.env.local` without printing it. Agents symlink `/home/ollie/code/nalu/.env.local` into their worktree and delete the symlink after. Never print it | Checked
- The full smoke on main `bfc9f5c` passed 9/9 (`LLM_DEBUG_GRADINGS=1 just smoke`, about $0.12). That is the proof for #140 | Checked: `/tmp/nalu-main-smoke2.log` (scratch, may be gone)
- A commit body that says "fixes #N" in any phrasing closes #N on merge. 5ac62e4 ("whoever fixes #58") closed #58 by accident; it is reopened. Write "the #N fix" or "Refs #N" in commit bodies | Checked: `gh api repos/olliegilbey/nalu/issues/58/timeline`
- The pre-commit hook fails green commits that run over 60s under load. One run took 170s (#143, needs Ollie). Agents wait a minute and retry | Checked
- Whether `.env.local` points at production is Open. Live tests use a testcontainer DB, so the smoke is safe either way.

**Method.**
- Give one worktree agent per issue a self-contained brief: red test first, `just check`, push, PR with `Fixes #N`, stop at green.
- Then run a separate read-only review agent (MUST-FIX vs NIT). Send nits back to the author via SendMessage. Re-review only when a must-fix changed code that guards a security invariant.
- File every follow-up as an issue before you move on.
- When an agent reports a model-behaviour caveat from one live run, run a small A/B against main (3 runs each) before you believe it.

**Proof.** `just check` exits 0 on main, and `LLM_DEBUG_GRADINGS=1 just smoke` passes 9/9.

## Current State

| PR / branch | Fixes | State |
|---|---|---|
| #161 `fix/midline-json-leak` | #156 | green, up to date, two review rounds; waiting on Ollie's merge |
| `test/wave-close-grading-live` | #22 (last gap) | author agent running |
| `docs/drift-sweep` | audit drift | this doc plus 9 doc fixes; PR next |

- The agent tool-use audit is committed: `docs/superpowers/specs/2026-10-13-agent-tool-use-audit.md`. Done: F1/#140, F2 (in #158), F3/F4 (#144 via #160). Deferred: #145 (probe session), #146 (prompt_cache_key), #147 (tool-error replay), F9 (a comment on #123).
- #22: scoping-close free-text gradings are q=5 with XP. The Wave close is untested with a correct answer: the smoke shows `wave-close gradings=0`. The running agent extends `wave.live.test.ts` to close it.
- #156/#161 design: the gate's secret check matches the tool's own field names (`"freetextRubric":`, or `"correct":` with `"conceptName":`), fence-blind. The envelope check skips code. Known gaps: #159 (a fenced dump streams for a moment) and invented field names.
- Issues opened in this sweep: #129 #130 #132-#134 #137 #139 #140 #142-#151 #154-#157 #159. Reopened: #58.

## Next Steps

1. Open the `docs/drift-sweep` PR; get it and #161 merged.
2. Review the #22 PR when its agent reports, and send nits back. If it says `Fixes #22`, check that all three live runs graded q≥4.
3. The drift audit left four suspects. Weigh each before acting:
   - `docs/ARCHITECTURE.md:101` claims no raw SQL outside `queries/`, but `reset.ts` runs `DROP SCHEMA`.
   - Three components are over the 150-line rule in `src/components/CLAUDE.md`: WaveSession (206), Onboarding (194) and SideMenu (168).
   - `src/server/routers/CLAUDE.md:7` gives hypothetical split paths.
4. Cleanup at the end: finished agents' worktrees and branches, `/tmp/nalu-land3` (`git worktree remove`), and the `/tmp/nalu-*` scratch files.

## Context for the Work

Ollie reads only the last message: BLUF, short sentences, restate every open ask. His standing words: "keep going, keep using subagents, coordinate and keep landing fixes and updates. Make sure you are following best practices for tool use with agents, and late 2026 best practices. Refactor or apply updates where not. Pydantic is a good reference, as well as the ai sdk."

Decisions Ollie made: `feat/corti-path-a` stays parked; #99 closed, summary to #93; #46 moved into `src/db/queries` (#141); #62 keep `lastQuality`; #19 extract the Composer (#135).

Security, verbatim: copy `.env.local` "without reading it". Never print it.

Ollie's open asks:
1. Run the count query in #107's PR body on prod (must return 0), then `just db-migrate`.
2. Mark the GitGuardian incident from #127 a false positive.
3. Decide #58, #93, #94, #116, #143, #154.
4. Eyeball #125's UI on production.
5. Set the OTLP env vars in Vercel (#67).

## Restart Hint

Nothing local is at risk: every branch is pushed or held by a running agent's worktree. Resume at Next Steps 1.

## Suggested Skills

`mattpocock-skills:code-review` for PR reviews, `superpowers:systematic-debugging` for a red smoke, `debugging-nalu-llm-pipeline` for a production failure.
