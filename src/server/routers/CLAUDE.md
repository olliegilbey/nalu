# src/server/routers

Thin interceptor between User and LLM. All logic lives in `src/lib/`.

- Every LLM-calling procedure: Zod-validate input → call the relevant function in `src/lib/course/` (which owns prompt assembly, LLM dispatch, Zod validation of the reply, and persistence) → return a typed payload.
- No imports from `src/components/`. API layer is UI-independent.
- Split by turn if a file exceeds 150 lines (e.g. `course/clarify.ts`, `course/framework.ts`, `course/submitBaseline.ts`).

Every procedure returns a typed, hand-shaped payload, never raw LLM text. No payload carries a plaintext answer key: `correct` → `correctEnc`, `freetextRubric` dropped. Every question goes through `redactQuestion` (`src/lib/course/redactQuestionnaire.ts`): `wave.getState` via `redactWaveChatLog`, and `course.clarify`, `course.generateBaseline` and `course.getState` directly. `course.submitBaseline` takes only the learner's picks and grades against the stored keys. The `nextStage` field tells the client which procedure to call next; the client maintains stage-state and dispatches accordingly.

`profile` serves the caller's own profile. `getCustomInstructions` is a query; `setCustomInstructions` is a mutation. Neither takes a user id: both act on `ctx.userId`. A caller with no session reads null and mints nothing; a save mints. Its input schema, `setCustomInstructionsInputSchema` (`src/lib/types/customInstructionsInput.ts`), owns trim, cap and clear. An over-cap save fails BAD_REQUEST and writes nothing. The router calls `src/lib/learner-profile/`. It adds no log line: the text is learner content.

Wave turns do not go through tRPC. tRPC serves Wave state (`wave.getState`). The client sends each turn to the streaming route `src/app/api/course/[courseId]/wave/[waveNumber]/turn/route.ts` (AI SDK UI message stream). The route validates with `submitTurnInputSchema` (`src/lib/types/waveTurnInput.ts`, which also infers `SubmitTurnPayload`). A body that is not a JSON object gets a fixed 400, because V8's JSON parse error quotes the body. The route resolves the user via `src/server/requestUser.ts` and calls `streamWaveTurn` in `src/lib/course/`.

Only a write that needs no existing course mints (#246). The tRPC context and the Wave-turn route read an existing session through `readRequestSession` (`src/server/requestUser.ts`) and never mint. Each procedure picks one of three types from `src/server/trpc.ts`, by what it answers a caller with no session:

- `learnerProcedure`: a learner's named resource, such as `course.getState`. It includes a write that needs an existing course, such as `submitBaseline`. No session answers NOT_FOUND, as for another learner's course.
- `optionalLearnerProcedure`: a read with a natural empty answer. `ctx.userId` stays optional, and the lib read answers the empty value: `profile.getCustomInstructions` answers null.
- `mintingProcedure`: a write that needs no existing course, such as `course.clarify`. No session mints an anonymous learner through `mintAnonymousLearner`, the one home of the mint (#232). Next merges its cookie into the response. The context memoises the mint (`mintUserId`), so a batch shares one.

Every type provisions the learner's `user_profiles` row and binds their id into ALS (`runAsLearner`). A new write that needs no existing course uses `mintingProcedure`; one that needs an existing course uses `learnerProcedure`. Tests call `appRouter.createCaller({ userId })`. Such a context has no `mintUserId`, so a minting call with no `userId` answers UNAUTHORIZED.

The Wave-turn route reads the session only after the body validates. No session answers 404; a turn needs an existing course. A session that fails to load is never minted over or treated as a stranger: it logs `[auth] session failed to load`, the tRPC context refuses the whole request as UNAUTHORIZED, and the route answers 401. A failed mint throws. Page loads never mint: `src/proxy.ts` only refreshes a session.

Errors pass through the `errorFormatter` in `src/server/trpc.ts`. The client sees a message only when the server wrote it on purpose: a guard `TRPCError`'s own message, a `NotFoundError` (rewrapped as NOT_FOUND by `mapNotFound`), or tRPC's Zod input-validation message. Every other error gets fixed text, because tRPC would send its raw message and a failed DB write's message lists its params (issue #171). Guard messages reach the learner's toast, so they quote ids and statuses only. `data` is an allowlist (`code`, `httpStatus`, `path`), so `stack` never ships. The rule is `clientErrorText` in `src/lib/security/`, shared with the Wave-turn route. The fetch adapter's `onError` (`src/app/api/trpc/[trpc]/route.ts`) writes one `[trpc] procedure failed` line per INTERNAL_SERVER_ERROR: the path and safe codes from `errorLogLine`, never a message.
