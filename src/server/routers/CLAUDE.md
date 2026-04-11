# src/server/routers

Routers are thin orchestration. All logic lives in `src/lib/`.

- Every LLM-calling procedure follows: sanitise input → assemble prompt (`src/lib/prompts/`) → call LLM (`src/lib/llm/client.ts`) → parse response (`src/lib/llm/parsers.ts`)
- Validate all inputs with Zod in procedure definition
- No imports from `src/components/`. API layer is UI-independent.
- Split into sub-routers if a file exceeds 150 lines.
