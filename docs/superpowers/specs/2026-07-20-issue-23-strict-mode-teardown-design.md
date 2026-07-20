# Teardown: vestigial strict-mode capability gating (issue #23)

**Status:** specced 2026-07-20, verified fully present on `main`@`f3fbc25`. Priority P2.
**Unblocked:** llama3.1-8b deprecated 2026-05-27; both remaining registry
entries are `honorsStrictMode: true`, so the gate is dead weight.

## Remove

1. `src/lib/llm/modelCapabilities.ts` and `modelCapabilities.test.ts`.
2. Every `getModelCapabilities` / `honorsStrictMode` reference:
   - `src/lib/turn/executeTurn.ts:13,144,150` — the `live && capabilities.honorsStrictMode`
     gate collapses to `live` (confirm what the flag actually gates here and
     simplify accordingly).
   - Six lib steps, each with import + call + gate
     (`responseSchema: capabilities.honorsStrictMode ? undefined : schemaJson`):
     `clarify.ts:8,71,82`, `generateFramework.ts:10,116,124`,
     `generateBaseline.ts:9,63,73`, `submitBaseline.ts:9,156,189`,
     `executeWaveMid.ts:4,31,42`, `executeWaveClose.ts:4,100,110`.
     The gate always resolves to `undefined` now → the `responseSchema`
     inline-prompt path is dead.
3. The inline schema-prompt path itself:
   - `toSchemaJsonString` import + call in all six steps.
   - The `responseSchema` seed-string params + `<response_schema>` scaffolding
     in the prompt builders: `src/lib/prompts/scoping.ts:23,35-37,47,64-65`,
     `waveTurn.ts:120,129-130`, `waveClose.ts:78,90-91`, `scopingClose.ts:60,68`.
     Includes the scoping system-prompt instruction telling the model to read
     `<response_schema>` (`scoping.ts:23`).
   - If `toSchemaJsonString` ends up with zero callers, delete it too (knip
     will flag it); if `buildRetryDirective` uses it, keep it.

## Keep

- `buildRetryDirective`'s embedded `<response_schema>` block
  (`src/lib/turn/retryDirective.ts:67,74,89`) — the genuine fallback when a
  turn fails validation. Its schema-string dependency stays.

## Scope notes

- `generate.ts` already dropped its capabilities reference (PR #31 moved
  response_format gating to `Output.object`) — off the list.
- Prompt-builder signature changes ripple into their callers and tests —
  update snapshots/fixtures; do not leave dead optional params.
- Cross-check TODO.md's "inline-schema fallback" note: the fallback being
  removed here is the *capability-gated* inline path; the retry-directive
  fallback (kept) is separate. Don't touch the mid-turn mega-schema rollback
  debt (separate TODO item).
- Conflicts with #15 (merge framework+baseline) in two files — this PR merges
  first; #15 rebases.

## Verification

- `just check` green (knip will police newly-dead exports).
- Grep gate in PR description: zero hits for
  `getModelCapabilities|honorsStrictMode|modelCapabilities` outside
  retryDirective-kept schema code; `<response_schema>` appears only in
  `retryDirective.ts` (+ its tests).
- Prompt snapshot tests updated deliberately, not blindly.

## Files

`src/lib/llm/modelCapabilities.{ts,test.ts}` (delete),
`src/lib/turn/executeTurn.ts`, six `src/lib/course/` steps, four
`src/lib/prompts/` builders, associated tests.
