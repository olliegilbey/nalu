# src/server/routers

Thin interceptor between User and LLM. All logic lives in `src/lib/`.

- Every LLM-calling procedure: Zod-validate input → call the relevant step in `src/lib/course/` (which owns prompt assembly + LLM dispatch + Zod validation of the reply) → persist via `src/db/queries/` → return a typed payload.
- No imports from `src/components/`. API layer is UI-independent.
- Split by turn if a file exceeds 150 lines (e.g. `course/clarify.ts`, `course/framework.ts`, `course/submitBaseline.ts`).
