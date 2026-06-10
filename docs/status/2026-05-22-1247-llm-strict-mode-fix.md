# Status: LLM strict-mode fix (on the chore/nalu-debug-skill branch)

## Task Overview

A debugging thread that started from hosted-site failures and produced three things,
ALL to land on ONE branch (`chore/nalu-debug-skill`) and ship as ONE PR:

1. **DONE (committed)**: a project debugging skill + read-only DB inspector.
2. **DONE (committed)**: fixed a deterministic 500 on wave teaching turns (`conceptName`
   schema gap).
3. **OPEN - the next session's job**: Cerebras strict-mode JSON-schema constrained
   decoding is **not actually engaged**; the schema is never sent as `response_format`.
   Wire the fix, on the SAME branch.

**Decision (user, this session):** land the strict-mode fix on `chore/nalu-debug-skill`,
not a separate branch. The PR description should note it covers all three. Reason: fewer
PRs = less CodeRabbit rate-limit pressure. Accepted tradeoff: the hosted-site conceptName
500 stays live until the combined PR merges + deploys.

Success criterion for the open item: structured LLM calls send the schema as a real
`response_format: {type:"json_schema", strict:true}` wire payload, verified live, so the
model is constrained on the first attempt instead of guessing and recovering on retry.

## Reference Docs

- Cerebras structured outputs (external): https://inference-docs.cerebras.ai/capabilities/structured-outputs
  - Strict mode needs root `type:"object"` and `additionalProperties:false` on EVERY
    object; hard-enforced from 2026-07-21. Wire shape:
    `response_format:{"type":"json_schema","json_schema":{"schema":...,"name":...,"strict":true}}`.
- No project PRD slice is needed; the relevant detail is all in code (see below).

## Current State

Branch `chore/nalu-debug-skill`, **pushed** to origin, 4 commits, all pre-commit checks
green each time (secrets, format, lint, typecheck, 366 unit tests). What each commit did:

- `0c36c47` chore: debugging skill. Created `.claude/skills/debugging-nalu-llm-pipeline/`:
  `SKILL.md` (a playbook for hosted Nalu LLM-pipeline failures - error vocabulary, retry
  math, a transport-vs-schema DB-forensics decision tree) and `inspect-db.ts` (a
  read-only production-DB inspector: recent-activity overview + per-course drill-down).
- `e3d43ee` fix(wave): the conceptName 500 fix. `waveMidTurnSchema` in
  `src/lib/prompts/waveTurn.ts` gained a `.superRefine` requiring `conceptName` on every
  questionnaire question and `correct` on every MC. Before: a question without
  `conceptName` passed schema validation, then `insertNewQuestionnaire` hard-threw an
  `Error` -> unrecoverable 500 on `wave.submitTurn`. After: a retryable
  `ValidationGateFailure`. Also sharpened model-facing copy (`teaching.ts` ROLE_BLOCK +
  field `describe()`s): questionnaire = graded concept-check, conversational questions =
  `userMessage` prose. Removed the matching `TODO.md` entry.
- `5957ed8` chore: wave-turn coverage for the skill. `inspect-db.ts --course` now prints
  wave context messages + a per-wave `chatlog_entries` count; `SKILL.md` gained a
  "post-persist failure" class (a turn that 500s even though `context_messages` shows a
  clean `assistant_response`).
- `604272e` fix(wave): review follow-ups. The superRefine used `=== undefined` but the
  `insertNewQuestionnaire` backstop is `!q.conceptName` (also rejects `""`); aligned the
  superRefine to `!q.conceptName`. Removed em-dashes from the prompt strings added in
  `e3d43ee` (no-em-dash user preference).

`git status`: only pre-existing non-code changes, NONE from this session's work:
`M .claude/settings.json` (1-line deletion, present at session start), `?? CURRENT.md`,
`?? docs/status/` (untracked dir; this file lives here, like the other status files).

**PR NOT yet opened** - it will be opened once the strict-mode fix is also on the branch.

Files analysed (not modified): `src/lib/llm/generate.ts`, `toCerebrasJsonSchema.ts`,
`provider.ts`, `modelCapabilities.ts`, `src/lib/turn/executeTurn.ts`,
`src/lib/course/submitBaseline.ts`, `executeWaveMid*.ts`, `scripts/probe-model.ts`.

## Important Discoveries

### THE OPEN TASK: strict mode is not wired

`src/lib/llm/generate.ts` (`generateChat`) builds a `responseFormat` object via
`toCerebrasJsonSchema` and passes it as a **top-level arg** to `generateText`.
**AI SDK v6 (`ai@6.0.158`) `generateText` has no `responseFormat` option.** It sets the
model-call `responseFormat` ONLY from the `output` / `experimental_output` param.
Confirmed in runtime source: `node_modules/ai/dist/index.mjs:4333` ->
`responseFormat: await (output == null ? void 0 : output.responseFormat)`. The top-level
`responseFormat` is silently dropped; it typechecks only because the conditional spread
(`...(cond ? {responseFormat} : {})`) dodges TypeScript excess-property checking.

Three schema-delivery paths; for the live model (`LLM_MODEL=gpt-oss-120b`):

1. **Wire `response_format`** - dead (above).
2. **Inline `<response_schema>` block** - OFF. Lib steps gate it
   `capabilities.honorsStrictMode ? undefined : schemaJson`; `gpt-oss-120b` is
   registry-marked `honorsStrictMode: true` in `modelCapabilities.ts`, so it is suppressed.
3. **Retry directive** - the ONLY live path. `buildRetryDirective(err, schemaJson)`
   always embeds the schema. The model sees the schema ONLY after a first-attempt
   validation failure.

Consequence: **every structured turn's first attempt flies blind** (no schema), the
model guesses the shape, usually fails Zod, then the retry directive hands it the schema
and it succeeds on attempt 2. A guaranteed retry tax on essentially every turn,
confirmed by production DB data (every first structured attempt across clarify /
framework / wave turns failed and recovered on retry).

The provider IS correct and doc-compliant: `@ai-sdk/openai-compatible@2.0.41`, given
`callOptions.responseFormat = {type:"json", schema}` and `supportsStructuredOutputs:
true`, emits `response_format:{type:"json_schema",json_schema:{name,schema,strict:true}}`
(`node_modules/@ai-sdk/openai-compatible/dist/index.mjs:517-521`; `strict` defaults
`true`). `provider.ts` already sets `supportsStructuredOutputs: true`. The bug is purely
that the schema never reaches the provider.

### FAILED APPROACH (do not repeat)

The first diagnosis this session claimed "the schema never reaches the model at all."
WRONG - it traced only the dead wire path and missed the retry-directive path. Start
from the corrected 3-path model above. The schema DOES reach the model, but only via the
retry directive, only after attempt 1 fails. It is never strict, never constrained
decoding, never in `response_format`.

### Other findings

- `src/lib/llm/CLAUDE.md` says "Vercel AI SDK v5" - STALE, it is v6. Fix while in there.
- `modelCapabilities.ts` claims `gpt-oss-120b` "honours strict mode, probe-verified".
  The probe (`scripts/probe-model.ts`) STRICT test is contaminated - its user message
  literally contains the answer `{"word":"OK","count":1}`. The DESC probe (magic token
  lives only in a `.describe()`) is the real test - re-run it after the fix.
- `generate.test.ts` asserts `generateText` is called with `responseFormat` - it asserts
  the BROKEN wiring and is mocked, so it can never verify real strict mode. Rewrite it.
- Integration tests cannot run locally (no Docker). The wave integration suites mock
  `executeTurn`, so schema changes do not touch their path.
- `bun run lint` reports ~22k problems, almost all from a stale `.claude/worktrees/`
  build dir (`ui-fixes-reference-merge`, active in another session - leave it).

## Next Steps

Verbatim, the user's instruction that set up this handoff (where work stopped):

> "I think let's land it all on this branch, we can mention when we PR that it's both -
> it's helpful for my coderabbit rate limits. So can you change the wrap up status to
> reflect, and then add any remaining context that would be helpful for the new agent to
> know what to do for the llm strict mode fix, and a little on what the previous commits
> were about."

In priority order:

1. **Implement the strict-mode fix ON `chore/nalu-debug-skill`.** Brainstorm the
   approach first (A vs B below are a real design fork). Goal: get the Cerebras-massaged
   JSON Schema into `callOptions.responseFormat` so the provider emits strict
   `json_schema`. Confirmed available in `ai@6.0.158`: `Output` (`import { Output } from
"ai"`; `Output.object()`), `jsonSchema` (re-exported from `@ai-sdk/provider-utils`),
   `wrapLanguageModel`.
   - **Approach A - `experimental_output`:** `generateText({ ..., experimental_output:
Output.object({ schema: jsonSchema(strippedSchema) }) })`. `Output.object` resolves
     `output.responseFormat` so `generateText` sets `callOptions.responseFormat`.
     RISK to investigate first: `Output.object` also makes the SDK parse `result.text`
     into `result.experimental_output` and may throw (`NoOutputGeneratedError`) on a
     mismatch - that would pre-empt `executeTurn`'s own parse/validate/retry-with-
     directive, which expects to receive raw `.text` and validate it itself.
   - **Approach B - `wrapLanguageModel` middleware (likely cleaner):** in `provider.ts`,
     `wrapLanguageModel({ model, middleware })` where the middleware's `transformParams`
     injects `params.responseFormat = {type:"json", schema}`. Thread the per-call schema
     via `providerOptions` (part of `params`): `generateChat` puts the stripped schema
     there, the middleware reads it. This sets the wire `response_format` directly with
     ZERO interaction with `Output`'s parsing, so `executeTurn`'s `.text`-based retry
     loop is completely untouched.
   - `generateObject` - considered, rejected: it owns parsing and throws
     `NoObjectGeneratedError` on failure, bypassing `executeTurn`'s retry-with-directive.

   Supporting work, either approach:
   - Cerebras strict needs `additionalProperties:false` on every object + root
     `type:"object"`. `toCerebrasJsonSchema` strips forbidden keywords but does NOT add
     `additionalProperties:false`. Add a transform (first check what Zod v4
     `z.toJSONSchema` already emits for `z.object()`).
   - Reshape `toCerebrasJsonSchema`'s return (`{type:"json",name,schema}` was built for
     the dead path).
   - Rewrite `generate.test.ts` (it asserts the broken wiring).
   - Review `modelCapabilities.ts` `honorsStrictMode` gating - keep the inline
     `<response_schema>` block as the fallback for genuinely non-honouring models.
   - Fix `src/lib/llm/CLAUDE.md` "v5" -> "v6".

   **Verification (cannot be unit-tested; the SDK is mocked in tests):**
   - `just smoke` (live Cerebras; needs Touch ID via `op` - the USER runs it).
   - `just probe-model gpt-oss-120b` - the DESC probe should return its magic token once
     the schema actually reaches the model.
   - After deploy, `inspect-db.ts --course <id>` on a fresh course - first attempts
     should stop failing (the retry tax should disappear).

2. **Open ONE PR** for `chore/nalu-debug-skill`. Description covers all three: the
   debugging skill, the conceptName 500 fix, the strict-mode fix. Then merge + deploy.

## Context to Preserve

- **No em-dashes in rendered strings.** Avoid em-dashes in user-facing and model-facing
  string literals (prompt copy, validation messages); use colon / hyphen / period.
  Standing user preference.
- **TDD** for pure logic / schema changes: failing test first, watch it fail, implement.
- **Never bypass git hooks.** Fix root causes. **Commit only when asked; ask before
  opening PRs / pushing.** Conventional commits. Match existing code style.
- `just smoke` / `just dev` use `op run` and need Touch ID - they hang for an AFK user.
  The user runs live verification themselves.
- The debugging skill `debugging-nalu-llm-pipeline` now exists - use it (and
  `inspect-db.ts`) for any hosted-failure debugging.
- **Security**: `.env.local`'s `DATABASE_URL` is the PRODUCTION Supabase. `inspect-db.ts`
  is read-only (SELECT only) by design - keep it that way. Never echo secret values;
  never pipe `.env.local` through a redaction `sed` (BSD vs GNU sed differences leaked
  the prod DB password into an earlier session's transcript).

## Restart Hint

All work is committed and pushed; the branch has no uncommitted code. Safe to /clear.
Resume on `chore/nalu-debug-skill` (do NOT branch off): brainstorm approach A vs B for
the strict-mode fix, implement, then open the single combined PR.
