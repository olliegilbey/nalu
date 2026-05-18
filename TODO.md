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

## executeWaveMid (Task 11 follow-ups)

### Enforce `conceptName` on waveMidTurn questionnaire at the schema layer

**Files:** `src/lib/prompts/waveTurn.ts`

`waveMidTurnSchema` accepts questions without `conceptName` because the shared
`questionSchema` permits absence for clarify-style elicitation. Wave teaching
needs `conceptName` on every question (it drives the per-question concept
binding for assessment rows). `executeWaveMid.insert.ts` throws a clear
runtime error today; promote that to a `.superRefine` on
`waveMidTurnSchema.questionnaire.questions[]` so the harness retry directive
surfaces it to the model.

**Fix:** add a superRefine that walks `questionnaire.questions[]` and emits
an issue on any missing `conceptName` (and missing `correct` for MC). The
refine `.message` should be teacher-style so the retry attempt can recover.

**Promote when:** any other wave-teaching schema refines land (Task 12+) and
the refine surface starts paying for itself.
