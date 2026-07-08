# src/lib/turn

Stage-agnostic per-turn primitives.

`executeTurn` (blocking) and `executeTurnStream` (streaming; adds
progressText/onTextDelta/onAttemptStart hooks) share one contract: load
prior rows → assemble context (`contextAssembly.ts`) → call the LLM →
validate via Output.object → persist one atomic batch (`user_message +
assistant_response`, with optional `failed_assistant_response +
harness_retry_directive` retry exhaust between). Persisted rows, retry
budget, and ValidationGateFailure semantics are identical across both —
tests assert the same row sequences for each.

`executeToolTurnStream` is the third sibling for TOOL-loop turns
(`streamToolChat` instead of `Output.object`): callers supply a
`makeAttempt` factory (fresh tool set + collector per attempt — retries
must not inherit staged state) and a post-loop `validateTurn` gate. Each
step persists `assistant_tool_call` + `tool_result` rows, then the final
prose as `assistant_response`; failed attempts collapse to
`failed_assistant_response` (JSON envelope of the step trail) +
`harness_retry_directive` — never tool-kind rows — so renderContext's
retry filter keeps working. Learner-visible prose = ALL steps' streamed
deltas accumulated at the call site, NOT `finalText` (last step only).

- Used by scoping (`src/lib/course/`) today; teaching (`src/lib/wave/`) later.
- Validation: callers supply a `responseSchema` (Zod). `generateChat`
  validates via the SDK's `Output.object` (JSON-parse + `safeParse`,
  refines included) and throws `NoObjectGeneratedError` on failure;
  `executeTurn` converts that to
  `ValidationGateFailure("missing_response", <directive>)`, where the
  directive is re-derived from the raw text so its strings are identical
  to the pre-SDK implementation. Zod's error message includes field
  paths, issue codes, and refine `.message` strings — that JSON becomes
  the retry directive.
- Transport errors (timeouts, 5xx) propagate untouched; no rows are
  persisted on transport failure.

Do not put per-stage logic here. If a turn-shape needs stage-specific
behaviour, that belongs in the caller's lib step, not behind a flag here.

## Live-smoke observability

`formatTurn.ts` + `diagnoseFailure.ts` provide per-turn stderr output
gated on `CEREBRAS_LIVE=1`. Default is verbose (header + prompt +
response + parse outcome per attempt); `NALU_SMOKE_QUIET=1` collapses
success to a one-line ✓ summary and only flushes the prompt/response
trail on failure. Prompt and response bodies are uncolored (raw bytes);
status, diagnosis, and retry directives use ANSI color when stderr is a
TTY and `NO_COLOR` is unset. Callers tag their turns with `label`
(`"clarify"`, `"framework"`, `"baseline"`) and may pass a
`successSummary` projection for the ✓ line.
