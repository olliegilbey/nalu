# AI SDK modernization — Phase 3 Tasks 1–7 code done; browser re-verify + Task 8 next

## Task Overview

Implement the five-phase AI SDK modernization plan sequence in
`docs/superpowers/plans/` (dated 2026-06-10), phase by phase, each as its own
branch + PR to `main`. All plans reviewed and approved — do not re-litigate
their decisions; if installed SDK behavior diverges, resolve within the locked
decisions and note the deviation in the commit message. Ollie authorized "get
it all in": implement and land all phases, merging own PRs when CI is green.
Fully delegated — work autonomously, no permission-asking.

- Phase 1 (Output.object) — DONE, PR #31. Phase 2 (streaming) — DONE, PR #32.
- Phase 3 `2026-06-10-tool-calling-turn-actions.md` — **IN PROGRESS, this
  handoff.** Tasks 1–7 implemented and committed on
  `feat/tool-calling-turn-actions`; Task 7's manual browser verification is
  the only unfinished step; Task 8 (smoke/docs/PR) not started.
- Phase 4 `2026-06-10-agent-loop-scoping.md`, Phase 5
  `2026-06-10-llm-hygiene-observability.md` — pending, in that order, each
  cut off main after the prior merges. Read each plan IN FULL before starting.

## Reference Docs

- `docs/superpowers/plans/2026-06-10-tool-calling-turn-actions.md` — Phase 3
  plan. Task 7 (lines ~564–577): client tool parts + manual verification.
  Task 8 (lines ~580–591): smoke, CLAUDE.md ×4, TODO.md, finishing-a-branch.
  Self-review checklist (lines ~595–602). Task 1 carries the GO blockquote.
- @docs/status/2026-07-06-tool-call-probe-verdict.md — gate numbers + three
  BINDING findings (reasoning stripping, wire/validator split + UNION-FREE
  wire, invalid-input surfacing). Task 8 must honor these.
- @docs/status/2026-07-06-1400-ai-sdk-modernization.md — prior handoff:
  mandate detail, Tasks 1–5 file map, Phase-2 context.

## Current State

Branch `feat/tool-calling-turn-actions` (worktree
`.claude/worktrees/refactor+ai-sdk-output-object`; do not cd out; never
bare-stash — stash stack shared). Working tree CLEAN except this file + the
prior untracked handoff (2026-07-06-1400). All green: typecheck, lint (15
pre-existing warnings only), 479 unit, 163 integration, knip, pre-commit
hooks. A dev server may still be running on port 3000 (background task from
this session); kill or reuse.

Commits this session:

- `7e76810` feat(course): mid-turns dispatch through the tool loop; prompts
  rewritten for tools — plan Task 6. streamWaveTurn mid-turns run
  `executeToolTurnStream` + `buildWaveMidTurnTools`; collector adapts to
  `persistWaveMidTurn`'s EXISTING input at the call site; new
  `WaveSeedInputs.outputContract` ("json" default → blocking rollback path
  renders byte-identical prompts; "tools" → streaming) branches
  `teaching.ts` (role-block questionnaire noun + output-format block);
  streaming close turn passes "tools" so the wave's system prompt is
  cache-stable mid→close; new gate `src/lib/course/waveMidTurnGate.ts`
  (ValidationGateFailure reason `tool_turn_gate` added). WaveTurnUIMessage
  gains `InferUITools` typed tool parts. Integration tests rewritten to mock
  `streamToolChat` (mock handles invoke REAL tool executes). TODO.md notes
  the rollback-debt deletion.
- `9fa7d89` fix(course): union-free tool input schemas; client renders
  streamed questionnaire preview — plan Task 7 + a critical live-caught fix
  (see Discoveries). Client: `useWaveState.streamingQuestions` from the
  `tool-presentQuestionnaire` part at `input-available` (adapter
  `adaptStreamedToolQuestion`); `WaveSession` feeds Composer as preview
  (Composer unchanged — isPending disables it until committed
  activeQuestionnaire lands after `data-turn-result` → getState refetch;
  same question ids so Composer state carries across the swap).
  `streamWaveTurn.forwardToolChunk` allowlist-redacts questionnaire inputs
  (id/type/prompt/options/tier only) and DROPS tool-input-delta chunks.

Key files: `src/lib/course/waveTurnTools.ts` (FLAT schemas + canonical
mappers), `waveMidTurnGate.ts` (+test), `streamWaveTurn.ts`,
`streamWaveTurn.integration.test.ts`, `buildWaveSeed.ts`, `executeWaveMid.ts`,
`executeWaveClose.ts` (optional outputContract param, default "json"),
`src/lib/prompts/teaching.ts` (+test), `src/lib/types/context.ts`,
`src/lib/types/waveStream.ts`, `src/lib/course/adaptQuestionnaire.ts`,
`src/hooks/useWaveState.ts`, `src/components/chat/WaveSession.tsx`,
`src/lib/llm/parseAssistantResponse.ts`, `TODO.md`.

## Important Discoveries

1. **anyOf on the tool wire breaks gpt-oss-120b — reproduced live.** Task 4's
   original waveTurnTools wired the canonical discriminated-union
   `questionSchema`/`comprehensionSignalSchema`; the wire then carried
   `anyOf` and the model invented its own shape (options as ARRAY, camelCase
   `multipleChoice`, `question` not `prompt`, numeric `correct`) — 4/4
   invalid calls, in-loop self-correction NEVER converged (generic
   "No matching discriminator" errors), loop exhausted with EMPTY prose.
   FIX (in 9fa7d89): flat wire+validator schemas mirroring the probe-GO
   shape; verbatim mega-schema superRefine directives + new options/verdict
   directives; executes map flat → canonical so collector/persistence types
   unchanged. Wire verified union-free; live-probed 2× clean.
   `qualityScoreSchema` is a literal UNION — never put it on a tool wire
   (flat schema uses int 0–5 + cast in the mapper).
2. **Legacy waves make the model imitate JSON instead of calling tools.**
   Waves opened pre-tools carry mega-schema JSON assistant turns and
   sometimes an inline `<response_schema>` in replayed context; the model
   dumps the old JSON envelope as prose (observed on two dev waves).
   FIX: `waveMidTurnGate` rejects raw response-JSON prose (candidate `{`
   must parse to END of prose AND carry an envelope key — precision over
   recall) with a pattern-breaking retry directive. NOT yet live-verified on
   a legacy wave.
3. **Learner-visible message = ALL steps' streamed text**, accumulated at the
   call site (attemptState.prose), NOT `finalText` (last step only) — models
   write prose BEFORE tool calls. chat_log gets the accumulation;
   context_messages replay keeps per-step fidelity (no duplication).
4. streamToolChat's prepareStep reasoning-stripping WORKS in streaming
   (live-verified); a bare generateText with the same messages 400s on step 2
   (`reasoning_content` rejected by Cerebras) — any new tool-loop call site
   must strip per step.
5. The SDK puts the VALIDATED input on `tool-call` parts/`step.toolCalls`,
   so persisted tool rows and forwarded chunks carry the flat validated
   shape. Client `part.input` type comes from `InferUITools` but runtime is
   the REDACTED subset — hence `StreamedToolQuestion` adapter type.
6. Dev environment: DB is HOSTED Supabase (pooler eu-west-1) — no local
   psql; query via throwaway `scripts/.foo.tmp.ts` run with
   `bun run --env-file=.env.local` (files under `scripts/` resolve `@/`
   aliases; scratchpad files don't), DELETE the tmp script after. tRPC GET
   probe input shape is `?input={"courseId":...}` (no `json` wrapper). Real
   dev user id: `a0000000-0000-4000-8000-000000000001` (prior handoff's
   `...-0000-0001` abbreviation was wrong). Clean-context waves for
   verification: course `6fc69843-c4b9-438d-8202-5b7573dfa2ef` wave 1
   (Japanese) and `32013d23-ceec-4e07-ab7b-7136d6fac19c` wave 1
   (transformers) — each holds only the seeded opening assistant row. Legacy
   wave for the gate check: chess `f3342a4c-a395-436f-bb1a-6ba8ccbb51e8`
   wave 1. Browser automation via haiku subagent (memory: spare Fable).
7. The Task-7 browser runs this session BURNED turns on those dev waves
   (chess turn 4, Edo turns, Japanese turns 1–2 now hold JSON-as-prose
   assistant messages persisted before the gate existed). Don't be confused
   by that data; prefer the still-clean transformers wave for the next run.

## Next Steps

1. **Finish plan Task 7 step 2 — browser re-verification** (haiku subagent +
   claude-in-chrome, dev server `just dev`): on a clean wave (transformers
   course above), send "Teach me the first idea, then quiz me with one
   multiple-choice question." Expect: readable prose streams; quiz card
   preview appears above the composer at input-available DURING the stream
   (options disabled); card interactive after the turn result lands; no raw
   JSON. Optionally one legacy-wave turn (chess) to watch the new gate
   retry-recover. If model flakes once, retry once before diagnosing.
2. **Task 8**: extend live smoke with one tool-loop teaching turn (assert
   collector outcomes, not prose; pattern in `wave.live.test.ts`); update 4
   CLAUDE.md files (`src/lib/{course,turn,prompts,llm}/CLAUDE.md` — tool
   channel is the mid-turn structured-emission mechanism; mega-schema remains
   on scoping + close + rollback); TODO.md close-turn-tools note (plan ~586);
   `just check` + `just smoke`; plan self-review checklist (lines ~595–602);
   PR → main (body per PR #32), merge on green.
3. Phases 4–5 sequentially.

Where work stopped — most recent exchange, verbatim:

> **Assistant** (end of last turn): "**Remaining**: browser re-verification
> of the quiz-card preview on a clean wave (dev server still running), then
> Task 8 (smoke + docs + PR), then Phases 4–5. All of this, plus environment
> gotchas (hosted dev DB access pattern, real dev-user id, probe-script
> hygiene), is written to `docs/status/2026-07-08-phase3-task7-checkpoint.md`
> — the next context can resume from it directly."
> (That checkpoint file was superseded by THIS handoff and deleted.)
>
> **User**: "/handoff"

## Context to Preserve

- **Never bypass git hooks** (no --no-verify); fix root causes. **bun not
  npm**. Commit subjects lowercase (commitlint). Commit trailer exactly:
  `Claude-Session: https://claude.ai/code/session_01RaZinbh9BsfTdrtX1hWuJ8`
- **Never echo secret values**; Cerebras key in `.env.local` is shared with
  Ollie's STT work. Probe runs ≈ cents; smoke ≈ $0.06.
- Security: questionnaire `correct`/`freetextRubric` must NEVER reach the
  client pre-submission — streamed tool chunks are redacted server-side
  (allowlist in `streamWaveTurn.redactQuestionnaireInput`) and raw
  tool-input-delta chunks are dropped; committed cards use `correctEnc`
  obfuscation (spec §7.8). Preserve this on any forwarding change.
- The superRefine directive strings are prompt-engineered — never paraphrase
  (now in `waveTurnTools.ts`). LLM never sees/emits XP; tool executes are
  STAGING ONLY (no DB/XP/SM-2).
- Boundary lint warnings (`ai` imports outside `src/lib/llm/`) are
  warning-tier legitimate exceptions; Phase 5 revisits.
- User is learning from this project: lead with outcomes, explain
  load-bearing discoveries plainly.
- Blocking tRPC `wave.submitTurn` is the ROLLBACK transport — keep it
  byte-identical (outputContract "json") until TODO.md's joint deletion.

## Restart Hint

Working tree clean, both commits green — safe to /clear. Resume: read this
file, `just dev`, run Next Step 1's browser verification, then Task 8.
