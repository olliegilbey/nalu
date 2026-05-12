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
