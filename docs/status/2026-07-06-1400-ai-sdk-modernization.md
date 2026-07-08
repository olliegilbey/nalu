# AI SDK modernization — Phase 2 merged, Phase 3 Tasks 1–5 done, Task 6 next

## Task Overview

Implement the five-phase AI SDK modernization plan sequence in
`docs/superpowers/plans/` (dated 2026-06-10), phase by phase, each as its own
branch + PR to `main`. All plans are reviewed and approved as-is — do not
re-litigate their decisions; if installed SDK behavior diverges from a plan's
claims, resolve within the locked decisions and note the deviation in the
commit message (or stop and report if it can't be resolved). Ollie authorized
"get it all in": implement and land all phases, merging own PRs when CI is
green. He has delegated fully ("I'll defer to your expertise. Keep building
fantastically") — work autonomously, no permission-asking.

- Phase 1 `2026-06-10-ai-sdk-output-object.md` — DONE (PR #31).
- Phase 2 `2026-06-10-streaming-wave-turns.md` — **DONE, merged as PR #32**
  (main @ 1e1c5a5). Includes a verification-discovered fix: streaming fetch
  was missing the `x-dev-user-id` dev header → `devUserHeaders()` extracted
  in `src/lib/trpc.ts`, shared by tRPC link + DefaultChatTransport.
- Phase 3 `2026-06-10-tool-calling-turn-actions.md` — **IN PROGRESS, this
  handoff.** Tasks 1–5 of 8 committed on `feat/tool-calling-turn-actions`.
- Phase 4 `2026-06-10-agent-loop-scoping.md`, Phase 5
  `2026-06-10-llm-hygiene-observability.md` — pending, in that order, each
  cut off main after the prior merges. Read each plan IN FULL before starting.

Signing works again (commits land normally; commitlint rejects capitalized
subject lines — keep subjects lowercase).

## Reference Docs

- `docs/superpowers/plans/2026-06-10-tool-calling-turn-actions.md` — the
  Phase 3 plan. Task 6 (lines ~541–554): rewire mid-turn pipeline + prompts.
  Task 7 (lines ~558–570): client tool parts. Task 8 (lines ~574–585): smoke,
  CLAUDE.md ×4, TODO.md. Self-review checklist (lines ~589–596). Task 1 now
  carries a GO-verdict blockquote.
- @docs/status/2026-07-06-phase3-progress.md — per-task detail of commits
  1–5 AND the full Task 6 discovery/resolution notes (read it first).
- @docs/status/2026-07-06-tool-call-probe-verdict.md — gate numbers + the
  three BINDING findings (reasoning stripping, wire/validator split,
  invalid-input surfacing). Tasks 6–8 must honor these.

## Current State

Branch `feat/tool-calling-turn-actions` (worktree
`/Users/olliegilbey/code/nalu/.claude/worktrees/refactor+ai-sdk-output-object`;
do not cd out; never bare-stash — stash stack is shared). Working tree CLEAN;
all work committed and green (typecheck, lint, 459 unit, 86 db-integration,
knip). Commits: bab23e6 (probe+verdict), 940c871 (db kinds+migration 0009,
applied to local dev DB), 6f6c790 (renderContext union + contextAssembly tool
parts), c0ef6db (waveTurnTools + toToolInputSchema), fcea958
(streamToolChat + executeToolTurnStream + LLM.maxToolSteps), a1a3bd7 (status).

Key new/changed files: `scripts/probe-model.ts` (--tools mode),
`src/db/schema/contextMessages.ts` + `src/db/queries/contextMessages.ts`
(+2 kinds), `src/lib/llm/renderContext.ts` (LlmRenderedMessage is now a
union), `src/lib/turn/contextAssembly.ts`, `src/lib/llm/toCerebrasJsonSchema.ts`
(`toToolInputSchema`), `src/lib/course/waveTurnTools.ts`,
`src/lib/llm/streamToolChat.ts`, `src/lib/turn/executeToolTurnStream.ts`,
`src/lib/config/tuning.ts` (`LLM.maxToolSteps: 4`).
`comprehensionSignalSchema` is now exported from `src/lib/prompts/waveTurn.ts`.

## Important Discoveries

(Full detail in the two referenced status files; headlines only.)

1. Cerebras 400-rejects `reasoning_content` as an INPUT property —
   `streamToolChat`'s `prepareStep` strips assistant reasoning parts per step.
   Any new tool-loop call site must do the same.
2. Tool inputSchemas MUST use the wire/validator split (`toToolInputSchema`):
   `.nullish()` unions on the wire crater reliability 95%→44%; bare-optional
   wire + null-stripping validator scores 95–100%.
3. In multi-step flows, schema-invalid tool calls do NOT throw — they land in
   `step.toolCalls` flagged `invalid: true` plus a `tool-error` part fed back
   to the model (in-loop self-correction works; don't double-count).
4. Failed harness attempts persist as ONE `failed_assistant_response` JSON
   envelope — NEVER as tool-kind rows, or the recovered turn's rendered
   context breaks the cache-prefix invariant. Fresh tools/collector per
   attempt via `executeToolTurnStream`'s `makeAttempt` factory.
5. **Task 6 blocker-decision (queued, not made):** the blocking rollback path
   `executeWaveMid.ts` also consumes `waveMidTurnSchema`, and `teaching.ts`'s
   system prompt is shared by both transports. Recommended resolution +
   options are written in @docs/status/2026-07-06-phase3-progress.md — decide
   there before deleting anything.
6. Phase 2 smoke flaked once (baseline question-count) — re-run before
   diagnosing; Cerebras strict mode is soft guidance.
7. Commit trailer must be exactly
   `Claude-Session: https://claude.ai/code/session_01RaZinbh9BsfTdrtX1hWuJ8`.

## Next Steps

1. **Task 6**: resolve the mega-schema/teaching-prompt decision (see
   phase3-progress notes), then rewire `streamWaveTurn.ts` mid-turns through
   `executeToolTurnStream` + `buildWaveMidTurnTools`; adapt collector →
   `persistWaveMidTurn`'s EXISTING input shape at the call site (do not
   change the persistence module); `WaveTurnUIMessage` gains typed tool parts
   (`InferUITools`); update `streamWaveTurn.integration.test.ts`; commit.
2. **Task 7**: client — questionnaire card renders from
   `tool-presentQuestionnaire` part input at `input-available`, interactive
   only after `data-turn-result`. Manual verification: `just dev` + haiku
   subagent driving claude-in-chrome (dev course
   `0d47f467-b456-4324-8fc2-9a5b62338ee1` is owned by the dev user
   a0000000-...-0001; wave 1 open).
3. **Task 8**: extend live smoke with one tool-loop turn; update 4 CLAUDE.md
   files; TODO.md append (close-turn tools deferred, plan line ~582);
   `just check` + `just smoke`; self-review checklist; PR → main (body per
   PR #32's pattern), merge on green.
4. Phases 4–5 sequentially (session task list #6–7).

Where work stopped — most recent exchange, verbatim:

> **Assistant** (end of last turn): "One design decision is queued in
> `docs/status/2026-07-06-phase3-progress.md`: the blocking rollback path
> (`executeWaveMid`) also consumes the mega-schema the plan says to delete,
> and both paths share the teaching system prompt. My recommended resolution
> (keep the mega-schema alive for the rollback path only, branch the prompt's
> output-format block by transport) is written there. **Recommend `/compact`
> to continue** — Tasks 6–8 (pipeline rewiring, client generative UI, smoke +
> PR) remain, then Phases 4–5."
>
> **User**: "/handoff"

## Context to Preserve

- **Never bypass git hooks** (no --no-verify); pre-commit runs
  secrets/format/lint/typecheck/tests/knip; fix root causes.
- **bun not npm**. Cerebras key in `.env.local` is shared with Ollie's STT
  work — never echo secret values. Probe runs ≈ cents; smoke ≈ $0.06.
- Boundary lint warnings (`ai` imports outside `src/lib/llm/`) are
  warning-tier legitimate exceptions where plans place transport code;
  Phase 5 revisits.
- TSDoc on every export; comments explain WHY; Zod at all trust boundaries;
  LLM never sees/emits XP (tools are emission channels, not authority).
- The verbatim superRefine directive strings are prompt-engineered — never
  paraphrase them (they now live in `waveTurnTools.ts`).
- User is learning from this project: lead with outcomes, explain
  load-bearing discoveries plainly.
- Session task list: #5 Phase 3 in_progress, #6 Phase 4, #7 Phase 5 pending.
- Browser automation via haiku subagent (memory: spare Fable usage).
- Integration tests need Docker (`open -a Docker` if down). Migration 0009 is
  already applied to the local dev DB.

## Restart Hint

Working tree clean, all green — safe to /clear. Resume: read this file +
@docs/status/2026-07-06-phase3-progress.md, make the Task 6 prompt/schema
decision, then implement Task 6 on `feat/tool-calling-turn-actions`.
