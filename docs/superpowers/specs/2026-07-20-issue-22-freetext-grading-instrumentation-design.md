# Diagnose: free-text answers award no XP — grading instrumentation (issue #22)

**Status:** specced 2026-07-20, verified un-instrumented on `main`@`f3fbc25`. Priority P1.

## Problem

Correct free-text answers can award 0 XP. PR #17 fixed the client plumbing;
the open question is server-side and **undiagnosable from current logs**:

- Hypothesis (1): the LLM omits free-text entries from `gradings`, or emits a
  shape Zod drops — schema non-adherence.
- Hypothesis (2): the LLM grades them q0/q1, which `calculateXP` maps to 0 by
  design (`tuning.ts:63-70` qualityMultipliers `0:0, 1:0`; `incorrect: [0,1]`
  bands in `src/lib/prompts/closeTurn.ts:4-10`).

Current logging is count-only: `executeWaveClose.ts:116-117` and
`submitBaseline.ts:195` log `gradings=${p.gradings.length}`;
`persistWaveClose.helpers.ts:119-133` logs only on skip; OTel spans
(`a7c2f4d`) are deliberately content-redacted. Also rule out `c3ed970`
(strip-fabricated-gradings, 2026-07-14) as a new masking path: confirm the
questionId-set check isn't stripping legitimate free-text gradings.

## Fix: instrument, then decide

This PR lands **diagnosis instrumentation only** — no behaviour change. The
(1)-vs-(2) verdict and the real fix are a follow-up once a repro run is logged.

1. **Per-grading content log at the two close paths.** In
   `executeWaveClose.ts` and `submitBaseline.ts` (or their shared helper if
   one falls out naturally), after Zod parse succeeds, log each grading:
   `questionId`, `kind`, `verdict`, `qualityScore`, `xpAwarded`-to-be — and for
   free-text, a **truncated** answer excerpt (first ~80 chars).
2. **Zod-drop visibility.** If parse fails and `executeTurn` retries, the raw
   candidate is the interesting artifact. Check what the existing
   validate-and-retry path (`executeTurn` / `buildRetryDirective`) already
   captures; if the failed candidate isn't logged anywhere, add a truncated
   dump of the failing `gradings` fragment at the same gate.
3. **Strip-path visibility.** Where `c3ed970`'s stripping logic discards
   gradings, log what was stripped and why (ids present vs expected).

### Redaction constraint

Prod OTel spans stay content-redacted. Gate content logging behind the
existing dev/smoke conventions: follow the pattern of the current
`successSummary`/stderr writes in these files (inspect
`src/lib/testing/` + how `emitSmokeFinalSnapshot` and live tests gate
output). If no gate exists, use `process.env.NODE_ENV !== "production"` OR an
explicit `LLM_DEBUG_GRADINGS` env flag (add to config schema, documented).
Learner answer excerpts must never reach prod logs.

## Verification

- Unit test: the log formatter (extract as a pure function, e.g.
  `formatGradingDebugLine(grading)`) truncates answers, includes
  verdict/qualityScore, and is a no-op when the gate is off.
- Run `just smoke` (or the live-gated wave-close test) and confirm the
  gradings lines appear for a free-text answer.
- `just check` green; no `console.log` (commit gate) — use
  `process.stderr.write` per the existing convention noted in TODO.md.

## Exit criteria for the follow-up (not this PR)

A logged repro of a known-correct free-text answer showing either the missing
grading (→ schema/prompt fix) or a q0/q1 verdict (→ grading-quality/rubric
fix). Post the finding on #22.

## Files

`src/lib/course/executeWaveClose.ts`, `src/lib/course/submitBaseline.ts`,
`src/lib/course/persistWaveClose.helpers.ts`, possibly `src/lib/config.ts`
(env flag) + a small pure formatter with test.
