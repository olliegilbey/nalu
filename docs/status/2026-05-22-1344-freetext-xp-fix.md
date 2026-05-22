# Status — Free-text XP fixes + land PR #17

**Date:** 2026-05-22 13:44
**Branch:** `feat/ui-fixes-reference-merge`
**Worktree:** `/Users/olliegilbey/code/nalu/.claude/worktrees/ui-fixes-reference-merge`
**PR:** https://github.com/olliegilbey/nalu/pull/17 (open, `MERGEABLE`)

## Task Overview

Two jobs, in order:

1. **Fix two free-text XP bugs** (diagnosed below — root cause is found, do NOT
   re-investigate). Correct free-text questionnaire answers do not award XP.
   Implement both fixes with TDD where the code is testable.
2. **Get PR #17 merged.** It is a large branch (UI QA fixes round 2 + the
   earlier UI batch + a Kanagawa reference merge + a scoping-XP feature). All
   automated review feedback is already addressed. After the XP fixes land,
   the remaining gate is CI + a manual walkthrough.

Success: both XP bugs fixed (free-text correct answers move the header badge),
`just check` + `just build` green, pushed, PR review threads clean.

## Reference Docs

- `docs/superpowers/plans/2026-05-22-ui-qa-fixes.md` — the round-2 plan (already
  fully executed; read only for background on the UI batch).
- `docs/superpowers/specs/2026-05-22-ui-qa-fixes-design.md` — round-2 design.
- @docs/status/2026-05-22-1106-ui-qa-fixes.md — prior handoff; round-2 execution
  context and the original 8 QA issues. Round-2 is DONE; this file supersedes it.

## Current State

**Working tree: clean. Everything committed and pushed.** `git log main..HEAD`
top commits:

```
6e7414e fix(ui): hide the native scrollbar on the chat scroll area
728b09b Merge remote-tracking branch 'origin/main' ...
6ffd724 feat(scoping): show XP badge and award baseline MC XP
39d62fe fix: address PR review feedback from Codex and CodeRabbit
8905f7b fix(errors): use colon separator in error toasts
... (round-2 + earlier UI batch commits below)
```

Verified green at last check: `just typecheck` clean, `just lint` 0 errors
(14 pre-existing warnings), `just test` 387 passing (54 files), `just build` OK.
Integration tests (`test-int`) run in CI (need Docker; unavailable locally).

GH follow-up issues already filed (out of scope for this PR): **#18** (MC-via-
free-text-escape XP undercount), **#19** (extract Composer logic to `src/lib`),
**#20** (split `useWaveState.ts` under 200 lines).

## Important Discoveries

### THE BUG DIAGNOSIS — root cause found, fully traced. Do not re-investigate.

Symptom: a correct **free-text** questionnaire answer does not award XP; the
header XP badge does not move even after the server round-trip. Correct **MC**
answers DO award XP. The LLM _is_ grading free-text, and the XP _is_ computed
and persisted server-side — it just never reaches the `useCourseXp` display
counter. There are **two distinct defects**:

**Bug 1 — Wave final-turn free-text XP is dropped (PLUMBING BUG).**

- A wave turn routes to `executeWaveMid` when `turnsRemaining > 0`, else to
  `executeWaveClose` (`submitWaveTurn.ts` ~196-199).
- `useWaveState.ts` `submitTurn` `onSuccess` has two branches:
  - `result.kind === "mid-turn"` (≈ lines 94-101) — correctly sums
    `gradedSignals.filter(kind === "free-text").reduce(+xpAwarded)` into
    `courseXp.addXp`. **Mid-wave free-text works.**
  - `else` = close-turn (≈ lines 102-114) — adds **only**
    `result.completionXpAwarded` and fires the tier-up toast. It **never reads
    `result.gradedSignals`.** Free-text (and MC) XP graded on the wave's final
    turn is silently dropped on the client.
- `executeWaveClose` DOES return `gradedSignals: readonly PersistedGradedSignal[]`
  on the `close-turn` result; `PersistedGradedSignal = { kind, questionId,
xpAwarded }`. The data is there — the client branch just ignores it.
- MC on the close turn looks fine only because MC is also counted instantly
  client-side at confirm time (Composer `onCorrectAnswer`/`awardMcXp`).

**Bug 2 — Scoping baseline free-text XP was never wired (MISSING WIRING, 2 layers).**
This is almost certainly the bug the user actually observed (they were in the
scoping flow — baseline questionnaire, "to Wave 1" button).

- Server: `submitBaseline` (`src/lib/course/submitBaseline.ts`) grades free-text
  via the LLM close turn; `mergeAndComputeXp` (`src/lib/course/baselineMerge.ts`
  ~88-91) computes a single deterministic `totalXp` over ALL baseline questions
  via `calculateXP(startingTier, qualityScore)`. `persistScopingClose`
  (`submitBaseline.persist.ts` ~205-212) bumps `courses.total_xp` by
  `merged.totalXp`. **But `SubmitBaselineResult` (`submitBaseline.ts` ~26-31) is
  only `{ userMessage, wave1Id }` — the XP is never returned to the client.**
- Client: `useScopingState.ts` never calls `useCourseXp`; `submitBaseline`'s
  mutation `onSuccess` is just `invalidateState`. `Onboarding.tsx` calls
  `useCourseXp` directly but only passes `onCorrectAnswer` to the Composer
  (instant MC XP). **No path feeds scoping free-text XP into the badge counter.**
- The scoping-XP feature (commit `6ffd724`) shipped only the _instant MC_ half;
  the free-text half was never built.

**Not bugs (do not "fix"):** Wave mid-turn free-text plumbing is correct end to
end. `calculateXP` correctly returns 0 for quality scores q0/q1 (deliberate
anti-gaming). The `kind` discriminant is the exact string `"free-text"`
everywhere (`waveTurn.ts:29`, `closeTurn.ts:30`, `applyAssessmentGrading.ts:19`,
`useWaveState.ts` filter) — no string mismatch anywhere.

### Fix plans

**Fix 1 (wave) — small, client-only, no design question.**
In `useWaveState.ts` close-turn branch (`else` of the `onSuccess`), mirror the
mid-turn branch: compute `freeTextXp` from `result.gradedSignals` filtered to
`kind === "free-text"`, and call `courseXp.addXp(result.completionXpAwarded +
freeTextXp)` as a single combined pulse. Do NOT sum `mc-index` signals — MC on
the close turn is already counted client-side (would double-count). Verify
`result.gradedSignals` is accessible on the close-turn result type via
`just typecheck`.

**Fix 2 (scoping) — server + client, ~5-6 files.**
Return the **free-text XP subtotal ONLY** from `submitBaseline`, then add it to
the badge on submit success. CRITICAL: do NOT return `merged.totalXp` — that
includes MC XP, which is already counted instantly client-side via
`onCorrectAnswer`; returning the total would double-count MC.

- `baselineMerge.ts` — alongside `totalXp`, compute a free-text-only subtotal
  (sum `calculateXP(...)` over the free-text questions only). Update its
  colocated test (pure function, TDD).
- `submitBaseline.ts` — add the subtotal to `SubmitBaselineResult` (e.g.
  `freeTextXpAwarded`); include it in the return.
- Router `src/server/routers/course.ts` — forward the new field (check if the
  router re-declares an output schema; if it just returns the lib result,
  no change).
- `useScopingState.ts` — `submitBaselineAnswers` already takes a per-call
  `opts?: { onError? }`. Add `onSuccess?: (result) => void` symmetrically and
  forward it to `submitBaseline.mutate(..., { onSuccess, onError })`.
- `Onboarding.tsx` — in `onComplete`, pass `onSuccess: (result) =>
courseXp.addXp(result.freeTextXpAwarded)` for the baseline branch.

Note: a baseline MC answered by _typing_ (free-text escape) still won't get
client XP (instant path skipped because typed; server subtotal excludes it as
`kind: mc`). That is issue **#18**'s class of bug — leave it; do not expand scope.

### Other discoveries from this session

- Merge conflict with `main` was resolved in `728b09b`: `.claude/settings.json`
  — `context-budget-monitor` is dead/renamed to `rot-reducer`; final state is
  `superpowers` + `rot-reducer` only. User confirmed this is correct.
- After the merge, `bun install` was needed — `main` added `@supabase/ssr` +
  `@supabase/supabase-js`. If `just dev` shows `Can't resolve '@supabase/ssr'`,
  run `bun install`.
- The XP badge stale-after-hydration fix (`39d62fe`): adding `xp` to the
  `XpBadge` effect deps trips the `react-hooks` setState-in-effect rule — the
  fix was to _derive_ `displayed` from `xp`, not store it. Don't reintroduce a
  setState-in-effect that copies a prop.
- `useCourseXp` is a localStorage-backed, courseId-keyed, NON-authoritative
  display counter. Scoping and wave both read the same key, so scoping XP
  carries into the wave flow. Server `totalXp` is the source of truth.

## Next Steps

1. **Fix 1 (wave close-turn free-text XP)** — `useWaveState.ts`. Small. If a
   hook test is feasible (`useWaveState.test.tsx` exists), add one; otherwise
   verify by typecheck/lint/test and note the manual check.
2. **Fix 2 (scoping baseline free-text XP)** — server + client per the plan
   above. TDD the `baselineMerge.ts` subtotal.
3. `just check` + `just build` green; commit (suggest one `fix:` commit for the
   wave fix, one `fix(scoping):`/`feat(scoping):` for the scoping wiring, or a
   single `fix:` if you prefer), push.
4. Manual `just dev` walkthrough (needs Touch ID for the op-injected env — the
   USER must run this): confirm a correct free-text baseline answer pops the
   badge, and a correct free-text answer on a wave's final turn pops it.
5. **Land the PR:** once CI is green and the user has done the walkthrough,
   PR #17 is ready. Merging is a USER-authorised step — do not merge it
   yourself. The PR is currently `MERGEABLE`; `BLOCKED` state = normal branch
   protection (CI / required review), not a conflict.

VERBATIM — the user's decision that ended the session:

> "fresh session, and you need to write a great /wrap-up of everything so far
> for the new agent to pick up from and be able to implement and know what we
> still need to do to get this PR merged in the end."

And the bug report that triggered the diagnosis:

> "It seems responses to freetext questionnaire questions that are correct
> aren't awarding XP, I can't tell if it's because the model is not adding the
> grading to these specific questions, or if it's an actual bug - after the
> round trip, the XP counter doesn't increase either."

## Context to Preserve

- **Concise communication; explain while doing.** Conventional commits,
  lowercase subject. Never `--no-verify` / never bypass git hooks.
- **No em-dashes in any string that renders to a user** (toasts, UI copy) —
  even when the literal lives in a `.ts` file. Fine in code comments/docs.
- **Subagents:** Opus 4.7 for implementer/reviewer; implementers TDD red→green;
  controller verifies green LOCALLY, never defers to CI. Subagents MUST use
  ABSOLUTE paths — this is a worktree; relative paths hit the wrong repo.
- Another agent's work (`feat/anonymous-auth`) is now merged into `main`; the
  main repo / other worktrees are not ours to touch.
- 1Password commit-signing may need a Touch ID tap; if a commit hangs, that is
  why — re-tap, never bypass signing. `just dev`/`just smoke` need Touch ID
  (op-injected env) — the user runs those, not the agent.
- Nalu trends toward overcomplication — prefer the minimal fix; the wave fix is
  ~5 lines, the scoping fix is deliberately the free-text-subtotal approach
  (smallest correct fix that avoids MC double-counting).
- Promise to the user: both XP bugs get fixed in a fresh session, then the PR
  is taken to a mergeable+verified state for them to merge.

## Restart Hint

Tree clean, all pushed — safe to /clear now. Resume: read this file, then
implement Fix 1 then Fix 2. The diagnosis is complete and verified — start at
implementation, do not re-trace the data flow.
