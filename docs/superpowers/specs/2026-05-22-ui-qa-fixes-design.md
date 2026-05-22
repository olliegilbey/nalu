# UI QA fixes (round 2) — design

**Date:** 2026-05-22
**Status:** approved (design); pending implementation plan
**Branch:** `feat/ui-fixes-reference-merge`
**Scope:** eight UI-layer bugs found during manual verification of the parent
batch (@docs/superpowers/specs/2026-05-21-ui-fixes-and-reference-merge-design.md).
Frontend only — no server business-logic changes. Two backend-side follow-ups
are filed as GitHub issues.

---

## Context

The parent batch (splash, XP badge, course title, optimistic submit,
kanagawa-whispers port — T1–T16) is complete and committed. A `just dev`
walkthrough surfaced eight new bugs. This spec covers fixing them.

Issues 1, 2, 3 and 7 were applied directly (low-risk copy + scroll fix) and are
already in the working tree, uncommitted, in `Splash.tsx` and `ChatShell.tsx`.
They are **folded into this batch** — documented below as done, committed
alongside the issues 4/5/6/8 work as one coherent QA-fixes commit.

### Decisions taken during brainstorming

- **Issues 1/2/3/7:** fold into this batch's spec and commit (already applied).
- **Optimistic bubble (6 + 8):** gate the bubble on _"the real turn has not yet
  appeared"_ (a `turns.length` snapshot), not on `isPending`. Chosen over
  string-match dedup — purely derived, and independent of `formatComposerAnswers`
  staying byte-identical to `deriveTurns`'s formatter.
- **Error UX (issue 8):** on a submit error the questionnaire stays dismissed
  from the composer. The learner's answers are already captured as a chat
  bubble; the composer reverts to its free-text input, and a toast carries the
  error code. Re-triggering a failed step is a backend concern → GH issue.
- **localStorage restore bug (Q3):** in scope — fixed as part of this batch.

---

## Issue 1 — splash em-dash → hyphen (DONE)

`Splash.tsx` heading: `Ollie — welcome` → `Ollie - welcome`. The user dislikes
em-dashes in user-facing copy. Applied.

## Issue 2 — `systemthat` missing space (DONE)

Resolved by the issue 3 copy rewrite — the offending paragraph was replaced
wholesale. Applied.

## Issue 3 — splash copy rewrite (DONE)

`Splash.tsx` — all three body paragraphs replaced with the user's supplied
copy. Emphasis rendered as `<strong className="font-medium text-foreground">`
(the design system's `font-medium` emphasis weight, brightened — not raw 700
bold). Applied.

## Issue 7 — chat bobs on keystroke (DONE)

`ChatShell.tsx`. Root cause: the scroll effect depends on `[children]`, a fresh
array on every parent render — i.e. every Composer keystroke — and called
`scrollTo({ behavior: "smooth" })` each time, so the smooth animation never
settled (perpetual 5–10 px bob, visible once the composer wraps to 2+ lines and
`<main>` overflows). Fix: a `lastScrollHeight` ref; the effect skips `scrollTo`
when `scrollHeight` is unchanged. Applied.

---

## Issue 4 — freetext lost on questionnaire back-navigation

**Edit:** `src/components/chat/Composer.tsx`

Root cause: `value` is a single parent-owned string with no per-step storage.
On a free-text send, `handleSend` clears it (`onChange("")`) and commits the
answer into `answers[step]`. The textarea is `disabled={stepLocked}` where
`stepLocked = answers[step] != null` — so a free-text step locks exactly like an
MC step, and its typed text is gone on revisit.

Fix:

- Add per-step `drafts: string[]` state, indexed alongside `questions`.
- A derived `inputValue` / `setInputValue` indirection: in questionnaire mode
  the textarea binds to `drafts[step]`; in free-text chat mode it binds to the
  parent `value` / `onChange` props as today. The `Composer` prop signature is
  unchanged — `value` is simply unused while a questionnaire is active.
- `canSend`, `confirmMode` and the placeholder logic read `inputValue`.
- Free-text questions never lock the textarea:
  `currentIsFreeText = current != null && current.options.length === 0`;
  `textareaLocked = stepLocked && !currentIsFreeText`. The textarea uses
  `disabled={textareaLocked}`. MC steps are unchanged — still lock on confirm.
- `handleSend` no longer clears the draft on a free-text send.
- `onComplete` reads `drafts[i]` for free-text questions and `answers[i]` for MC
  questions, so chevron back-edits made before completion are captured.

Accepted behaviour: pressing Send on a revisited, already-answered free-text
step re-records that answer and completes the questionnaire (the others are
already answered). Editing a draft and navigating away with the chevrons also
captures the edit via `onComplete`. Both paths are coherent; neither needs
special-casing.

Composer.tsx already carries a file-wide `eslint-disable` for `max-lines` +
`functional/immutable-data` (parity-locked port), so the added state is within
tolerance. Net line count is roughly neutral — the issue-Q3 effect merge and
the `parseQuestionnaireBuffer` extraction below remove offsetting lines.

---

## Issue 5 — questionnaire lingers in composer after submit

**Edit:** `src/components/chat/Onboarding.tsx`, `src/components/chat/WaveSession.tsx`

Root cause: the Composer's `questions` prop is derived from `activeQuestionnaire`,
which is computed from server state. It stays non-null until the server
round-trip refetches — so the question card stays visible (disabled) through the
whole round-trip.

Fix:

- The parent tracks `dismissedKey: string | null`. In `onComplete`, set it to
  the submitted `activeQuestionnaire.questionsKey`.
- Pass `questions={null}` to the Composer while
  `activeQuestionnaire.questionsKey === dismissedKey`.
- Clears naturally: when server state advances, `activeQuestionnaire` becomes a
  different key (or null). Questionnaire keys are per-questionnaire-id and never
  recur, so `dismissedKey` needs no explicit cleanup.
- On error, server state does not advance → the key still matches → the
  questionnaire stays dismissed and the composer shows its free-text input.
  This is the intended error UX (see brainstorming decisions).

`TopicInput.tsx` is unaffected — its composer is free-text only, no
questionnaire.

---

## Issues 6 + 8 — optimistic bubble (duplicate / vanishing): unified fix

**Edit:** `src/components/chat/Onboarding.tsx`, `src/components/chat/WaveSession.tsx`

Both bugs share one root cause: the optimistic user bubble is gated on
`isPending`.

- **Issue 6 (duplicate):** framework creation is _two_ LLM calls —
  `useScopingState` auto-dispatches `generateBaseline` once `framework` lands
  (no user action between; see lines ~117–139). After framework lands,
  `deriveTurns` emits the real clarify-answers turn, but `isPending` is still
  true (baseline dispatching) and `pendingMessage` was never cleared → the
  optimistic bubble renders a _second_ time, below the now-real turn.
- **Issue 8 (vanishing):** on a submit error `isPending` flips to false → the
  optimistic bubble disappears, taking the learner's submitted answers off
  screen.

Fix — gate the bubble on _"the real turn has not yet appeared"_:

- The optimistic message becomes `{ content: string; turnCountAtSubmit: number }`
  (replacing the bare `pendingMessage: string`). On submit, snapshot the current
  `turns.length` into `turnCountAtSubmit`.
- Render the optimistic bubble while `turns.length === optimistic.turnCountAtSubmit`.
  - **Success** → the refetch grows `turns` → `length` changes → bubble hides.
    No duplicate, even across the framework→baseline gap (issue 6).
  - **Error** → no new turn → `length` unchanged → bubble persists (issue 8).
- `TypingBubble` stays gated on `isPending` — correctly present while the LLM is
  working (including the baseline-dispatch gap) and correctly gone on error.

`turns` is memoised from `state.data`; React Query keeps the last successful
`data` during a background refetch, so `turns.length` is stable at the old value
until fresh data arrives, then jumps — a clean single transition with no
flicker.

This applies in both `Onboarding` (clarify and baseline submits) and
`WaveSession` (chat-text and questionnaire-answer submits).

---

## Issue 8 — error surfacing

**Edit:** `src/hooks/useScopingState.ts`, `src/hooks/useWaveState.ts`,
`src/components/chat/TopicInput.tsx`
**New:** a pure error-formatting helper + colocated test.

Root cause: the three scoping mutations (`generateFramework`, `generateBaseline`,
`submitBaseline`) have **no `onError`** — failures are silent. `submitTurn`
(wave) and `clarify` (topic) already have `onError` toasts but surface only
`err.message`, with no machine-identifiable error code.

Fix:

- **New pure helper `formatMutationError(err: unknown): string`** — extracts the
  tRPC client error's `data.httpStatus` and `data.code` and composes a
  developer-identifiable description, e.g. `"HTTP 429 · TOO_MANY_REQUESTS — <message>"`.
  Degrades gracefully when `data` is absent (falls back to the message alone).
  Pure, TDD'd, colocated test. Lives under `src/lib/` (exact path decided in the
  plan — a flat `src/lib/errors.ts` is the candidate). localStorage/transport
  data is an untrusted boundary; the helper tolerates any input shape.
- Add `onError` toasts to the three scoping mutations — a friendly title, the
  `formatMutationError` output as the toast description:
  - `generateFramework` → "Couldn't build your course outline"
  - `generateBaseline` → "Couldn't create your baseline quiz" (added to the
    existing per-call `onError` that already clears the dispatch guard)
  - `submitBaseline` → "Couldn't save your answers"
- Route the two existing `onError`s through `formatMutationError` for the error
  code: `useWaveState`'s `submitTurn` and `TopicInput`'s `clarify`. `clarify`'s
  existing behaviour of dropping the optimistic topic on error is **kept** — only
  the toast description changes.
- The optimistic bubble staying visible on error is delivered by the issues
  6 + 8 unified fix above — no separate change needed here.

The underlying backend failure the user hit (`submitBaseline` exhausting
retries) is **not** fixed here — this issue is purely frontend error surfacing.

---

## localStorage restore bug (Q3 — in scope)

**Edit:** `src/components/chat/Composer.tsx`
**New:** a pure buffer-parsing helper + colocated test.

Confirmed bug. `Composer.tsx` has three `questionsKey`-related effects in source
order: hydrate (reads localStorage), persist (writes localStorage), reset (fills
`answers`/`step` blank). On mount they all run in order against the _initial_
render state:

1. Hydrate reads the saved buffer and _queues_ `setAnswers(saved)`.
2. Persist writes the _current_ (still-empty) state to localStorage —
   **clobbering the saved buffer** before hydrate's `setState` commits.
3. Reset queues `setAnswers([null, …])`, which runs after hydrate's queued
   update — **overriding the restore** in-memory too.

Net: questionnaire-answer restore-on-reload never works.

Fix:

- Merge the hydrate and reset effects into a single `questionsKey`-keyed init
  effect: try to restore from localStorage; if there is no valid buffer, fill
  blank. One effect → no inter-effect ordering ambiguity. It also resets the
  transient UI state (`pending`, `feedback`, `slideDir`, `locked`) and — for
  issue 4 — the `drafts` array.
- Extract `parseQuestionnaireBuffer(raw, questionsKey, questionCount)` as a pure,
  Zod-validated helper (localStorage is an untrusted boundary). It takes the raw
  string and returns the restored `{ answers, step, drafts }` or `null`. Pure →
  TDD'd with a colocated test; no storage double needed.
- Extend the persisted buffer shape with `drafts: string[]` so issue 4's
  free-text editability also survives a reload. A buffer written by the old
  shape (no `drafts`) parses with `drafts` defaulted to blanks.

---

## GitHub issues (backend — out of scope for this PR)

Filed — [#15](https://github.com/olliegilbey/nalu/issues/15) and
[#16](https://github.com/olliegilbey/nalu/issues/16).

1. **[#15] Merge `generateFramework` + `generateBaseline` into one LLM call.**
   They run back-to-back with no user action between (the auto-dispatch effect in
   `useScopingState`). Folding them into one call saves a round-trip and a model
   call. Issue 6's other half.
2. **[#16] Scoping-flow retry path.** When a scoping step fails, the learner has
   no way to re-trigger it — `Onboarding`'s composer free-text `onSend` is a
   no-op (questionnaire-driven flow). A retry affordance (or interpreting a typed
   "try again") needs backend support.

---

## Files

**New**

- A pure error-formatting helper + colocated test (issue 8) — e.g.
  `src/lib/errors.ts` + `src/lib/errors.test.ts`.
- A pure questionnaire-buffer parser + colocated test (Q3) — e.g.
  `src/lib/course/parseQuestionnaireBuffer.ts` + colocated test.

Exact filenames are settled in the implementation plan.

**Edited**

- `src/components/chat/Composer.tsx` — issue 4, Q3
- `src/components/chat/Onboarding.tsx` — issues 5, 6, 8
- `src/components/chat/WaveSession.tsx` — issues 5, 6, 8
- `src/components/chat/TopicInput.tsx` — issue 8
- `src/hooks/useScopingState.ts` — issue 8
- `src/hooks/useWaveState.ts` — issue 8

**Already applied (uncommitted, folded into this batch's commit)**

- `src/components/chat/Splash.tsx` — issues 1, 2, 3
- `src/components/chat/ChatShell.tsx` — issue 7

---

## Testing

- Pure helpers — TDD, colocated tests:
  - `formatMutationError` — tRPC error with `data.httpStatus` + `data.code`;
    error with no `data`; non-Error input.
  - `parseQuestionnaireBuffer` — valid buffer; `questionsKey` mismatch;
    wrong-length `answers`; missing `drafts` (old shape); malformed JSON.
- Components (Composer, Onboarding, WaveSession, TopicInput, hooks) — no unit
  test harness exists for chat components (parent-batch Discovery 7). Verify via
  `just typecheck && just lint && just build`.
- `just check` must pass before commit.

---

## Out of scope (YAGNI)

- The backend `submitBaseline` retry failure itself (issue 8's trigger) — only
  the frontend error surface is in scope.
- A scoping-flow retry mechanism — GH issue 2.
- Merging the framework + baseline LLM calls — GH issue 1.
- Any change to MC lock behaviour — MC steps still lock on confirm.
