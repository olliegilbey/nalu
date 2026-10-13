# src/lib/turn

Stage-agnostic per-turn primitives.

`executeTurn` runs one structured turn, blocking: load prior rows →
assemble context (`contextAssembly.ts`) → call the LLM → validate via
Output.object → persist one atomic batch (`user_message +
assistant_response`, with optional `failed_assistant_response +
harness_retry_directive` retry exhaust between).

`executeToolTurnStream` is its sibling for TOOL-loop turns
(`agent.stream()` on a ToolLoopAgent from `src/lib/agents/` instead of
`Output.object`): callers supply a `makeAttempt` factory (fresh agent +
collector per attempt — retries must not inherit staged state) and a
post-loop `validateTurn` gate. The dispatcher DROPS the assembled
message list's leading system message — the agent's constructor
`instructions` carries identical bytes (double-send would duplicate the
system prompt on the wire). Each
step persists `assistant_tool_call` + `tool_result` rows (mapped by the
pure `toolStepRows.ts`), then the final
prose as `assistant_response`; failed attempts collapse to
`failed_assistant_response` + `harness_retry_directive` — never tool-kind
rows — so renderContext's retry filter keeps working. Learner-visible
prose = ALL steps' streamed deltas, NOT `finalText` (last step only).

A failed tool-loop attempt persists as that prose, cut at
`findJsonProseLeakIndex` and trimmed, with no tool trail (#140). The retry
replays it as the model's previous reply, and this model imitates JSON
replies in history. Replayed tool results would also claim staged work
that died with the attempt. When nothing safe was shown, the row is `""`;
Cerebras accepts an empty assistant message (live test
`streamWaveTurn.retryReplay.live.test.ts`). Rows written before this
change hold a `{text, steps}` JSON envelope; they render unchanged.

- Callers live in `src/lib/course/`: scoping turns and the Wave close turn
  run `executeTurn`; Wave mid-turns run `executeToolTurnStream`.
- Validation: callers supply a `responseSchema` (Zod) and its wire name
  (`responseSchemaName`). That is all; `executeTurn` owns the retry
  directive. `generateChat` validates via the SDK's `Output.object`
  (JSON-parse + `safeParse`, refines included) and throws
  `NoObjectGeneratedError` on failure. `executeTurn` converts that to
  `ValidationGateFailure("missing_response", <detail>)`. The detail is
  re-derived from the raw text, so its strings are identical to the
  pre-SDK implementation: Zod's issue-list JSON, with field paths, issue
  codes, and refine `.message` strings. `executeTurn` then builds the
  directive with `buildRetryDirective` (`retryDirective.ts`). It flattens
  the issues to `- field path: message` bullets and re-attaches the
  schema. Weak models act on that prose but misread raw issue JSON (seen
  on the retired `llama3.1-8b`). The schema string is built lazily, at
  most once per Turn. `retryDirective.callSites.test.ts` in
  `src/lib/course/` pins the directive bytes.
- Transport errors (timeouts, 5xx) propagate untouched; no rows are
  persisted on transport failure. In the tool loop, the SDK does not throw:
  a failed Step emits an `error` stream part and still resolves `steps`
  with the earlier Steps, and a provider chunk error emits one without
  closing the stream. `executeToolTurnStream` rethrows any `error` part's
  error, so a partial loop never reaches the gate or the DB. A tool call
  with no result and no tool-error throws `UnpairedToolCallError`
  (`toolStepRows.ts`) instead of persisting: Cerebras rejects an
  unanswered call on replay.

Do not put per-stage logic here. If a turn-shape needs stage-specific
behaviour, that belongs in the caller in `src/lib/course/`, not behind a flag here.

## Live-smoke observability

`formatTurn.ts` + `diagnoseFailure.ts` provide per-turn stderr output
gated on `CEREBRAS_LIVE=1`. Default is verbose (header + prompt +
response + parse outcome per attempt); `NALU_SMOKE_QUIET=1` collapses
success to a one-line ✓ summary and only flushes the prompt/response
trail on failure. Prompt and response bodies are uncolored (raw bytes);
status, diagnosis, and retry directives use ANSI color when stderr is a
TTY and `NO_COLOR` is unset. Callers tag their turns with `label`
(`"clarify"`, `"framework"`, `"baseline"`, `"scoping-close"`,
`"wave-close"`) and may pass a `successSummary` projection
for the ✓ line.

`LLM_DEBUG_GRADINGS=1` adds `[grading-debug]` stderr lines for issue #22:
a parse-failure line here (Zod issue paths + the `gradings` fragment), and
per-grading and strip-path lines at both close paths
(`src/lib/course/closeGradingDebug.ts`). Gate and formatters live in
`src/lib/observability/gradingDebug.ts`. The gate fails closed: it is on
only under `NODE_ENV` `development` or `test`. Wrap any new content log in
that gate.
