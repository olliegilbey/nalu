# src/lib/turn

Stage-agnostic per-turn primitives.

`executeTurn` is the only thing in here. It owns: load prior rows → render
context → call the LLM → parse with the caller's parser → persist one
atomic batch (`user_message + assistant_response`, with optional
`failed_assistant_response + harness_retry_directive` retry exhaust
between).

- Used by scoping (`src/lib/course/`) today; teaching (`src/lib/wave/`) later.
- Parsers live in the caller (per-stage). Each parser throws
  `ValidationGateFailure` with a model-readable message — that message
  becomes the retry directive verbatim.
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
