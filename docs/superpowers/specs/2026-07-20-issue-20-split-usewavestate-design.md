# Refactor: split useWaveState.ts (issue #20)

**Status:** specced 2026-07-20, verified at 316 lines on `main`@`f3fbc25`. Priority P3.
**Honesty note:** the 200-line lint rule was removed in `eb70a42`; this is
convention-only (AGENTS.md guideline). Behaviour-preserving refactor.

## Extractions

Both targets are cleanly separable today:

1. **`deriveActiveQuestionnaire`** — the `activeQuestionnaire` memo
   (`useWaveState.ts:203-230`) is already a pure function of
   `(chatLog, waveId)`: `findLastIndex` for `text_with_questionnaire`, check
   for later `user.answers`, build `ActiveQuestionnaire`.
   → `src/lib/course/deriveActiveQuestionnaire.ts` (+ colocated test), sitting
   beside the existing `deriveWaveChatEntries`. Hook keeps a thin `useMemo`
   wrapper.
2. **`handleWaveTurnResult`** — the `handleTurnResult` closure
   (`useWaveState.ts:118-148`): mid-turn (sum free-text signals → addXp) and
   close-turn (setCloseResult, completion+free-text XP, tier-up toast)
   branches. Extract the pure decision part:
   `deriveTurnResultEffects(result): { xpGain: number; closeResult?: WaveCloseResult; tierUp?: number }`
   → `src/lib/course/` (+test). The hook applies effects (addXp,
   setCloseResult, toast) — side-effects stay in the hook, decisions move to
   lib. Preserve the "exact port of the old submitTurn onSuccess branches"
   comment lineage (line 117) — note the port in the new file's header.

Do NOT extract the streaming-parts slicing (`:240-268`) or transport config in
this pass — surgical scope, two extractions only. If the file still exceeds
~200 lines after both, that's fine; report the count in the PR, don't chase it.

## Constraint

⚠️ Issues #18/#21 have a pending design decision on these exact XP branches
(see `2026-07-20-xp-display-counting-design.md`). This refactor must be
byte-equivalent in behaviour — the free-text-only filter and its
skip-mc-index comments move verbatim. Extraction makes the later #18 fix
easier to test, whichever option is chosen.

## Verification

- New unit tests for both pure functions (questionnaire derivation cases:
  none / active / already-answered; turn-result cases: mid with/without
  free-text signals, close with completion + tier-up).
- Existing hook/component tests pass unchanged.
- `just check` green.

## Files

`src/hooks/useWaveState.ts`, new `src/lib/course/deriveActiveQuestionnaire.ts`
+ `deriveTurnResultEffects.ts` (names negotiable, boring and explicit) + tests.
