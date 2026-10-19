# src/server/routers

Thin interceptor between User and LLM. All logic lives in `src/lib/`.

- Every LLM-calling procedure: Zod-validate input → call the relevant function in `src/lib/course/` (which owns prompt assembly, LLM dispatch, Zod validation of the reply, and persistence) → return a typed payload.
- No imports from `src/components/`. API layer is UI-independent.
- Split by turn if a file exceeds 150 lines (e.g. `course/clarify.ts`, `course/framework.ts`, `course/submitBaseline.ts`).

Every procedure returns a typed, hand-shaped payload, never raw LLM text. No payload carries a plaintext answer key: `correct` → `correctEnc`, `freetextRubric` dropped. Wave payloads go through `redactWaveChatLog`. `course.clarify`, `course.generateBaseline`, and `course.getState` go through the same per-question `redactQuestion` (`src/lib/course/redactQuestionnaire.ts`). `course.submitBaseline` takes only the learner's picks and grades against the stored keys. The `nextStage` field tells the client which procedure to call next; the client maintains stage-state and dispatches accordingly.

Wave turns do not go through tRPC. tRPC serves Wave state (`wave.getState`). The client sends each turn to the streaming route `src/app/api/course/[courseId]/wave/[waveNumber]/turn/route.ts` (AI SDK UI message stream). The route validates with `submitTurnInputSchema` (`src/lib/types/waveTurnInput.ts`, which also infers `SubmitTurnPayload`). A body that is not a JSON object gets a fixed 400, because V8's JSON parse error quotes the body. The route resolves the user via `src/server/requestUser.ts` and calls `streamWaveTurn` in `src/lib/course/`.

Errors pass through the `errorFormatter` in `src/server/trpc.ts`. The client sees a message only when the server wrote it on purpose: a guard `TRPCError`'s own message, a `NotFoundError` (rewrapped as NOT_FOUND by `mapNotFound`), or tRPC's Zod input-validation message. Every other error gets fixed text, because tRPC would send its raw message and a failed DB write's message lists its params (issue #171). Guard messages reach the learner's toast, so they quote ids and statuses only. `data` is an allowlist (`code`, `httpStatus`, `path`), so `stack` never ships. The rule is `clientErrorText` in `src/lib/security/`, shared with the Wave-turn route. The fetch adapter's `onError` (`src/app/api/trpc/[trpc]/route.ts`) writes one `[trpc] procedure failed` line per INTERNAL_SERVER_ERROR: the path and safe codes from `errorLogLine`, never a message.
