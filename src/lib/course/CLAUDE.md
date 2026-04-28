# src/lib/course

Scoping steps. One file = one LLM call wrapped up. Wire prompts (`src/lib/prompts/`) to the LLM (`src/lib/llm/`) and return validated payloads. No prompt text, no DB access, no scoring logic.

- Each step: build messages → `generateStructured` (or `generateChat` + `extractTag`) → return domain-shaped payload + `usage`. Always propagate `usage`.
- Untrusted input reaches the prompt builder unmodified — sanitisation lives inside the prompt module so it can't be skipped.
- Routers (`src/server/routers/`) sequence steps; UI never imports from here.
