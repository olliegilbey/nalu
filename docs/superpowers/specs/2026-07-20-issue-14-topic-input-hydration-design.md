# Fix: home composer loses pre-hydration keystrokes (issue #14)

**Status:** specced 2026-07-20, verified present on `main`@`f3fbc25`. Priority P1.

## Problem

On a cold load of `/`, keystrokes typed into the topic composer before React
hydrates are silently discarded: the `<textarea>` in
`src/components/chat/Composer.tsx:419-440` is fully controlled
(`value={inputValue}`), parent state starts as `useState("")`
(`src/components/chat/TopicInput.tsx:25`), and hydration reconciles the raw DOM
value back to `""`. The learner's first submit does nothing; retyping works.
First-interaction failure, reproduced on Vercel preview and localhost.

The localStorage draft buffer (`Composer.tsx:107-138`) does not protect this
path — it is gated on `hasQuestions`, and the topic path has `questions=null`.

## Fix

Make the composer hydration-resilient by recovering the raw DOM value at mount,
scoped so questionnaire behaviour is untouched:

1. In `Composer.tsx`, add a mount effect that reads `ref.current?.value` (the
   textarea ref already exists, line 63). If the DOM value is non-empty and
   React's controlled value is empty, adopt the DOM value via the existing
   `setInputValue` router (which forwards to the parent `onChange`).
   - Effect must run once on mount (`useEffect` with `[]` — an
     `exhaustive-deps` scoped disable if needed, matching the existing pattern
     at line 122, with a WHY comment).
   - Guard: only when `!hasQuestions` (first-message/free-text mode). In
     questionnaire mode the buffer-restore effect owns state.
2. That alone fixes "input clears"; it does not replay a pre-hydration
   Enter-press. Acceptable: the learner sees their text preserved and presses
   Enter again — one action, not a re-type. Do NOT attempt submit replay
   (speculative complexity).

Why not `defaultValue`/uncontrolled: the composer genuinely needs controlled
mode (questionnaire drafts, external `value` prop from Onboarding). The
mount-reconcile is the minimal delta.

## Verification

- Unit: jsdom test that renders Composer with `value=""`, sets
  `ref.current.value = "typed early"` before the effect flushes, and asserts
  `onChange` is called with the DOM value. (Simulating real hydration in jsdom
  is not feasible; test the reconcile function extracted as a pure-ish helper
  if cleaner.)
- Manual (documented in PR): `just dev`, throttle CPU in devtools, cold-load
  `/`, type immediately, confirm text survives and submit fires `course.clarify`.
- `just check` green.

## Out of scope

- Submit replay before hydration.
- Any change to questionnaire-mode state handling.

## Files

`src/components/chat/Composer.tsx` (+ colocated test). Possibly nothing else.
