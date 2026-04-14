# src/lib/course

Course lifecycle orchestrators. Thin functions that wire prompts (`src/lib/prompts/`) to the LLM (`src/lib/llm/`) and return validated payloads. No prompt text, no DB access, no scoring logic here.

- One file per turn/step in the new-course or session flow (`clarifyTopic.ts`, future `generateFramework.ts`, `generateBaseline.ts`, etc.).
- Each function: build messages → `generateStructured` (or `generateChat` + `extractTag`) → return `{ payload, usage }`. Propagate token usage; never drop it.
- All untrusted input must reach the prompt builder unmodified — sanitisation lives inside the prompt module so it can't be skipped.
- Routers (`src/server/routers/`) call into here; UI never imports from here directly.
