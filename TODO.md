# TODO

Follow-up work surfaced during MVP development. Each entry names the file,
the concern, and the conditions under which it should be promoted to a PR.

## submitBaseline (PR #10 follow-ups)

### Drop the mid-test model swap in scoping-close live smoke

**Files:** `src/server/routers/submitBaseline.live.test.ts`, `src/lib/config.ts`
(`__resetEnvCacheForTests`)

Live smoke currently swaps `llama3.1-8b → qwen-3-235b-a22b-instruct-2507`
mid-test because llama's 8k ceiling overflows on the close turn after prior
turns are appended. Both models deprecate 2026-05-27 (see memory
`project_llama_8b_deprecation`).

**Fix:** once a wider-context floor model is selected, remove the swap and the
`__resetEnvCacheForTests` escape hatch from `src/lib/config.ts`.

**Promote when:** floor-model selection lands (hard deadline 2026-05-27).
