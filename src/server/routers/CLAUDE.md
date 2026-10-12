# src/server/routers

Thin interceptor between User and LLM. All logic lives in `src/lib/`.

- Every LLM-calling procedure: Zod-validate input → call the relevant function in `src/lib/course/` (which owns prompt assembly, LLM dispatch, Zod validation of the reply, and persistence) → return a typed payload.
- No imports from `src/components/`. API layer is UI-independent.
- Split by turn if a file exceeds 150 lines (e.g. `course/clarify.ts`, `course/framework.ts`, `course/submitBaseline.ts`).

Every procedure returns a typed, hand-shaped payload, never raw LLM text. Wave payloads carry no plaintext answer keys (`correct` → `correctEnc`, `freetextRubric` dropped). Scoping payloads still ship them: `course.clarify`, `course.generateBaseline`, and `course.getState` return plaintext `freetextRubric`, and baseline MC carries plaintext `correct` (issue #58). The `nextStage` field tells the client which procedure to call next; the client maintains stage-state and dispatches accordingly.

Wave turns are dual-transport: tRPC owns state/queries (`wave.getState`) plus the blocking `wave.submitTurn` (rollback path, one release); the client's live turn dispatch is the streaming route `src/app/api/course/[courseId]/wave/[waveNumber]/turn/route.ts` (AI SDK UI message stream). Both validate with `waveTurnInput.ts` and resolve the user via `src/server/requestUser.ts`; both ride the shared `prepareWaveTurn`/`persistWaveMidTurn` spine in `src/lib/course/`.
