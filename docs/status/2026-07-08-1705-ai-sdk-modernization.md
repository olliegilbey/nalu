# AI SDK modernization — Phase 3 MERGED; Phase 4 Tasks 1-3 code done, UNCOMMITTED (1Password locked)

## Task Overview

Implement the five-phase AI SDK modernization plan sequence in
`docs/superpowers/plans/` (dated 2026-06-10), phase by phase, each as its own
branch + PR to `main`. Plans are reviewed and approved — do not re-litigate.
Ollie authorized "get it all in": implement and land all phases, merging own
PRs when CI is green (use `gh pr merge --merge --admin`; plain merge is
blocked by branch protection). Fully delegated — work autonomously.

- Phases 1-3 MERGED (PRs #31, #32, #34). Phase 3's browser verification
  caught + fixed a live bug (see Discoveries 1-2).
- Phase 4 `2026-06-10-agent-loop-scoping.md` — **IN PROGRESS, this handoff.**
  Tasks 1-3 implemented, ALL UNCOMMITTED (see Blocker). Tasks 4-6 remain.
- Phase 5 `2026-06-10-llm-hygiene-observability.md` — pending, cut off main
  after Phase 4 merges. Read the plan IN FULL before starting.

## BLOCKER: 1Password vault locked

Git commit signing AND ssh fetch/push fail ("1Password: failed to fill whole
buffer") — worked earlier in the session, then the vault locked. Ollie was
push-notified. Until unlocked: no commits, no push, no fetch. Work continues
on disk. **Never bypass hooks or signing.**

## Current State

Branch `feat/agent-loop-harness-tools`, created from the local Phase-3 tip
`4bc4b3a` because fetch was down. The merged origin/main tree is IDENTICAL
(nothing else landed), so once auth returns: `git fetch origin main && git
rebase origin/main` (no-op content-wise, reattaches history), then commit the
pending work. Worktree `.claude/worktrees/refactor+ai-sdk-output-object`; do
not cd out; never bare-stash (stack shared).

All UNCOMMITTED changes (typecheck ✓, lint 0 errors ✓ — the 2 new agents
files carry the expected `ai`-boundary warnings, knip ✓, prettier ✓,
unit suites green):

1. `scripts/probe-model.ts` — JSDoc fix (CodeRabbit PR #34 finding: doc
   contradicted probe verdict finding 3). Commit as
   `docs(scripts): fix stale probe JSDoc - invalid tool calls surface in steps, not throws`
2. `docs/status/2026-07-08-agent-loop-cost-gate.md` — plan Task 1 verdict:
   **GO** with `fastLaneCallsPerUser` 30→45 raise proposed at Task-4 landing.
   Commit as `docs(status): agent-loop cost gate verdict`
3. Plan Tasks 2+3 (commit together or per plan's two commits):
   - `src/lib/agents/waveLookupTools.ts` (+test, 5 green) — read-only
     `getDueConcepts`/`getConceptHistory`; capped projections
     (`AGENT_LOOKUP` added to `src/lib/config/tuning.ts`); name-keyed; NO
     XP/ids on the wire; courseId bound by closure; misses return structured
     `notFound` (never throw — a throw burns a loop step).
   - `src/lib/agents/waveMidTurnAgent.ts` (+test, 4 green) —
     `buildWaveMidTurnAgent({seed, courseId, model?})` → `{agent, collector,
     instructions}`. ToolLoopAgent with emission+lookup tools,
     `stepCountIs(LLM.maxToolSteps)`, temperature/maxRetries from tuning,
     and the shared prepareStep. FORCES `outputContract: "tools"` on the
     seed before rendering instructions.
   - `src/lib/agents/CLAUDE.md` — rules incl. the plan's agency-rejection
     list (plan Task 6 Step 1 partially pre-done).
   - `src/lib/llm/streamToolChat.ts` — extracted exported
     `cerebrasToolLoopPrepareStep` (per-step `awaitCerebrasCallSlot` +
     assistant `reasoning`-part strip); param typed structurally as
     `{messages: LlmMessage[]}` because TS can't infer a TOOLS generic
     across assignment (PrepareStepFunction<TOOLS> variance).

## Verified SDK facts (installed ai@6.0.158 — trust these)

- `agent.tools` is a public getter; `agent.stream({messages})` →
  `Promise<StreamTextResult<TOOLS, OUTPUT>>` (same surface streamToolChat
  wraps). `prepareStep`/`stopWhen`/`instructions`/CallSettings are
  CONSTRUCTOR-level (ToolLoopAgentSettings); per-call params are
  prompt/messages/abortSignal/timeout/onStepFinish only.
- `renderContext(seed,…).system === renderTeachingSystem(seed)` for wave
  seeds (renderContext.ts:110) — agent instructions byte-identity is tested
  in waveMidTurnAgent.test.ts. Task 4 must NOT double-send system: drop the
  leading system message from `assembleLlmMessages` output when dispatching
  via agent (verify how ToolLoopAgent merges instructions+messages in
  node_modules/ai/src/agent/tool-loop-agent.ts first).
- Queries for lookups exist: `getDueConceptsByCourse(courseId, now)` (due
  ASC), `getConceptByNameForCourse(courseId, name)` → `Concept | null`,
  `getAssessmentsByConcept(conceptId)` (DESC). Assessment carries
  `xpAwarded` — NEVER project it into tool output.

## Important Discoveries (Phase 3 close-out, this session)

1. **Failed-attempt output leaked to client** (caught in live browser
   verify): attempt-0 JSON-imitation prose (incl. `correct` key) streamed as
   text deltas — text channel bypasses ALL tool-chunk redaction. Fixes in
   merged `41fc64d`: (a) `data-turn-reset` is a NON-transient in-message
   marker part; `useWaveState` slices parts after the last marker
   (mid-stream `setMessages` is undone by the SDK's next chunk);
   (b) `streamWaveTurn.onTextDelta` cuts client forwarding at an unfenced
   line-start `{` (`findJsonProseLeakIndex` in `waveMidTurnGate.ts`).
   Preserve BOTH on any Task-4 dispatch rework — the integration test
   "json-imitation attempt" pins this.
2. `waveMidTurnGate` retry-recovers live: model dumped tool-input JSON as
   prose on a CLEAN wave (not just legacy waves); gate directive worked
   first retry. renderContext's retry filter keeps recovered turns clean.
3. Live smoke instrumented run (2026-07-08, paid tier): 16 LLM calls in
   23.3s (~1.5s/call); tool-loop turn = 2 steps. Full numbers in the cost-
   gate doc. Blocking-path turns still show `signals=0` grading omissions —
   the tool gate fixes this on streaming only (expected).
4. To run scoped live tests, `just smoke` env loading requires:
   `CEREBRAS_LIVE=1 bun run --env-file=.env.local vitest run --project live <files>`
   (bare vitest misses `.env.local` → silently SKIPS as not-live).
5. PR-comment posting via `gh api` was permission-denied for the session
   (external-write classifier). CodeRabbit PR #34 thread has no reply; the
   JSDoc fix (pending item 1) addresses it.

## Next Steps

1. When 1Password unlocks: `git fetch origin main && git rebase origin/main`,
   then make the 3 pending commits (order above), `git push -u origin
   feat/agent-loop-harness-tools`.
2. **Plan Task 4**: dispatch mid-turns through the agent. executeToolTurnStream
   accepts `{agent}` (drop tools+model+makeAttempt's tool half? read the plan
   lines 280-299); mock seam in its tests moves to a stub agent with
   `.stream()`; streamWaveTurn builds via buildWaveMidTurnAgent; re-export
   the agent-derived UIMessage type from `src/lib/types/waveStream.ts`
   (re-add `WaveMidTurnAgentUIMessage` — it was knip-deleted as unused, same
   for `WaveLookupTools` if needed); integration test adds a scripted
   `getDueConcepts` turn asserting tool rows persist + next-turn context
   renders them; add lookup-tool guidance to teaching.ts prompts (+tests).
3. **Plan Task 5**: due-review injection hint mode behind
   `WAVE.dueReviewInjection` flag, live A/B via smoke, flip only if coverage
   holds; record numbers in docs/status/.
4. **Plan Task 6**: agents CLAUDE.md updates (mostly pre-done), TODO.md
   append (plan line ~324), `just check` + `just smoke`, self-review
   checklist (plan lines ~331-338: no write tools, stepCountIs everywhere,
   pacing survived, capped outputs, zero diff in scoring/SR/progression),
   PR → main (body per PR #34), merge `--merge --admin` on green.
5. Phase 5.

## Context to Preserve

- **bun not npm**; commit subjects lowercase; trailer exactly:
  `Claude-Session: https://claude.ai/code/session_01RaZinbh9BsfTdrtX1hWuJ8`
- Browser verification via haiku subagent + claude-in-chrome (memory).
  Dev server may still be running on port 3000 (node, old PID 51149).
  Dev user `a0000000-0000-4000-8000-000000000001`; hosted Supabase (no local
  psql) — query via throwaway `scripts/.foo.tmp.ts` + `bun run
  --env-file=.env.local`, DELETE after (they trip no-console lint errors).
- Transformers dev course `32013d23-ceec-4e07-ab7b-7136d6fac19c` wave 1 now
  holds turns 1-2 (gate-recovered turn 1 incl. failed_assistant_response
  rows + open questionnaire answered) — fine for further turns.
- LLM never sees XP; lookup tools are read-only capped projections; tool
  executes stage only. superRefine directive strings verbatim.
- Smoke ≈ $0.06; probe/live single turns ≈ cents. Cerebras key shared with
  Ollie's STT work.

## Restart Hint

Read this file + the Phase 4 plan (`docs/superpowers/plans/
2026-06-10-agent-loop-scoping.md`) in full. Check `git status` — if the
pending changes are still uncommitted, 1Password may still be locked; test
with a small commit before batching. Then Next Steps in order.
