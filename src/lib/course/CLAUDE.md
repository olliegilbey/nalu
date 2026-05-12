# src/lib/course

Scoping steps. One file = one LLM call wrapped up. Wire prompts (`src/lib/prompts/`) to the LLM (`src/lib/llm/`) and return validated payloads. No prompt text, no DB access, no scoring logic.

- Each lib step: validate course state → run `executeTurn` with the stage-specific seed, user-message content, and parser → translate the parsed projection to the JSONB storage shape via a `to*Jsonb(...)` helper → persist to `courses.{column}` → return typed payload + `nextStage`. No prompt text, no DB access beyond the listed queries, no scoping logic. Note: `gradeBaseline.ts` still uses the legacy `generateStructured` path pending its migration to `executeTurn` (see `docs/TODO.md`).
- Untrusted input reaches the prompt builder unmodified — sanitisation lives inside the prompt module so it can't be skipped.
- Routers (`src/server/routers/`) sequence steps; UI never imports from here.
