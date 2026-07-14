# AI SDK modernization — Phase 4 Tasks 1-5 committed + pushed; Task 6 (finish branch) next

## Task Overview

Implement the five-phase AI SDK modernization plan sequence in
`docs/superpowers/plans/` (dated 2026-06-10), phase by phase, each as its own
branch + PR to `main`. Plans reviewed and approved — do not re-litigate their
decisions. Ollie authorized "get it all in": implement and land all phases,
merging own PRs when CI is green (`gh pr merge --merge --admin` — plain merge
is blocked by branch protection). Fully delegated — work autonomously.

- Phases 1-3 MERGED (PRs #31, #32, #34).
- Phase 4 `2026-06-10-agent-loop-scoping.md` — Tasks 1-5 DONE, committed AND
  pushed on `feat/agent-loop-harness-tools`. **Only Task 6 remains** (docs,
  TODO, smoke, self-review, PR, merge).
- Phase 5 `2026-06-10-llm-hygiene-observability.md` — pending, cut off main
  after Phase 4 merges. Read the plan IN FULL before starting.

## Reference Docs

- `docs/superpowers/plans/2026-06-10-agent-loop-scoping.md` — Phase 4 plan.
  Task 6 (lines ~318-327): CLAUDE.md updates (ALREADY DONE in Task 4/5
  commits), TODO.md append (line ~324 verbatim), `just check` + `just smoke`,
  then superpowers:finishing-a-development-branch. Self-review checklist
  (lines ~331-338).
- @docs/status/2026-07-11-due-injection-ab.md — Task 5 verdict: default
  STAYS "full"; hint mode never triggered an unprompted getDueConcepts
  (2/2 runs). Numbers + re-test triggers there.
- @docs/status/2026-07-08-agent-loop-cost-gate.md — Task 1 GO verdict; the
  proposed fastLane 30→45 raise LANDED in commit `4f5e12b`.

## Current State

Branch `feat/agent-loop-harness-tools`, pushed, working tree CLEAN, all
green: `just check` (0 lint errors; 16 warnings all pre-existing expected
`ai`/drizzle-boundary ones), 503 unit + 161 integration tests.

Commits this session (on top of Tasks 1-3, see prior handoff):

- `402a406` docs(status): phase-4 tasks 1-3 handoff.
- `4f5e12b` **Task 4**: `executeToolTurnStream` now takes a per-attempt
  agent (`ToolTurnAttempt = {agent, validateTurn}`, structural
  `ToolTurnAgent<TOOLS>` interface, generic to dodge TextStreamPart
  variance); drops the leading system message before dispatch (agent
  `instructions` carries identical bytes — ToolLoopAgent maps
  instructions→system and passes messages untouched, verified in
  node_modules/ai/src/agent/tool-loop-agent.ts:82-89);
  `src/lib/llm/streamToolChat.ts` DELETED (prepareStep moved verbatim to
  `src/lib/llm/cerebrasToolLoopPrepareStep.ts`; rate-limit header recording
  moved to constructor-level `onStepFinish` in `waveMidTurnAgent.ts` — now
  records EVERY step); `streamWaveTurn` builds a fresh agent per attempt via
  `buildWaveMidTurnAgent` and RETURNS the loop's summed usage (null on close
  turns) for smoke logging; `WaveTurnUITools = InferUITools<
  WaveMidTurnAgentTools>` (new export, emission+lookup) in waveStream.ts;
  integration seam moved to `buildWaveMidTurnAgent` spy (real builder,
  stubbed `.stream()`, REAL tool executes — capture-original-before-spy to
  avoid live-binding recursion); new lookup-turn integration test (real
  getDueConcepts against testcontainer DB, rows persist, next turn's
  dispatched messages replay them, no system message in messages);
  teaching.ts tools contract gained lookup guidance (+tests);
  `fastLaneCallsPerUser` 30→45; four CLAUDE.md files updated (turn, llm,
  course, agents). DEVIATION from plan noted in commit: no
  `WaveMidTurnUIMessage` re-export (nothing consumes it; knip would
  re-delete).
- `2584270` **Task 5**: `WAVE.dueReviewInjection: "full"|"hint"` (+ exported
  `WaveDueReviewInjection` type) in tuning.ts, default "full";
  `renderDueBlock` in teaching.ts renders the hint ONLY under the tools
  contract (json path has no lookup tools, always full list); hint-mode
  tests in separate file `teaching.dueInjection.test.ts` (file-level tuning
  mock); live smoke seeds a genuinely due concept + logs
  `dueInjection/lookupCalls/questionnaireConcepts/dueCovered/tokens`
  forensics; A/B verdict doc; one flag line in prompts/CLAUDE.md.

## Important Discoveries

1. **Task 4 was live-verified end-to-end on the dev deployment**
   (2026-07-10): one real turn on the transformers course
   (`32013d23-ceec-4e07-ab7b-7136d6fac19c`, wave 1, now at turnIndex 3 with
   an OPEN questionnaire — answer it before sending chat-text) — model
   called BOTH getDueConcepts and getConceptHistory, json-imitation gate
   retried + recovered, answer key never crossed the wire (`correctEnc`
   only), tool rows persisted in production shape. Route guards probed:
   chat-text-while-questionnaire-open rejects, malformed payload 400s.
2. **1Password locks intermittently**: `ssh-add -l` on the 1P agent socket
   succeeds even when LOCKED (public keys are listable) — the ONLY valid
   probe is `op-ssh-sign` itself: `echo probe |
   /Applications/1Password.app/Contents/MacOS/op-ssh-sign -Y sign -n git -f
   <file-with-user.signingkey>`. Never bypass signing/hooks; poll + notify.
3. Docker Desktop cannot be started headlessly (`open -a Docker` silently
   no-ops); ask Ollie. Integration/live suites need it (testcontainers).
4. Scoped live runs: `CEREBRAS_LIVE=1 bun run --env-file=.env.local vitest
   run --project live <file>` (bare vitest misses .env.local and silently
   skips). `NALU_SMOKE_QUIET=1` collapses output.
5. Task 5 A/B confound to remember: dueCovered=true under hint was via the
   blueprint's planned concept, NOT the lookup — don't re-read it as "hint
   works". Details in the A/B doc.
6. Prior SDK facts (ToolLoopAgent surface, byte-identity, queries) live in
   @docs/status/2026-07-10-2312-ai-sdk-modernization.md — still accurate.

## Next Steps

1. **Task 6** (plan lines ~318-327): Step 1 CLAUDE.md updates are already
   done (verify nothing new to add). Step 2: append to TODO.md verbatim from
   plan line ~324 (agent-loop follow-ups: close-turn agent; scoping clarify
   as adaptive agent design-only; createAgentUIStreamResponse evaluation;
   MCP out of scope). Step 3: `just check` + `just smoke` (full smoke ≈
   $0.06; needs Docker + 1Password for nothing, but .env.local for live).
2. Self-review checklist (plan lines ~331-338): no write tools; stepCountIs
   everywhere / no isLoopFinished; prepareStep pacing survived (it did —
   plus onStepFinish header recording); capped tool outputs; cost-gate + A/B
   numbers in docs/status/ (done); `git diff main...HEAD --stat` must show
   ZERO diff in src/lib/{scoring,spaced-repetition,progression}/.
3. PR → main (body per PR #34's structure), CI green, then
   `gh pr merge --merge --admin`. Session PR-comment writes were
   permission-denied before (CodeRabbit replies) — fine to skip replies.
4. Then Phase 5 on a fresh branch off updated main.

Where work stopped — most recent exchange, verbatim:

> **Assistant**: "Task 5 is landed and pushed (`2584270`). Clean checkpoint —
> tree is clean, branch is on origin, all checks green. [...] Context is at
> ~77%, so I'd recommend `/clear` + `/catch-up` for Task 6 — but the latest
> status file is from Tasks 1-3, so say the word and I'll write a fresh
> `/handoff` first (30 seconds), which is the cleaner path. Or `/compact` to
> continue here."
>
> **User**: "/handoff"

## Context to Preserve

- **Never bypass git hooks or signing** (no --no-verify, no HUSKY=0).
  **bun not npm**. Commit subjects lowercase (commitlint). Commit trailer
  exactly: `Claude-Session: https://claude.ai/code/session_01RaZinbh9BsfTdrtX1hWuJ8`
- **Never echo secret values.** Cerebras key in `.env.local` shared with
  Ollie's STT work. Smoke ≈ $0.06; single live turns ≈ cents.
- Security invariants (verbatim from prior handoff): questionnaire
  `correct`/`freetextRubric` never reach the client pre-submission
  (allowlist redaction + dropped input deltas + text-channel leak guard —
  preserve all three); lookup tools stay read-only capped projections with
  courseId from closure; LLM never sees XP; tool executes stage only;
  superRefine directives verbatim.
- Worktree `.claude/worktrees/refactor+ai-sdk-output-object`; don't cd out;
  never bare-stash (stash stack shared across sessions).
- Dev user `a0000000-0000-4000-8000-000000000001`; hosted Supabase — DB
  forensics via throwaway `scripts/.foo.tmp.ts` + `bun run
  --env-file=.env.local`, DELETE after (no-console lint). Dev server:
  `just dev` (none left running; Docker Desktop was left up).
- User is learning from this project: lead with outcomes, explain
  load-bearing discoveries plainly.

## Restart Hint

Tree clean, branch pushed — safe to /clear. Resume: read this file, then
plan Task 6 (lines ~318-338 of the Phase 4 plan) straight away; no code
work is in flight.
