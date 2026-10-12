# Fix: retry affordance for failed scoping LLM steps (issue #16)

**Status:** specced 2026-07-20, verified present on `main`@`f3fbc25`. Priority P1.

## Problem

When a scoping step fails (`clarify`, `generateFramework`, `generateBaseline`,
`submitBaseline` — e.g. Cerebras 429 or retry exhaustion), the learner is
stranded: errors surface only as ephemeral `toast.error`
(`useScopingState.ts:85-103`, `:158-165`; `TopicInput.tsx:36-42`), free-text
send in scoping is a deliberate no-op (`Onboarding.tsx:105-110`), and the only
recovery is an invisible remount re-fire that exists for `generateBaseline`
alone (`useScopingState.ts:155-161`).

## Decision

Of the two options in the issue, implement the **client-side Retry
affordance** (re-dispatch the last failed scoping mutation). Chat-text-as-retry
would need backend routing of a text turn into a step re-run — heavier, and the
questionnaire-driven flow makes a button the honest UI. (KARPATHY: simplest
thing that solves it.)

## Design

State: `useScopingState` records the last failed step in local state:
`failedStep: { kind: "framework" | "baseline" | "submitBaseline"; retry: () => void } | null`.

- Each mutation's `onError` sets `failedStep` with a closure that re-runs the
  same mutation with the same variables (the variables are already in scope in
  `submitClarify` / the auto-dispatch effect / `submitBaselineAnswers`).
- Each mutation's `onMutate`/`onSuccess` clears `failedStep`.
- `clarify` failure happens in `TopicInput` before a course exists — keep that
  path as-is (the learner still has the composer; it already drops the
  optimistic bubble so they can resubmit). Out of scope here.
- Keep the existing baseline remount re-fire (`:155-161`) — it becomes
  redundant but harmless; removing it is optional cleanup if it simplifies.

UI: `Onboarding.tsx` renders, when `failedStep !== null`, a small inline retry
row where the next assistant bubble would appear — message ("That step
failed.") + a Retry button calling `failedStep.retry()`. Keep the toast as-is
(the toast announces; the inline affordance persists). Style: match existing
chat-bubble styling; no new design system pieces.

Business-logic placement: the state shape is trivial (a nullable record in the
hook); no `src/lib/` extraction warranted for a first cut — hooks are the
established home for this flow's orchestration (per existing
`useScopingState`).

## Verification

- Unit test on the hook (or extracted handler) asserting: mutation error →
  `failedStep` set with correct kind; `retry()` re-invokes the mutation with
  identical variables; success clears it.
- Component test: retry row renders on `failedStep`, hidden otherwise.
- Manual (documented in PR): kill network in devtools mid-scoping, watch the
  retry row appear, restore network, Retry proceeds.
- `just check` green.

## Out of scope

- `clarify`/home-screen retry (composer resubmit already covers it).
- Backend chat-text → step re-run routing.
- Wave-turn (teaching loop) retry — different flow, different issue if wanted.

## Files

`src/hooks/useScopingState.ts`, `src/components/chat/Onboarding.tsx`
(+ colocated tests).
