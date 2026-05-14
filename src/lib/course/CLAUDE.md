# src/lib/course

Scoping steps. One file = one LLM call wrapped up.

- Each lib step: validate course state → run `executeTurn` with `responseSchema` (no translator helpers, no parser closures) → persist the wire shape directly to `courses.{column}` → return typed payload + `nextStage`.
- Untrusted input reaches the prompt envelope via `renderStageEnvelope`, which XML-escapes.
- Routers (`src/server/routers/`) sequence steps; UI never imports from here.
- `gradeBaseline` follows the same shape: mechanical MC pass first, then `executeTurn(gradeBaselineSchema)` only if any answer is freetext. All-MC answer batches skip the LLM call entirely.
