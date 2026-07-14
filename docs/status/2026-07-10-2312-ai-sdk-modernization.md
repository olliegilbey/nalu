# AI SDK modernization — Phase 4 Tasks 1-3 committed + pushed; Task 4 (agent dispatch) next

## Task Overview

Implement the five-phase AI SDK modernization plan sequence in
`docs/superpowers/plans/` (dated 2026-06-10), phase by phase, each as its own
branch + PR to `main`. Plans reviewed and approved — do not re-litigate their
decisions; if installed SDK behavior diverges, resolve within the locked
decisions and note the deviation in the commit message. Ollie authorized
"get it all in": implement and land all phases, merging own PRs when CI is
green (`gh pr merge --merge --admin` — plain merge is blocked by branch
protection). Fully delegated — work autonomously, no permission-asking.

- Phases 1-3 MERGED (PRs #31, #32, #34).
- Phase 4 `2026-06-10-agent-loop-scoping.md` — **IN PROGRESS, this handoff.**
  Tasks 1-3 committed AND pushed on `feat/agent-loop-harness-tools`;
  Tasks 4-6 remain.
- Phase 5 `2026-06-10-llm-hygiene-observability.md` — pending, cut off main
  after Phase 4 merges. Read each plan IN FULL before starting.

## Reference Docs

- `docs/superpowers/plans/2026-06-10-agent-loop-scoping.md` — Phase 4 plan.
  Task 4 (lines ~280-299): dispatch via agent. Task 5 (lines ~303-314):
  due-review injection hint A/B. Task 6 (lines ~318-327): docs/TODO/finish.
  Self-review checklist (lines ~331-338). Preamble lines ~20-29 hold the
  agency-rejection list (already copied into `src/lib/agents/CLAUDE.md`).
- @docs/status/2026-07-08-1705-ai-sdk-modernization.md — prior handoff:
  Phase-3 close-out discoveries (client leak guard + reset-marker fix that
  Task 4 MUST preserve), verified ai@6.0.158 SDK facts for Task 4, dev-DB
  environment gotchas. Its "UNCOMMITTED/1Password locked" state is STALE —
  everything is now committed; the facts sections remain authoritative.
- @docs/status/2026-07-08-agent-loop-cost-gate.md — Task 1 GO verdict;
  raise `LLM.fastLaneCallsPerUser` 30→45 as part of Task 4's landing.

## Current State

Branch `feat/agent-loop-harness-tools`, rebased onto merged origin/main
(`709fd79`), pushed with tracking. Working tree CLEAN. All green: typecheck,
lint (0 errors; the 2 agents files carry expected `ai`-boundary warnings),
knip, prettier, unit suites. 1Password signing/ssh WORKS again.

Commits on the branch (all pushed):

- `b06ec3f` docs(scripts): probe JSDoc fix — closes the CodeRabbit PR #34
  finding (no thread reply posted; session was permission-denied for that).
- `37637a9` docs(status): cost-gate GO verdict + prior handoff.
- `78240bb` feat(agents): `waveLookupTools.ts` (+5 tests) — read-only
  `getDueConcepts`/`getConceptHistory`; caps via new `AGENT_LOOKUP` in
  `src/lib/config/tuning.ts`; name-keyed; NO XP/row ids on the wire;
  courseId closure-scoped; misses return `{notFound: true}` (never throw).
- `8871601` feat(agents): `waveMidTurnAgent.ts` (+4 tests) —
  `buildWaveMidTurnAgent({seed, courseId, model?})` → `{agent, collector,
  instructions}`; forces `outputContract: "tools"`; instructions
  byte-identical to `renderTeachingSystem(seed)` (tested);
  `cerebrasToolLoopPrepareStep` extracted+exported from
  `src/lib/llm/streamToolChat.ts` (param typed structurally as
  `{messages: LlmMessage[]}` — TS can't infer a TOOLS generic across
  assignment); `src/lib/agents/CLAUDE.md` written (incl. agency-rejection
  list, so Task 6 Step 1 is largely pre-done).

## Important Discoveries

1. All Phase-3 and SDK discoveries live in the two @-referenced docs — do
   not re-derive. Highest-stakes for Task 4: (a) preserve the client leak
   guard (`findJsonProseLeakIndex` cut in `streamWaveTurn.onTextDelta`) and
   the non-transient `data-turn-reset` marker semantics — the
   "json-imitation attempt" integration test pins both; (b) per-step pacing
   + reasoning-strip now ride the agent's constructor `prepareStep`
   (settings-level, NOT per-call — verified in installed types).
2. Task 4 system-message dedup: `agent.stream({messages})` where the agent
   carries `instructions` would double-send system if messages still start
   with one. `renderContext(seed,…).system === renderTeachingSystem(seed)`
   (renderContext.ts:110), so dropping the leading system message from
   `assembleLlmMessages` output is byte-safe — but FIRST verify how
   ToolLoopAgent merges instructions+messages in
   `node_modules/ai/src/agent/tool-loop-agent.ts`.
3. Knip deleted two forward-looking type exports (`WaveLookupTools`,
   `WaveMidTurnAgentUIMessage`) as unused — re-add them in Task 4 where the
   dispatch/client actually consume them (`InferAgentUIMessage` import from
   "ai" was also removed from waveMidTurnAgent.ts).
4. Scoped live runs: `CEREBRAS_LIVE=1 bun run --env-file=.env.local vitest
   run --project live <files>` — bare vitest misses `.env.local` and
   silently SKIPS as not-live (burned one run on this).
5. Main also carries PR #33 (analytics client_ip) — unrelated, no overlap.

## Next Steps

1. **Plan Task 4** (read plan lines ~280-299 first): `executeToolTurnStream`
   accepts an agent-based entry (`makeAttempt` returns the agent instance
   per attempt — keep fresh-per-attempt collector semantics); mock seam in
   `streamWaveTurn.integration.test.ts` moves from `streamToolChat` to a
   stub agent exposing `.stream()`; `streamWaveTurn` builds via
   `buildWaveMidTurnAgent`; re-export the agent UIMessage type through
   `src/lib/types/waveStream.ts`; integration test adds a scripted
   `getDueConcepts` turn (tool rows persist; next turn's rendered context
   includes them); add lookup-tool guidance to `src/lib/prompts/teaching.ts`
   tools-contract blocks (+tests); raise `fastLaneCallsPerUser` 30→45 with
   a WHY comment citing the cost-gate doc. Commit per plan Step 5.
2. **Plan Task 5**: `WAVE.dueReviewInjection: "full" | "hint"` tuning flag
   (default "full"); live A/B via smoke (does the model call getDueConcepts
   under "hint"? review coverage in questionnaires?); record numbers in
   docs/status/; flip default only if coverage holds.
3. **Plan Task 6**: TODO.md append (plan line ~324 verbatim), `just check` +
   `just smoke`, self-review checklist (plan lines ~331-338 — note
   "XP/SM-2/progression modules have zero diff" must hold for the BRANCH),
   PR → main (body per PR #34's structure), merge `--merge --admin` on
   green. Then Phase 5.

Where work stopped — most recent exchange, verbatim:

> **Assistant**: "`feat/agent-loop-harness-tools` is now on origin, tracking
> set up. Working tree is clean. [...] a fresh session via `/clear` +
> `/catch-up` would start clean with everything it needs — or I can keep
> going here. Your call."
>
> **User**: "/handoff"

## Context to Preserve

- **Never bypass git hooks** (no --no-verify). **bun not npm**. Commit
  subjects lowercase (commitlint). Commit trailer exactly:
  `Claude-Session: https://claude.ai/code/session_01RaZinbh9BsfTdrtX1hWuJ8`
- **Never echo secret values.** Cerebras key in `.env.local` is shared with
  Ollie's STT work; smoke ≈ $0.06, single live turns ≈ cents.
- Security invariants: questionnaire `correct`/`freetextRubric` never reach
  the client pre-submission (allowlist redaction + dropped input deltas +
  text-channel leak guard — preserve all three); lookup tools stay
  read-only capped projections with courseId from closure; LLM never
  sees XP; tool executes stage only; superRefine directives verbatim.
- Worktree `.claude/worktrees/refactor+ai-sdk-output-object`; don't cd out;
  never bare-stash (stash stack shared across sessions).
- Browser verification pattern: haiku subagent + claude-in-chrome (spare
  Fable). Dev user `a0000000-0000-4000-8000-000000000001`; hosted Supabase —
  throwaway `scripts/.foo.tmp.ts` + `bun run --env-file=.env.local`, delete
  after (no-console lint errors otherwise). A dev server may or may not be
  on port 3000 — the old background task was killed; restart with `just dev`.
- User is learning from this project: lead with outcomes, explain
  load-bearing discoveries plainly.

## Restart Hint

Working tree clean, branch pushed — safe to /clear. Resume: read this file,
the Phase 4 plan in full, then Next Step 1 (Task 4).
