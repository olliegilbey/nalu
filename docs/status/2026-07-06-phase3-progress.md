# Phase 3 (tool-calling turn actions) — Tasks 1–5 done, Task 6 next

Branch `feat/tool-calling-turn-actions` (off main @ 1e1c5a5, Phase 2 merged as
PR #32). Plan: `docs/superpowers/plans/2026-06-10-tool-calling-turn-actions.md`.
Phase 2 (streaming wave turns) is fully merged; Phases 4–5 pending after this.

## Committed (all green: typecheck, unit, knip)

1. `bab23e6` probe + **GO verdict** — see
   @docs/status/2026-07-06-tool-call-probe-verdict.md (95.0%/100.0%, median 2
   steps; three BINDING findings: per-step reasoning stripping, wire/validator
   split for tool schemas, invalid inputs land flagged in step.toolCalls).
2. DB kinds `assistant_tool_call` + `tool_result` (+ migration 0009, applied
   locally; round-trip integration test).
3. renderContext structured union + contextAssembly ModelMessage tool parts
   (byte-stability tests untouched; `contentOf` accessor was type-only).
4. `waveTurnTools.ts` — collector + tools; `toToolInputSchema` (llm layer)
   implements the wire/validator split; mega-schema superRefine directives
   verbatim. `comprehensionSignalSchema` now exported from waveTurn.ts.
5. `streamToolChat` + `executeToolTurnStream` + `LLM.maxToolSteps: 4`.
   Failed attempts persist ONE failed_assistant_response JSON envelope (never
   tool-kind rows) to keep the recovered-turn cache-prefix invariant; fresh
   tools/collector per attempt via `makeAttempt` factory.

## Next (plan Tasks 6–8)

6. Rewire `streamWaveTurn` mid-turns through `executeToolTurnStream` +
   `buildWaveMidTurnTools`; adapt collector → `persistWaveMidTurn`'s existing
   input at the call site (do NOT change the persistence module). Rewrite
   `teaching.ts` system prompt for tools (update golden tests). Dismantle
   `waveMidTurnSchema` (keep envelope renderer, drop its `responseSchema`
   param). `WaveTurnUIMessage` gains typed tool parts (`InferUITools`).
   Then integration tests for streamWaveTurn.

   **DISCOVERY (resolve before deleting the mega-schema):** the BLOCKING
   rollback path `executeWaveMid.ts` (behind tRPC `wave.submitTurn`) also
   consumes `waveMidTurnSchema` + `renderWaveTurnEnvelope(responseSchema)`,
   and `persistWaveMidTurn`/`executeWaveMid.grade`/`.insert` type against
   `WaveMidTurn`. The plan's Task 6 file list does not touch executeWaveMid.
   Resolution consistent with the plan's locked decisions: KEEP
   `waveMidTurnSchema` (and the envelope's `responseSchema` param) alive for
   the blocking path only; the streaming path stops importing them. Note the
   deviation in the commit message and add a TODO.md line to delete the
   mega-schema together with tRPC `wave.submitTurn` after one stable release
   (both are the same rollback debt). Also: `teaching.ts` system prompt is
   SHARED by both paths — rewriting it for tools while the blocking path
   still expects mega-schema JSON output would break the rollback path's
   prompt contract. Options: branch the output-format block on transport
   (teaching.ts takes a mode param), or accept that the rollback path
   degrades. DECIDE with fresh eyes; prompt tests are golden-string.
7. Client: questionnaire card renders from `tool-presentQuestionnaire` part
   input at `input-available`; interactive only after `data-turn-result`.
   Manual verification via `just dev` + browser (haiku subagent pattern).
8. Live smoke extension (one tool-loop turn), CLAUDE.md updates ×4, TODO.md
   append (close-turn tools deferred note), `just check` + `just smoke`, PR.

Self-review checklist at plan end; signing works (commits land normally).
Close turns stay on the Phase-2 blocking path in this phase.
