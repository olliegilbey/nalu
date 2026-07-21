# Open-issues triage — 2026-07-20

Full audit of all 10 open issues against `main`@`f3fbc25` (four parallel
verification agents, file:line evidence posted as a comment on each issue).

## Verdicts

| Issue | Title (short)                           | Verdict                                                                              | Priority | Action                    |
| ----- | --------------------------------------- | ------------------------------------------------------------------------------------ | -------- | ------------------------- |
| #14   | Topic typed twice (hydration loss)      | Not fixed, hypothesis confirmed                                                      | **P1**   | Fix PR                    |
| #22   | Free-text answers award no XP           | Not fixed, still un-instrumented                                                     | **P1**   | Instrumentation PR        |
| #16   | No retry path for failed scoping step   | Not fixed                                                                            | **P1**   | Fix PR (Retry affordance) |
| #23   | Strict-mode gating teardown             | Not fixed, unblocked since 2026-05-27                                                | P2       | Teardown PR               |
| #25   | Cerebras token + cost tally             | Not fixed (greenfield)                                                               | P2       | Feature PR                |
| #15   | Merge framework+baseline LLM calls      | Not fixed                                                                            | P2       | Fix PR (after #23)        |
| #20   | Split useWaveState (316 lines)          | Not fixed (lint rule since removed)                                                  | P3       | Refactor PR               |
| #18   | XP undercount via typed-MC escape       | Not fixed                                                                            | P3       | Decision doc              |
| #21   | Double-award on failed final-turn retry | Not fixed                                                                            | P3       | Decision doc              |
| #19   | Extract Composer logic to lib           | **Partial** (eslint half done via `eb70a42`; extraction blocked by parity-lock note) | P3       | Decision doc              |

**Closed: none.** No issue was fully completed by the 18 PRs merged since
filing; #19 is the only partial.

## Specs in this batch

- `2026-07-20-issue-14-topic-input-hydration-design.md`
- `2026-07-20-issue-16-scoping-retry-design.md`
- `2026-07-20-issue-22-freetext-grading-instrumentation-design.md`
- `2026-07-20-issue-23-strict-mode-teardown-design.md`
- `2026-07-20-issue-25-cerebras-cost-tally-design.md`
- `2026-07-20-issue-15-merge-framework-baseline-design.md`
- `2026-07-20-issue-20-split-usewavestate-design.md`
- `2026-07-20-xp-display-counting-design.md` — **decision doc** for
  #18/#21/#19 (recommendation: server-authoritative display counting;
  awaiting Ollie's call — no implementation until then)

## Merge-order notes

- **#23 before #15** (both touch `generateFramework.ts`/`generateBaseline.ts`;
  #15 rebases trivially after the teardown).
- **#16 and #15** both touch `useScopingState.ts` — whichever lands second
  reconciles the retry `failedStep` kinds (noted in both specs).
- **#20 before the #18/#21 fix** (extraction makes the counting change a
  one-file edit) — but #20 is behaviour-preserving and can merge any time.
- #14, #22, #25 are independent of everything.
