# src/lib/course

Scoping steps. One file = one LLM call wrapped up.

- Each lib step: validate course state → run `executeTurn` with `responseSchema` (no translator helpers, no parser closures) → persist the wire shape directly to `courses.{column}` → return typed payload + `nextStage`.
- Untrusted input reaches the prompt envelope via `renderStageEnvelope`, which XML-escapes.
- Routers (`src/server/routers/`) sequence steps; UI never imports from here.
- `submitBaseline` is the scoping-close step: mechanical MC grading first, then one append-only `executeTurn` call against `makeScopingCloseSchema` (extends the shared `makeCloseTurnBaseSchema`), then `persistScopingClose` writes the widened JSONB, upserts concepts (default SM-2 — Pattern B, untaught), opens Wave 1 with `seedSource.scoping_handoff.blueprint`, inserts the assistant `openingText` row, flips status to `active`, and bumps `totalXp` — all in one transaction.
