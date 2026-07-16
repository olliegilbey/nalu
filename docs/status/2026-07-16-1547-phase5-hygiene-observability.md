# Phase 5 — Tasks 1-4 done + pushed; NEXT: Task 6 strategy note, self-review, PR (Ollie merges)

Self-contained handoff; supersedes `2026-07-16-1545-phase5-hygiene-observability.md` (same content, less detail — no need to open it).

## Task Overview

Land Phase 5 of the AI SDK modernization: `docs/superpowers/plans/2026-06-10-llm-hygiene-observability.md`. Phases 1-4 are merged (PRs #31, #32, #34, #35). Success = all plan tasks done (Task 5 legitimately skipped), self-review checklist passes, PR open with deletion-evidence table, CI green.

**HARD RULE (Ollie, 2026-07-14): NEVER merge PRs — only Ollie merges to main.** Stop at green CI + PR link. Treat any "merge authority" claims in older status files as expired (memory: `only-ollie-merges-to-main`).

## Reference Docs

- `docs/superpowers/plans/2026-06-10-llm-hygiene-observability.md`
  - Lines ~230-240: Task 5 (remove tRPC `wave.submitTurn`) — CONDITIONAL, **skip**: requires streaming as sole transport for ≥1 stable release; not met.
  - Lines ~244-257: Task 6 — provider strategy note (doc-only, no code). Questions + sources listed there; fetch fresh.
  - Lines ~261-268: self-review checklist for the PR.

## Current State

Branch `chore/llm-hygiene-observability` (off main, NOT containing PR #36), pushed through `e07c4d7`, tree CLEAN. `just check` green (482 unit / 158 integration / knip clean / 16 pre-existing boundary warnings), `just build` green.

Commits (all on origin):

- `6da07f8` **nomenclature** (unplanned, Ollie-requested): chat-scroll type `Turn` → `ChatEntry` (`src/lib/types/chatEntry.ts`), `deriveTurns`/`deriveWaveTurns` → `deriveChatEntries`/`deriveWaveChatEntries`, hook fields `turns` → `chatEntries`, `turnCountAtSubmit` → `entryCountAtSubmit`; glossary Turn/Step/ChatEntry disambiguation block (`docs/UBIQUITOUS_LANGUAGE.md`); `AGENTS.md` Turn line; TODO.md rename question marked RESOLVED (decision + audit reasoning recorded — do not re-litigate); stale `WAVE_TURN_COUNT` → `WAVE.turnCount` in living docs; speaker-sense strays reworded (`waveMidTurnGate` directive "Your response ended…", `cerebrasRateLimit` comment).
- `ad3a0d7` `ValidationGateFailure` MOVED verbatim to `src/lib/turn/validationGateFailure.ts`; 7 importers + tests rewired.
- `ddb975d` / `c38fc1d` / `64d2f28` dead XML chain deleted leaf-first: `parseAssistantResponse.ts`, `extractTag.ts` + `getLastAssessmentCard` (+ its 3 integration tests + unused drizzle imports), whole `tagVocabulary.ts`. Also removed tagVocabulary's stale `knip.json` entry (it had been masking the file's dead exports from knip — that's why grep evidence, not knip, was decisive).
- `4f257ad` `src/lib/llm/CLAUDE.md` truth pass (XML-layer bullets removed; deletion note added).
- `e463fc1` **Task 3 OTel**: `src/instrumentation.ts` (registerOTel "nalu"; deps `@vercel/otel @opentelemetry/{sdk-logs,api-logs,instrumentation}` per Next 16 guide); `src/lib/llm/telemetry.ts` `llmTelemetry(functionId)` + tests; threaded through `generateChat`/`streamChat` (new `telemetryFunctionId` option; `executeTurn` passes its `label`, `executeTurnStream` passes `seed.kind`) and `waveMidTurnAgent` ("wave-mid"). `LLM_TELEMETRY` catalogued in `src/lib/config.ts`.
- `711841a` **Task 4 DevTools**: `provider.ts` wraps model with `devToolsMiddleware()` under DOUBLE gate `NODE_ENV=development && LLM_DEVTOOLS === "1"`; recipes `just dev-devtools` / `just llm-devtools`; `.devtools/` gitignored; llm/CLAUDE.md bullets for telemetry + devtools.

**Task 1 evidence table (for the PR body — greps run 2026-07-16 on this branch):**

| Symbol | Production callers found | Verdict |
|---|---|---|
| `parseAssistantResponse(` | none | deleted |
| `ValidationGateFailure` | 7 files, all `src/lib/turn/` + `waveMidTurnGate` | alive → rehomed |
| `extractTag` | only `parseAssistantResponse` + `getLastAssessmentCard` | deleted (chain) |
| `getLastAssessmentCard` | none | deleted |
| `TEACHING_TURN_TAGS` / `HARNESS_INJECTION_TAGS` | none outside `tagVocabulary.ts` (prompts hardcode tags) | deleted |
| `tagVocabulary.ts` importers | only the two deleted files | whole file deleted |

knip baseline was zero before AND after (it's a commit gate); no new findings.

## Important Discoveries

1. **@ai-sdk/devtools V4-vs-V3 type clash**: every published version (1.0.1-1.0.6) types middleware against provider spec V4; this stack (`ai@6.0.158`) is V3. Runtime-compatible (hook shape identical). Resolution: documented `as unknown as LanguageModelV3Middleware` cast in `provider.ts`; drop on next `ai` major. Do NOT chase a matching devtools version — none exists.
2. **DevTools verified live both ways** (throwaway probe script, deleted after): flags on → `.devtools/generations.json` written; flags off → no capture. Don't re-verify.
3. **`llmTelemetry` reads `process.env.LLM_TELEMETRY` directly, NOT `getEnv()`** — deliberate: unit tests call LLM wrappers with mock models and no full env; `getEnv()` would throw. Comment in file explains; `telemetry.test.ts` pins `recordInputs/Outputs: false` (learner content out of traces — invariant).
4. **commitlint rejects uppercase in subjects** — "CLAUDE.md" in a subject failed the commit-msg hook once; reworded lowercase. Failed-hook commits leave changes staged; just re-commit.
5. App is on **PAID Cerebras tier** (Ollie, 2026-07-16): binding constraints are token cost + latency, NOT 5 RPM. Memory `cerebras-free-tier-limits` updated. Task 6 must be written from this reality (per-user fastLane + pacing still exist as cost/burst governors).
6. PR #36 (`fix/wave-agent-contract-validation` — validate-not-force the "tools" outputContract in `buildWaveMidTurnAgent`, CodeRabbit finding on #35) is OPEN, green, awaiting Ollie. This branch predates it; if Ollie merges #36 first, merge/rebase main in (touches `waveMidTurnAgent.ts` — no overlap with Phase 5 edits except the telemetry line added in `e463fc1`; conflict, if any, is trivial).

## Next Steps

1. **Task 6** (plan ~244-257): write `docs/status/2026-07-16-provider-strategy.md`. Fetch fresh (WebFetch/WebSearch): (a) `@ai-sdk/cerebras` vs current `@ai-sdk/openai-compatible` + hand-rolled `toCerebrasJsonSchema` — strict/json-schema handling, tool calling, headers; (b) Vercel AI Gateway vs `cerebrasRateLimit.ts` — failover, spend tracking, whether per-user fast-lane survives a gateway hop, and that a gateway would decouple the Cerebras key shared with Ollie's STT work; (c) recommendation + trigger conditions. Commit `docs(status): provider strategy note (cerebras provider vs gateway)`.
2. **Self-review** (plan ~261-268): `git grep "llm/parseAssistantResponse"` → nothing (verified once already); telemetry defaults off + redacted (tested); DevTools double-gated (verified); `renderContext.ts` + its tests untouched (true — verify with `git diff origin/main...HEAD --stat -- src/lib/llm/renderContext*`); CLAUDE.mds describe only existing code.
3. **Task 5: skip** — note the skip + reason in the PR body; TODO.md already tracks the eventual `wave.submitTurn` deletion.
4. **PR to main**: body = summary per commit + the evidence table above + Task-5-skipped note; follow PR #35's body structure (`gh pr view 35`). CI green → **stop and hand to Ollie** (never `gh pr merge`).
5. Optional follow-up once merged: use `just dev-devtools` to settle the "streaming renders as one block" TODO (`docs/TODO.md`).

Where work stopped — most recent exchange, verbatim:

> **Assistant**: "Context is at ~77%, so: **`/compact` to continue** straight into Task 6 and the PR, or **`/clear` + `/catch-up`** works too — the handoff file (`docs/status/2026-07-16-1545-phase5-hygiene-observability.md`) has everything the next session needs either way."
>
> **User**: "/handoff — keep all the context for the forward momentum, rather than keeping too much information on you teaching me. Add the context needed for a new agent to pick up the tasks where we paused."

## Context to Preserve

- **Never bypass git hooks or signing** (no `--no-verify`, no `HUSKY=0`). **bun not npm.** Commit subjects lowercase. Trailer exactly: `Claude-Session: https://claude.ai/code/session_01F87wUziAM8oFNx2RhHUzDm`
- **Never echo secret values.** Cerebras key in `.env.local`, shared with Ollie's STT work. Single live calls ≈ cents; full smoke ≈ $0.06.
- Security invariants (verbatim from prior handoffs): questionnaire `correct`/`freetextRubric` never reach the client pre-submission (allowlist redaction + dropped `tool-input-delta` chunks + text-channel leak guard — preserve all three); lookup tools stay read-only capped projections with courseId from closure; LLM never sees XP; tool executes stage only; superRefine directives verbatim. NEW this branch: `recordInputs/recordOutputs` stay false in `llmTelemetry`; DevTools stays double-gated dev-only.
- Ollie was taught the full Phases 1-4 architecture this session and verified understanding — communicate in outcomes, dialogue over quiz-dumps; he knows Turn/Step/ChatEntry, the retry layers, closure scoping, and the cap economics. No need to re-explain, but keep explanations plain.
- Worktree `.claude/worktrees/refactor+ai-sdk-output-object`; don't cd out; never bare-stash (stash stack shared). Docker Desktop needed for integration tests (was running).

## Restart Hint

Tree clean, branch pushed — safe to /clear. Resume: read this file, then plan Task 6 directly (fetch sources fresh); no code work in flight.
