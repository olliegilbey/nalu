# src/lib/course

Scoping steps. One file = one LLM call wrapped up.

- Each lib step: validate course state → run `executeTurn` with `responseSchema` (no translator helpers, no parser closures) → persist the wire shape directly to `courses.{column}` → return typed payload + `nextStage`.
- Untrusted input reaches the prompt envelope via `renderStageEnvelope`, which XML-escapes.
- Routers (`src/server/routers/`) sequence steps; UI never imports from here.
- `submitBaseline` is the scoping-close step: mechanical MC grading first, then one append-only `executeTurn` against `makeScopingCloseSchema` (extends the shared `makeCloseTurnBaseSchema`). `persistScopingClose` then widens the JSONB, upserts concepts at default (untaught) SM-2, opens Wave 1 from `seedSource.scoping_handoff.blueprint`, seeds the assistant `openingText`, flips status to `active`, and bumps `totalXp` — one transaction.
