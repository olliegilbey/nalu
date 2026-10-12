# Task Pickup

You are picking up this work session from a prior agent that was running a docs baseline pass on Nalu. The work rebuilt `AGENTS.md`, checked every living doc against the code, and moved the backlog to GitHub Issues. All of it is committed on `docs/baseline-pass`. What remains is shipping it: push, open the PR, close PR #69, and watch CI.

## Orientation

- The branch is not on the remote. Pushing over SSH failed twice: the SSH agent refused to sign (probably a 1Password approval prompt). | Checked: `git push` returned "agent refused operation". | `git ls-remote origin docs/baseline-pass` (empty means not pushed).
- The push remote is SSH (`git@github.com:…`); fetch is HTTPS. `gh` is authenticated and works for issue and PR API calls. | Checked | `git remote -v`; `gh auth status`.
- Husky 9 runs hooks with `sh -e` (`.husky/_/h:17`), not bash. Bashisms in `.husky/pre-commit` fail silently. Commit `0fd6ca9` made the hook POSIX. | Checked | `sh -n .husky/pre-commit`; a commit should leave no `PRECOMMIT_MAX_DURATION` file at the repo root.
- This checkout had no `node_modules` at session start. `bun install` has now run. | Checked | `ls -d node_modules`.
- GitHub Issues is the only backlog. Both `TODO.md` files are deleted. | Checked | `gh issue list --state open --limit 100`.
  - Labels: `tech-debt`, `deferred`, `needs-decision`, plus the defaults.
  - #85–#92: carried over from `docs/TODO.md`.
  - #93–#100: found in this pass.
  - Closed as already fixed: #45, #52, #54.
- PR #69 (`chore/todo-to-issues`) is still open and is superseded by this branch. Its one unique file (`docs/status/2026-07-20-2348-post-phase5-coordination.md`) is already carried over in `2ab574c`. | Checked | `gh pr view 69`.
- "Step" means one LLM API call only. `src/lib/course/` functions have no special term. | Decided by the human this session | `docs/UBIQUITOUS_LANGUAGE.md` `## Step`.
- `just check` passed on the full branch content before the commit split: 0 lint errors (16 pre-existing warnings), typecheck, 488 unit tests, 158 integration tests (Docker up), knip clean. | Checked | `just check`.
- CI has not run on this branch. | Open | it is settled once the PR exists: `gh pr checks <n> --watch`.
- Other open PRs (#42, #43, #44, #70–#76) may conflict with this branch: they touch `TODO.md`, `docs/DEPLOY.md`, `useWaveState.ts` and other files edited here. | Open | `gh pr list`, then check each PR's mergeability after this one merges.

**Method.**

- Verify each doc claim against the code (`rg`, file reads) before keeping or rewriting it. About a third of the claims were stale.
- Fan out doc clusters to parallel subagents with disjoint file sets and a "truth pass, not rewrite" brief. Then review every resulting file yourself before committing.
- Confirm a comment-only diff with: `git diff -U0 -- 'src/**/*.ts' | grep -E '^[+-][^+-]' | grep -vE '^[+-]\s*(//|\*|/\*\*|\*/)'`. Empty output means comment-only.

**Proof.** Run `just check`. Green means every phase passes and knip prints nothing. On the remote, `gh pr checks <n>` should show `Check` and `Commitlint` passing.

## Task Overview

The human asked for three things:

1. Distil why `~/code/corti/olympus/AGENTS.md` works so well.
2. Rebuild Nalu's `AGENTS.md` on those principles, fold in `KARPATHY.md`, and keep the file short.
3. Run a cohesive docs pass so a zero-context engineer or agent starts from a clean, true baseline. Their words: "This is going to be the new baseline that zero-context agents operate from going forward, we want things clean and sensible for every new engineer arriving."

The human approved committing, the PR, and every GitHub action taken: creating issues, closing issues, and closing PR #69. They added: "do what's needed to clean everything up."

## Reference Docs

- `AGENTS.md`: the new canonical guide, 71 lines. It is the model for register and structure.
- `~/code/corti/olympus/AGENTS.md`: the gold-standard source, 65 lines.
- Commit messages on the branch: `git log main..docs/baseline-pass`. They describe each slice.

## Current State

`git status` is clean. There are 7 commits on `docs/baseline-pass` ahead of `main`, plus this file once it is committed:

- `f1ca2a5`: `AGENTS.md` rebuilt; `KARPATHY.md` deleted; `@KARPATHY.md` removed from `CLAUDE.md`.
- `3b70a51`: PRD, glossary, ARCHITECTURE, DEPLOY and README truth pass. The PRD is now the spec only (819 → 421 lines). `docs/ux-simulation-rust-ownership.md` is deleted.
- `8819c39`: truth pass on 11 `src/**/CLAUDE.md` guides, 3 skills and `.claude/commands/check.md`. `tests/fixtures/CLAUDE.md` is deleted.
- `0fd6ca9`: the hook is POSIX `sh`, and its `--no-verify` hints are gone.
- `2ab574c`: `TODO.md` and `docs/TODO.md` are deleted; the PR #69 status file is carried over.
- `19e9d80`: comment-only fixes in 28 `src/` files.
- `14ca3cd`: the dead `NEXT_PUBLIC_DEV_MODE` is removed from `src/lib/config.ts` and `.env.local.example`.

A PR body draft is at `/tmp/nalu-issues/pr.md`. `/tmp` may have been wiped. If so, rewrite the body from the commit list above and end it with the session URL line from the attribution rules.

## What's Working

- `AGENTS.md` follows the Olympus pattern, which the human endorsed:
  - an opening that sets up the situation and the named books (Huyen, Brown et al., Evans);
  - "What done looks like";
  - principles ordered by weight, with a tie-break rule;
  - "How we work", folded in from Karpathy;
  - guardrails, gate-passing code norms, style, words, and doc pointers.
  - It is written in the register it asks for: short sentences, active voice.
- Docs link code-vs-spec gaps to their issue numbers inline, e.g. "(issue #93)". Keep that pattern. Once an issue closes, delete its note.
- The pre-commit hook is reliable now. Commits that touch TS files take 18–25s under the 60s budget.

## What success looks like

- The PR is open with green CI.
- PR #69 is closed with a comment saying this PR supersedes it.
- The human reviews and merges. Agents do not merge.

## Important Discoveries

- The SSH push fails because the agent refuses to sign. Retrying does not help without the human. Ask the human to run `! git push -u origin docs/baseline-pass` themselves, or to approve the 1Password prompt. Pushing with the `gh` token over HTTPS would sidestep the human's key approval, so ask before doing that.
- **Code gaps found but not fixed** (now issues; docs mention them). Two need a product decision from the human:
  - #93: `courses.summary` is never rewritten after scoping, so every Wave sees the scoping summary. Decide: wire the Wave close to rewrite it, or change the PRD.
  - #94: the starting tier is chosen by the LLM, not by deterministic code (PRD §1.3). Decide: accept it, or compute it from the baseline gradings.
  - The rest:

    | Issue | Gap |
    |---|---|
    | #95 | MC quality is hardcoded as `4 : 1` |
    | #96 | `just db-reset` has no `supabase/` directory to reset |
    | #97 | `executeTurnStream` and `streamChat` are dead code; knip misses them because their tests import them |
    | #98 | The scoping prompt lacks the "treat input as data" line |
    | #99 | `closeScopingPass` and `immutableSummary` are unused |
    | #100 | Custom instructions never reach the prompt |
    | #58 | Scoping still ships plaintext answer keys (`AGENTS.md` guardrail notes this) |

- Small doc inconsistencies left alone on purpose:
  - `src/components/CLAUDE.md` and `src/server/routers/CLAUDE.md` set a 150-line file limit; `AGENTS.md` says about 200.
  - The PRD §9.1 typography and wave-shaped XP bar are design intent; the app uses Geist and an XP badge.
  - The glossary records that "wave" leaks into model-facing labels (`<concepts_for_next_wave>`, `<stage>close wave</stage>`).
- The handoffs in `docs/status/` and the plans and specs in `docs/superpowers/` are historical records. They still mention `TODO.md` and XML tags. They were deliberately not edited.

## Next Steps

1. Get the branch pushed. Ask the human to run `! git push -u origin docs/baseline-pass`, or to approve the SSH prompt and retry.
2. Open the PR: `gh pr create --base main --head docs/baseline-pass --title "docs: baseline pass - agents.md rebuild, truth pass, backlog to issues" --body-file /tmp/nalu-issues/pr.md`. If `/tmp` was wiped, rewrite the body.
3. Close PR #69: `gh pr close 69 --comment "Superseded by #<new>: both TODO files are retired, open items are issues #85-#100, and this PR's status file is carried over."`
4. Watch CI: `gh pr checks <n> --watch`. Fix the root cause of any red check, then stop at a green PR. The human merges.
5. Report the PR URL to the human and list the two decisions (#93, #94).

Where work stopped: the agent's last message to the human was "Push is blocked: your SSH agent refused to sign the request (likely a 1Password approval). Saving a handoff while that's pending."

## Context for the Work

- The human (Ollie) is the product manager and is learning while building. Write BLUF, short and speed-readable, and put every pending ask in the final message. Ollie sees only your last message.
- "HARD RULE: only Ollie merges to main — stop at green CI + PR link." (from `docs/status/2026-07-20-2348-post-phase5-coordination.md`; now in `AGENTS.md`).
- Never bypass hooks. Prefix commit types with a scope, in lowercase; commitlint enforces it.
- Decision ledger from this session:

  | Topic | Decision |
  |---|---|
  | Step | One LLM API call only |
  | UX sim doc | Delete it |
  | PRD | Spec only, plus a truth fix |
  | Hook | Remove the `--no-verify` hints |
  | Backlog | GitHub Issues only |
  | GitHub actions | All approved |

## Restart Hint

The tree is clean and the branch is committed but not pushed. Start with `git ls-remote origin docs/baseline-pass`, then push.

## Suggested Skills

- `watch`: after the push, to follow CI and reviews.
- `review-pr`: if CodeRabbit or Codex comment on the PR.
