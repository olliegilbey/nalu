# TODO

Follow-up work surfaced during MVP development. Each entry names the file,
the concern, and the conditions under which it should be promoted to a PR.

- [ ] Narrow `makeWaveCloseSchema` to reject `mc-index` close-gradings — the close orchestrator can only grade free-text at close (MC graded mid-turn in `executeWaveMid.grade.ts`). Currently `applyCloseGradings` throws at runtime if the LLM emits an mc-index grading at close. Move the constraint into the Zod schema via a superRefine so the model's response is rejected at parse time and `executeTurn` can retry with a directive.

## Teaching-loop UI (Task 15 follow-ups)

### JSON-everywhere for wave `context_messages.content`

**Files:** `src/lib/turn/executeTurn.ts`, `src/lib/llm/renderContext.ts`,
`src/lib/course/getWaveState.ts`, `src/lib/course/deriveWaveTurns.ts`

`executeTurn` currently persists `user_message` rows with the full XML
envelope (`renderWaveTurnEnvelope` output: `<stage>…<learner_reply>…
</learner_reply><turns_remaining>…</turns_remaining><response_schema>…
</response_schema>`) and `assistant_response` rows with raw LLM JSON.
The UI reads `context_messages.content` straight into chat bubbles, so
both render the wire format verbatim (screenshots from 2026-05-19
session). Scoping doesn't have this problem — it stores typed JSONB
(`clarifications`, `baseline`, `framework`, `scopingResult` columns)
and `deriveTurns` reads structured fields.

**Fix:** mirror the JSON-everywhere principle that Task 7 applied to
prompts. Persist clean structured payloads in `context_messages.content`
— e.g. `{"text": "Great let's go"}` for chat-text, `{"answers": […]}`
for questionnaire submissions, `{userMessage, comprehensionSignals,
questionnaire}` for assistant turns. Build the XML envelope ONLY at
LLM-send time inside `renderContext` (or executeTurn's send step), never
persist it. `deriveWaveTurns` then reads structured fields, same as
`deriveTurns` reads typed JSONB columns.

**Touches:** `executeTurn` persistence, `renderContext` (LLM
context-replay must reconstruct the envelope on the fly), `getWaveState`
(`RenderedMessage.content` becomes structured), `deriveWaveTurns`,
plus integration tests that snapshot envelope content.

**Promote when:** backend Wave teaching loop is smoke-green and the
team is ready to land a coordinated migration of persisted shape.

## executeWaveMid (Task 11 follow-ups)

### Enforce `conceptName` on waveMidTurn questionnaire at the schema layer

**Files:** `src/lib/prompts/waveTurn.ts`

`waveMidTurnSchema` accepts questions without `conceptName` because the shared
`questionSchema` permits absence for clarify-style elicitation. Wave teaching
needs `conceptName` on every question (it drives the per-question concept
binding for assessment rows). `executeWaveMid.insert.ts` throws a clear
runtime error today; promote that to a `.superRefine` on
`waveMidTurnSchema.questionnaire.questions[]` so the harness retry directive
surfaces it to the model.

**Fix:** add a superRefine that walks `questionnaire.questions[]` and emits
an issue on any missing `conceptName` (and missing `correct` for MC). The
refine `.message` should be teacher-style so the retry attempt can recover.

**Promote when:** any other wave-teaching schema refines land (Task 12+) and
the refine surface starts paying for itself.

## Concurrency races (deferred — single-user serial MVP)

These are theoretical for the current flow: one learner, one wave, turns
submitted serially. CodeRabbit flagged them on PR #12; the fixes are
architectural and not worth landing until concurrent same-wave submissions
become possible.

### `executeWaveMid` selects the assistant row by `desc(turnIndex)` / `limit(1)`

**Files:** `src/lib/course/executeWaveMid.ts`

After `executeTurn` persists the `assistant_response`, `executeWaveMid`
re-finds that row with `orderBy(desc(turnIndex)).limit(1)`. Two concurrent
same-wave submissions could each pick up the _other's_ freshly-written row,
attaching grading + questionnaire state to the wrong turn.

**Fix:** thread the persisted assistant message id + turnIndex out of
`executeTurn` directly and select by that id, instead of the desc/limit
lookup.

**Promote when:** concurrent same-wave submission becomes reachable (e.g.
multi-device, or background retry that races a live submit).

### `submitWaveTurn` guard→append flow is non-atomic

**Files:** `src/lib/course/submitWaveTurn.ts`

The §7.4 precondition guards run as a load → check → append sequence with no
row lock. Two concurrent same-wave submissions can both pass the guards on
the same pre-state and both append, double-accepting a turn.

**Fix:** wrap load → guard → append in one transaction with
`SELECT ... FOR UPDATE` (or a compare-and-swap) on the wave row so the second
submission blocks until the first commits, then re-evaluates the guards.

**Promote when:** concurrent same-wave submission becomes reachable.
