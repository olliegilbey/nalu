# Merge generateFramework + generateBaseline into one LLM call (issue #15)

**Status:** specced 2026-07-20, verified unmerged on `main`@`f3fbc25`. Priority P2.
**Sequencing:** conflicts with #23's teardown in the same files — land #23
first, rebase this.

## Problem

Scoping runs four serial LLM round-trips; the framework→baseline pair has no
user action between them. The client bridges the two with an auto-dispatch
effect (`useScopingState.ts:142-169`: fires `generateBaseline.mutate` when
framework lands and baseline is null, ref-guarded). One merged call removes a
round-trip, a rate-limit slot, and the effect machinery. With
`reasoning_effort: high` pinned (PR #39), each avoided round-trip is now a
bigger latency win than when filed.

## Design

**Server**

- New merged step `src/lib/course/generateFrameworkAndBaseline.ts` (or merge
  into `generateFramework.ts` if the file stays ~200 lines): one `generateChat`
  call whose structured response returns `{ framework, baseline }`.
- Schema: compose the existing framework and baseline Zod schemas into one
  response schema. Prompt: merge the two prompt builders' instructions
  (`src/lib/prompts/scoping.ts` region) — the model designs the framework AND
  writes the baseline questionnaire against it in one pass.
  `FRAMEWORK.maxBaselineScopeSize` (`tuning.ts:146`) already couples the two;
  honor existing bounds from both `FRAMEWORK` and `BASELINE` tuning groups.
- Persistence: reuse the existing persistence of both artifacts (framework
  column + baseline column) inside one step — inspect how each step persists
  today and keep the write shapes identical so `getState`/`deriveChatEntries`
  need no changes.
- Router (`src/server/routers/course.ts`): `generateFramework` (`:29-52`)
  becomes the merged procedure (keep the name or rename to
  `generateFrameworkAndBaseline` — prefer rename for honesty; routers are
  transport-only). Delete `generateBaseline` (`:55-59`). Check nothing else
  calls it.
- Old `generateBaseline.ts` step: delete (knip will police).

**Client**

- `useScopingState.ts`: delete the auto-dispatch effect (`:142-169`) and the
  `baselineDispatchedFor` ref + the `generateBaseline` mutation. `submitClarify`
  now triggers the merged mutation; baseline arrives on its result /
  `getState` invalidation. The `activeQuestionnaire` derivation (`:111-140`)
  is state-driven and should need no change — verify.
- Check the retry work from #16's spec if already merged: the `failedStep`
  kinds collapse (`framework`+`baseline` → one). Coordinate whichever lands
  second.

**Degradation risk (name it in the PR):** one merged response asks more of the
model per call. Mitigations already in place: `executeTurn` validate-and-retry

- `buildRetryDirective`. If smoke shows persistent validation failures on the
  merged schema, stop and report on the issue rather than forcing it.

## Verification

- Existing framework/baseline step tests reworked against the merged step:
  parse-failure retry, bounds enforcement from both tuning groups, persistence
  shape unchanged.
- Integration: scoping flow test (topic → clarify → merged call → baseline
  questionnaire renders) — extend whatever covers the current sequence.
- `just smoke` if runnable; otherwise document that live validation is pending.
- `just check` green.

## Files

`src/lib/course/generateFramework.ts` → merged step, delete
`generateBaseline.ts`, `src/lib/prompts/scoping.ts`,
`src/server/routers/course.ts`, `src/hooks/useScopingState.ts`, tests.
