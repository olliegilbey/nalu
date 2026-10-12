# Design decision: client XP display counting (issues #18, #21, #19)

**Status:** decision doc, 2026-07-20. All three verified present on
`main`@`f3fbc25`. Priority P3 (display-only drift + a refactor gated on a
product call). **Nothing here is implemented yet — Ollie picks a direction.**

## The shared design space

`useCourseXp` is a non-authoritative display counter fed from two places:

- **Confirm-time (client-scored):** `Composer.confirmSelection()`
  (`Composer.tsx:233-259`) awards `calculateMcXp` immediately on a correct
  grid-confirmed MC (`:240-246`, via `deriveMcFeedback` since PR #40). Typed
  answers (`handleSend` → `advanceAfterAnswer`, `:272-287`) award nothing.
- **Turn-result-time (server-scored):** `useWaveState.handleTurnResult`
  (`:118-148`) sums only `kind === "free-text"` gradedSignals, deliberately
  skipping `mc-index` to avoid double-counting the confirm-time awards.

Server signals carry no marker of _how_ the answer arrived
(`executeWaveMid.grade.ts:16-22`), so the client cannot reconcile the two
streams. That gap produces both bugs:

- **#18 undercount:** typing the exact option text emits `kind: "mc"`
  (`shapeQuestionnaireAnswers.ts:40-48`) → server grades it → `mc-index`
  signal skipped → nobody counted it.
- **#21 double-award:** confirm-time award has no marker; failed final-turn
  submit re-shows the questionnaire with the last answer dropped
  (`Composer.tsx:184-201` retention comment), re-confirm re-awards.

**#19** is entangled because any clean fix touches the Composer questionnaire
state machine, which the file header (`Composer.tsx:3-8`) declares
parity-locked to kanagawa-whispers ("splitting would diverge from upstream")
— in tension with AGENTS.md's "components contain zero logic".

## Options

### A — Server-authoritative display (recommended)

Remove confirm-time XP entirely; count **all** gradedSignals (mc-index +
free-text) at turn-result time.

- Kills #18 and #21 in one move with _less_ code: `onCorrectAnswer` prop, the
  confirm-time `calculateMcXp` call, and the skip-mc-index filters all
  disappear. No new markers, no reconciliation, one counting authority —
  matches the core design principle (deterministic server scoring; LLM/client
  never influence XP).
- Composer keeps instant _feedback_ (green pulse, sounds) — only the badge
  increment moves to submit-response time.
- Cost: badge XP lands ~1-3s later (at turn submit) instead of instantly on
  confirm. For mid-wave MCs the learner is mid-questionnaire anyway; the
  deferred tick is arguably _more_ honest (server-graded).
- Also shrinks the #19 surface: scoring exits the Composer entirely
  (a Nalu delta layer, exactly what the parity-lock note says layered deltas
  are for).

### B — Client reconciliation markers

Keep instant awards; add (i) awarded-questionId set persisted in the
localStorage buffer (fixes #21), and (ii) plumb that set to `useWaveState` so
mc-index signals for _unawarded_ questionIds get counted (fixes #18).

- Preserves instant-XP UX exactly.
- Cost: new cross-component plumbing (Composer buffer ↔ wave hook), buffer
  schema migration (`parseQuestionnaireBuffer`), more state machine — deepens
  the #19 problem it sits inside.

### C — Server marks the escape

Add `viaEscape`/`clientScored` to the graded-signal shape so the client counts
only signals it didn't award. Fixes #18 alone; #21 still needs B's marker.
Wire-schema change for a display counter — poor trade standalone.

## Recommendation

**A.** It deletes complexity instead of adding it, aligns with the
"deterministic code controls XP" principle, and reduces #19 rather than
deepening it. B only if instant-on-confirm XP is a UX hill worth holding.

On #19 itself, recommendation: **middle path** — keep the JSX/interaction
shell parity-locked; extract only pure logic as layered deltas (the
`deriveMcFeedback` pattern PR #40 established). Option A removes the biggest
logic block from the component; a full `useQuestionnaire` extraction can wait
until the next upstream re-sync proves or disproves the parity-lock's value.

## Once decided

Implementation is small (est. Option A: −40 lines net across Composer,
Onboarding, useWaveState, WaveSession; tests updated). Land after #20's
extraction merges (it moves `handleTurnResult` logic to lib, making the
counting change a one-file test-covered edit).
