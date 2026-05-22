# Status — UI fixes + kanagawa-whispers reference merge

**Date:** 2026-05-21 22:26
**Branch:** `feat/ui-fixes-reference-merge` · **HEAD:** `ebf490c`
**Worktree:** `/Users/olliegilbey/code/nalu/.claude/worktrees/ui-fixes-reference-merge`

## Task Overview

Fix UI quirks in Nalu and port four features from the reference UI repo
`../kanagawa-whispers`. Six changes total:

1. **Splash screen** — full-screen intro overlay on the home screen.
2. **No back-up/resubmit in a questionnaire** — answered steps lock.
3. **XP tracker + animation** — a header XP badge replaces the sonner XP toast.
4. **Course title** in the chat header.
5. **Submission hang fix** — optimistic render of the user's message + spinner.
6. **Duplicate "or type your own answer"** — keep only the textarea placeholder.

Brainstormed → spec → plan → executing via the `superpowers:subagent-driven-development`
skill (fresh implementer subagent per task, then a spec-compliance reviewer, then
a code-quality reviewer). Decisions taken with the user: splash shows on every
home visit; optimistic fix applies everywhere incl. the home topic box; XP badge
is a client-side per-course localStorage counter (MC XP computed exactly via
`calculateMcXp`, free-text/completion XP from server grading).

## Reference Docs

- **Plan:** `docs/superpowers/plans/2026-05-21-ui-fixes-reference-merge.md` — the
  authoritative working doc. Each `## Task N:` section carries full code + steps.
  Remaining work:
  - Task 11 `Splash` — lines 1231-1318 (code already committed; review pending).
  - Task 12 `useWaveState` XP+topic — lines 1320-1508.
  - Task 13 `WaveSession` — lines 1510-1625.
  - Task 14 `Onboarding` + `useScopingState` — lines 1627-1758.
  - Task 15 `TopicInput` splash mount + optimistic — lines 1760-1866.
  - Task 16 Full verification — lines 1868-end.
- **Spec:** `docs/superpowers/specs/2026-05-21-ui-fixes-and-reference-merge-design.md`
  — design rationale. The nuanced parts: Feature 3 XP timing model (lines 87-194),
  Feature 5 optimistic submit (lines 215-248).
- **Reference repo:** `/Users/olliegilbey/code/kanagawa-whispers` @ `origin/main`
  (`6f9de2e`) — the source of the ports (`src/components/chat/Splash.tsx`,
  `ChatHeader.tsx`, `Composer.tsx`, `styles.css`). Already fast-forwarded (Task 1).

## Current State

`git status` clean. `git diff --stat HEAD` empty. 362 unit tests green;
`just typecheck`, `just lint`, `just build` all pass from the worktree.

**13 commits on the branch** (base `1209109` = `main` at branch creation):

| SHA       | Task                                                   |
| --------- | ------------------------------------------------------ |
| `14b5462` | docs(spec)                                             |
| `f6e6c2c` | docs(plan)                                             |
| `084b8d6` | T2 — CSS animations (`globals.css`)                    |
| `b7af4ca` | T3 — project per-question `tier` to client wire        |
| `3002af5` | T4 — `topic` on `WaveState` (`getWaveState.ts`)        |
| `2ba9197` | T5 — `useCourseXp` hook + test                         |
| `d8220eb` | T6 — `formatComposerAnswers` helper + test             |
| `676b512` | T7 — Composer: remove duplicate prompt                 |
| `5b98f9c` | **build fix** — pin `turbopack.root` (see Discovery 1) |
| `ca34b5b` | T8 — Composer: lock answered steps                     |
| `a7b0b24` | T9 — Composer: exact MC XP via `calculateMcXp`         |
| `0fb46ee` | T10 — XP badge in `ChatHeader` + `ChatShell`           |
| `ebf490c` | T11 — `Splash` component                               |

**T1–T10 + the build fix are fully done** (each passed spec-compliance AND
code-quality review). **T1** also fast-forwarded the reference repo (no Nalu
commit). **T11** is committed (`ebf490c`) but its two-stage review has NOT been
done — that is the first action below.

Task tracker (TaskList): T1–T10 completed; T11 in_progress (implemented, review
pending); T12–T16 pending.

## Important Discoveries

1. **Turbopack workspace root (build fix, `5b98f9c`).** The worktree is nested
   inside the main repo; both have `bun.lock`. Next.js 16 inferred the _outer_
   lockfile's dir as the workspace root and compiled the **main repo's**
   `src/proxy.ts` (which imports `@supabase/ssr`, absent from this branch) —
   `just build` failed on a file not even on this branch. Fixed by adding
   `turbopack: { root: import.meta.dirname }` to `next.config.ts`. `just build`
   only works from the worktree because of this. Do not remove it.

2. **Bun/jsdom `localStorage` is broken in this repo's test env.** `window.localStorage`'s
   methods (`getItem`/`setItem`/`clear`/…) are `undefined` — Bun's native
   `--localstorage-file` stub shadows jsdom's working implementation. T5's
   `src/hooks/useCourseXp.test.ts` works around this with an in-memory
   `MemoryStorage` polyfill installed in `beforeEach` (with narrow
   `eslint-disable functional/immutable-data` comments on its mutating lines).
   **⚠ T12 GAP:** the plan's Task 12 Step 1(a) tells you to add
   `window.localStorage.clear()` to `useWaveState.test.tsx`'s `beforeEach` — that
   WILL NOT WORK. `useWaveState` now uses `useCourseXp` (localStorage), and the
   T12 tests assert XP persistence. The T12 implementer must instead **extract
   the `MemoryStorage` polyfill from `useCourseXp.test.ts` into a shared test
   helper** (e.g. `src/lib/testing/memoryStorage.ts` — `src/lib/testing/` already
   exists), have `useCourseXp.test.ts` import it, and use it in
   `useWaveState.test.tsx`. Spell this out in the T12 implementer dispatch.

3. **1Password commit-signing locks after inactivity.** Git commit signing goes
   through the 1Password agent; after a while it errors (`1Password: agent
returned an error` / `failed to fill whole buffer` → `fatal: failed to write
commit object`). Resolution: user unlocks 1Password (may need a full app
   restart, not just unlock). NEVER bypass signing or use `--no-verify`.

4. **Subagent CWD mishaps.** Because the worktree is nested in the main repo,
   subagents have twice resolved relative paths against the MAIN repo instead of
   the worktree (T6 implementer's `Write`; T9 reviewer's `just typecheck` showed
   phantom `@supabase/ssr` errors from the main repo). Always instruct subagents
   to use ABSOLUTE paths and state the worktree is the working directory.

5. **`main` advanced mid-session.** The other agent's `feat/anonymous-auth` merged
   into `main` (`62287ac`) — added `src/proxy.ts` + `@supabase/*` deps. This
   branch is based on the older `main` (`1209109`). No rebase needed: the changes
   are disjoint; merge normally at the end. Do NOT touch the main repo or the
   `feat/anonymous-auth` worktree.

6. **`v3Question.tier` already existed** (optional) — T3 just projected it through
   the wire types. `calculateMcXp(tier, true) === tier * 10`.

7. **No chat-component unit tests exist** in this project — `Composer`/`ChatHeader`/
   `ChatShell`/`Splash`/`WaveSession`/`Onboarding`/`TopicInput` changes are verified
   by `just typecheck && just lint && just build` only. Hooks and pure functions
   ARE unit-tested (TDD). Do not add chat-component test harnesses (the plan
   deliberately omits them).

## Next Steps

In priority order. Continue with `superpowers:subagent-driven-development`.

1. **Review T11** (`ebf490c`, `Splash.tsx`). Dispatch a spec-compliance reviewer
   then a code-quality reviewer. BASE `0fb46ee`, HEAD `ebf490c`. It is a verbatim
   port of plan Task 11 Step 1 — low risk, but complete the review loop.
2. **T12** — `useWaveState` XP + topic (plan 1320-1508). **Apply Discovery 2** —
   do not blindly follow Step 1(a)'s `window.localStorage.clear()`; extract the
   shared `MemoryStorage` test helper.
3. **T13** — `WaveSession` XP/title/optimistic (plan 1510-1625).
4. **T14** — `Onboarding` + `useScopingState` (plan 1627-1758).
5. **T15** — `TopicInput` splash mount + optimistic (plan 1760-1866).
6. **T16** — full verification: `just check` + `just build`, then the manual
   checklist (plan 1868-end). Manual steps need `just dev` (Touch ID).
7. After all tasks: a final whole-branch code review, then
   `superpowers:finishing-a-development-branch` to decide merge/PR.

Per-task cycle: implementer subagent (model **opus**) → spec reviewer (opus) →
code-quality reviewer (opus) → mark complete. Provide each implementer the FULL
task text from the plan + scene-setting context; do not make them read the plan.

VERBATIM — the exchange where work stopped (user, then the retry result):

> "try the signing again, then we need to also need to checkpoint our progress for a new agent to pick up with a /wrap-up"

> "try the signing again, sorry I wasn't paying attention"

→ Signing retried successfully; T11 committed as `ebf490c`. Stopped here for this
handoff. T11 review + T12–T16 remain.

## Context to Preserve

- **Communication:** extremely concise; sacrifice grammar for brevity.
- **Commits:** conventional commits, **lowercase subject** (commitlint rejects
  uppercase/sentence-case). Never `--no-verify`, never bypass git hooks or
  commit signing. Ask before commits/PRs, destructive ops, architecture choices.
- **Subagent model:** Opus 4.7 for both implementers and reviewers.
- The worktree was chosen deliberately because another agent is active in the
  repo on `feat/anonymous-auth`. Keep work isolated; do not touch the main repo.
- The user approved the spec + plan, including the XP refinement (exact
  `calculateMcXp` for correct MC answers, server-graded XP for free-text).
- `just dev` / `just smoke` need Touch ID (`op run`); `just check` / `just build`
  / `just test` do not (unit tests are mocked).
- Worth a future memory: the Bun/jsdom `localStorage` quirk (Discovery 2) and
  the nested-worktree Turbopack-root issue (Discovery 1) are non-obvious repo
  gotchas.

## Restart Hint

Working tree clean, branch at `ebf490c`, all checks green — safe to resume.
If resuming from a fresh session, enter the worktree first
(`/Users/olliegilbey/code/nalu/.claude/worktrees/ui-fixes-reference-merge`).
Pick up at Next Step 1: review T11, then T12.
