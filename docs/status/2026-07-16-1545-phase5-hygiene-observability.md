# Phase 5 — Tasks 1-4 DONE on `chore/llm-hygiene-observability`; Tasks 5-6 + PR remain

## Task Overview

Final phase of the AI SDK modernization (`docs/superpowers/plans/2026-06-10-llm-hygiene-observability.md` — read in full before resuming). Implement all tasks, open PR, **DO NOT MERGE — only Ollie merges to main** (rule set 2026-07-14 after PR #35 was auto-merged; memory `only-ollie-merges-to-main`; treat any older "merge authority" in status files as expired).

- Phases 1-4 merged (#31 #32 #34 #35).
- PR #36 (validate-not-force tools contract, CodeRabbit fix) OPEN, green, awaiting Ollie's merge. This branch is off main WITHOUT it; expect a trivial rebase/merge if it lands.
- This branch also carries an unplanned first commit: nomenclature cleanup (Ollie-requested): `Turn` type → `ChatEntry`, `deriveWaveChatEntries`, glossary Turn/Step/ChatEntry disambiguation block, TODO.md rename question RESOLVED (recorded; don't re-litigate).

## Current State

Branch `chore/llm-hygiene-observability`, pushed through `711841a`, tree clean, `just check` + `just build` green (482 unit / 158 integration; 16 pre-existing boundary warnings).

Commits: `6da07f8` nomenclature; `ad3a0d7` VGF rehomed to `src/lib/turn/validationGateFailure.ts`; `ddb975d` parseAssistantResponse deleted; `c38fc1d` extractTag + getLastAssessmentCard deleted; `64d2f28` tagVocabulary deleted (+ stale knip entry removed — it had been masking the file); `4f257ad` llm/CLAUDE.md truth pass; `e463fc1` OTel (Task 3); `711841a` DevTools (Task 4).

Task 3: `src/instrumentation.ts` (registerOTel "nalu"), `src/lib/llm/telemetry.ts` (`llmTelemetry(functionId)` — reads `process.env.LLM_TELEMETRY` DIRECTLY, not getEnv, so mocked test paths don't force env validation; recordInputs/Outputs pinned false), threaded through generateChat/streamChat (`telemetryFunctionId` opt; executeTurn passes `label`, executeTurnStream passes `seed.kind`) + waveMidTurnAgent ("wave-mid").

Task 4: DevTools in provider.ts, double-gated (NODE_ENV=development + LLM_DEVTOOLS=1), **live-verified both ways** (probe wrote .devtools/generations.json with flags; nothing without). NOTE: every published @ai-sdk/devtools targets provider-spec V4, stack is V3 → documented `as unknown as LanguageModelV3Middleware` cast in provider.ts; drop on next ai major. Recipes `just dev-devtools` / `just llm-devtools`; `.devtools/` gitignored.

## Next Steps

1. **Task 5 — SKIP** (plan-conditional: streaming must be sole transport ≥1 stable release; it isn't). Leave `wave.submitTurn` + TODO entry.
2. **Task 6**: provider strategy note `docs/status/2026-07-16-provider-strategy.md` — fetch fresh: @ai-sdk/cerebras vs openai-compatible (strict/json-schema + tool support), Vercel AI Gateway vs `cerebrasRateLimit.ts` (per-user fast-lane semantics, key sharing with STT), recommendation + trigger conditions. Doc-only, no code. IMPORTANT context: app now on PAID Cerebras tier (constraint = token cost + latency, NOT 5 RPM — memory updated 2026-07-16).
3. Plan self-review checklist (plan lines ~261-268): grep `llm/parseAssistantResponse` returns nothing (verified); telemetry defaults off/redacted (tested in telemetry.test.ts); DevTools double-gated (verified); renderContext untouched (true); CLAUDE.mds describe only existing code.
4. PR to main (body: deletion evidence table from Task 1 greps — in this session's history; per-commit summaries above). CI green → **hand to Ollie to merge**.
5. After merge: dev-deploy sanity + optionally verify streaming renders incrementally (TODO.md entry, DevTools now available for it).

## Context to Preserve

- Never bypass hooks; commitlint = lowercase subjects (a `CLAUDE.md` in a subject failed once — reworded). bun not npm. Commit trailer: `Claude-Session: https://claude.ai/code/session_01F87wUziAM8oFNx2RhHUzDm`.
- Ollie was taught the full Phases 1-4 scope this session (teach skill, verified) — explain outcomes plainly, dialogue over quiz-dumps.
- Smoke ≈ $0.06; single calls ≈ cents; key shared with STT. Docker needed for integration tests (was running).
- Worktree `refactor+ai-sdk-output-object`; don't cd out; never bare-stash.

## Restart Hint

Tree clean, branch pushed. Resume: read this file + plan Task 6, write the strategy note, self-review, open PR. No code work in flight.
