# src/server/routers

Thin interceptor between User and LLM. All logic lives in `src/lib/`.

- Every LLM-calling procedure: Zod-validate input → call the relevant step in `src/lib/course/` (which owns prompt assembly + LLM dispatch + Zod validation of the reply) → persist via `src/db/queries/` → return a typed payload.
- No imports from `src/components/`. API layer is UI-independent.
- Split by turn if a file exceeds 150 lines (e.g. `course/clarify.ts`, `course/framework.ts`, `course/submitBaseline.ts`).

Every procedure returns a typed, hand-shaped payload — the server never forwards raw LLM output to the client (XML tags, embedded JSON, and answer keys are stripped server-side). The `nextStage` field tells the client which procedure to call next; the client maintains stage-state and dispatches accordingly.

Wave turns are dual-transport: tRPC owns state/queries (`wave.getState`) plus the blocking `wave.submitTurn` (rollback path, one release); the client's live turn dispatch is the streaming route `src/app/api/course/[courseId]/wave/[waveNumber]/turn/route.ts` (AI SDK UI message stream). Both validate with `waveTurnInput.ts` and resolve the user via `src/server/requestUser.ts`; both ride the shared `prepareWaveTurn`/`persistWaveMidTurn` spine in `src/lib/course/`.
