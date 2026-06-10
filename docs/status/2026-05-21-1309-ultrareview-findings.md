# Ultrareview findings — PR #12 (`feat/teaching-loop`)

Full verbatim findings from `/ultrareview 12` (run 2026-05-21). 5 bugs, all `normal` severity, all triaged as **valid**. The actionable summary + fix plan lives in `2026-05-21-1309-teaching-loop-review-fixes.md`; this file preserves the complete reasoning and step-by-step proofs so nothing is lost on `/clear`.

---

## bug_001 — Non-idempotent pre-LLM chat_log append corrupts wave on retry after LLM failure

**Severity:** normal · **File:** `src/lib/course/submitWaveTurn.ts:137-164`

### PR comment

`submitWaveTurn` appends the learner's turn to `waves.chat_log` via `appendWaveChatLog` (a non-idempotent Postgres JSONB `||` concat) _before_ the fallible `executeWaveMid`/`executeWaveClose` dispatch — outside any transaction and with no dedup. If the LLM dispatch throws (exhausted retries, transport failure, or a post-LLM tx error), the learner entry is committed and orphaned, and any retry — the exact scenario this pre-LLM durability write exists to support — appends a _second_ copy. For a chat-text turn the orphan inflates `consumed` so `turnsRemaining` is one too low, silently shrinking the wave and able to close it a full turn early; for a questionnaire-answers turn the orphan `{role:user,kind:answers,questionnaireId}` entry makes `findOpenQuestionnaire` treat the questionnaire as answered, so the retry throws `PRECONDITION_FAILED "no open questionnaire"` and the learner can never resubmit it — its placeholder assessment rows stay ungraded and all its XP is lost. Fix: make the pre-LLM append resume-aware (no-op if the trailing `chat_log` entry already represents this submission) so retries are idempotent, the way scoping's overwrite-column pre-persist already is.

### Full reasoning

**What the bug is.** This PR introduces a two-store split for the wave teaching loop: `context_messages` is the LLM replay log, and the new `waves.chat_log` JSONB array is the UI's typed source of truth. `docs/ARCHITECTURE.md` states the pre-LLM durability invariant explicitly: _"write the typed payload to the typed-JSONB store before calling the LLM ... On retry, the responses survive; the LLM call re-renders the envelope from them."_ `submitWaveTurn` implements the wave half of this: at `submitWaveTurn.ts:164` it calls `appendWaveChatLog(db, ctx.wave.id, learnerEntry)` before dispatching `executeWaveClose`/`executeWaveMid` (lines 173-176).

The problem is an **idempotency asymmetry with scoping**. Scoping's pre-LLM persist writes to _overwrite_ columns (`courses.clarification` etc. via `updateCourseScopingState`), so re-running a scoping step is naturally idempotent. But `appendWaveChatLog` (`src/db/queries/waves.ts`) is a raw `UPDATE waves SET chat_log = chat_log || <payload>::jsonb` — an append-only concat. It runs on the `db` singleton with **no enclosing transaction** (confirmed by the comment at `submitWaveTurn.ts:149-150`), so it commits immediately. `submitWaveTurn` has no dedup, no resume path, and never inspects the trailing `chat_log` entry. Calling it twice appends two entries.

**The code path that triggers it.** When `executeWaveMid`/`executeWaveClose` throws — `executeTurn` exhausting `LLM.maxRetries` (raised to 6 in this PR), a transport failure, or a post-LLM transaction error — the learner's `chat_log` entry is already committed and orphaned (no paired assistant entry, since the assistant entry is written only inside `executeWaveMid`'s success transaction). The pre-LLM write exists _precisely_ so the learner can retry after such a failure. On retry, `submitWaveTurn` re-enters from the top and unconditionally appends a **second** copy of the learner entry at line 164.

**Why existing code doesn't prevent it.** The §7.4 mutual-exclusion guards (`submitWaveTurn.ts:92-128`) consume the result of `findOpenQuestionnaire` rather than detecting orphans — and the orphan actively _defeats_ `findOpenQuestionnaire`. There is no row lock, so a concurrent two-tab double-submit hits the same root cause. The PR's `submitWaveTurn` integration test only asserts the orphan survives **one** failed submit; the non-idempotency on a subsequent retry is untested.

**Impact.** (1) chat-text turn — wave shrinks, can close early. `consumed = chatLog.filter(e => e.role === "user").length` (line 137) counts the orphan, so `turnsRemaining = Math.max(0, WAVE.turnCount - (consumed + 1))` (line 138) is one too low. Every failed-then-retried turn permanently shrinks the wave by one. Late enough in the wave, the retry computes `turnsRemaining === 0` → `isCloseTurn` true → `executeWaveClose` runs instead of `executeWaveMid`, closing the wave a full teaching turn early. `deriveWaveTurns` also renders a duplicate user bubble. (2) questionnaire-answers turn — questionnaire permanently un-resubmittable, XP lost. The orphan `{role:"user",kind:"answers",questionnaireId:Q}` entry causes `findOpenQuestionnaire` (`findOpenQuestionnaire.ts:32-38`) to see a later `user.answers` matching `Q` and return `null`. On retry, the guard at `submitWaveTurn.ts:98-103` throws `PRECONDITION_FAILED "no open questionnaire"`. The learner can never resubmit questionnaire `Q`. Their only remaining path is chat-text, which runs with `hasOpenQuestionnaire = false` → `gradePriorAnswers` returns `[]` immediately (`executeWaveMid.grade.ts:51`) → `Q`'s placeholder assessment rows stay `isCorrect=false, qualityScore=0, xpAwarded=0` forever. All grading and XP for that questionnaire is irrecoverably lost. The reload path is just as broken: `getWaveState`/`useWaveState` derive the active questionnaire via the same answered-check, so the UI shows `Q` as answered and drops to chat-text mode.

**Step-by-step proof (questionnaire-answers case).**

1. Wave `chat_log` ends with `{role:"assistant",kind:"text_with_questionnaire",questionnaireId:"Q",questions:[...]}`. `findOpenQuestionnaire` returns `Q`.
2. Learner submits answers for `Q`. The §7.4 guards pass.
3. Line 164: `appendWaveChatLog(db, waveId, {role:"user",kind:"answers",questionnaireId:"Q",responses:[...]})` — committed immediately to `chat_log`.
4. Line 174/176: `executeWaveClose`/`executeWaveMid` is dispatched and throws (e.g. `executeTurn` exhausts its 6 retries on the retry-prone close schema). `submitWaveTurn` rejects; no assistant entry, no `context_messages` rows.
5. Learner retries (resubmits, or reloads then resubmits — the durability write's whole purpose).
6. `submitWaveTurn` re-enters. `findOpenQuestionnaire` now scans the log: it finds the `text_with_questionnaire` entry for `Q`, then `.slice(lastQIdx + 1).some(...)` finds the orphan `user.answers` entry referencing `Q` (`findOpenQuestionnaire.ts:32-38`) → `answered = true` → returns `null`.
7. Guard at `submitWaveTurn.ts:98-103`: `payload.kind === "questionnaire-answers" && openQuestionnaire === null` → throws `PRECONDITION_FAILED "no open questionnaire"`.
8. `Q` is now permanently unanswerable; its assessment rows stay ungraded, XP for `Q` is lost.

**How to fix.** Make the pre-LLM append idempotent. Before appending at line 164, check whether the trailing `chat_log` entry already represents this exact submission (same `kind`, same `questionnaireId`, same content/responses) and skip the append if so — restoring the resume-survives invariant that scoping gets for free from overwrite columns. Alternatively, wrap the learner append and the LLM dispatch so a failed dispatch removes (or marks) the orphan, or add a row lock plus a resume check to also close the concurrent double-submit hole. Either way the retry path must not produce a duplicate `chat_log` entry.

---

## bug_002 — Reloading a closed wave strands the learner with no move-on CTA and a silently-dead composer

**Severity:** normal · **File:** `src/components/chat/WaveSession.tsx:45-52`

### PR comment

Reloading or back-navigating to a closed wave strands the learner: the move-on CTA is derived only from useWaveState's component-local closeResult (WaveSession.tsx:47-52), which is set exclusively from the submitTurn close-turn onSuccess branch and is null on any fresh mount — getWaveState always returns closeResult: null. With no CTA and no open questionnaire, the Composer falls back to interactive chat-text mode, but every send throws PRECONDITION_FAILED (wave not open) and useWaveState registers no onError handler, so the failure is completely silent. Fix: expose WaveState.status (already on the wire) through useWaveState and render a move-on/return affordance whenever status === "closed", rather than relying only on the transient closeResult.

### Full reasoning

**What the bug is.** `WaveSession` shows the "advance to Wave N+1" affordance only when `closeResult` is truthy (`WaveSession.tsx:47-52`). `closeResult` comes from `useWaveState`, where it is plain component-local React state: `const [closeResult, setCloseResult] = useState<WaveCloseResult | null>(null)` (`useWaveState.ts:61`). It is assigned in exactly one place — the `submitTurn` mutation's `onSuccess` handler, in the `close-turn` branch (`useWaveState.ts:76-83`). The server query `getWaveState` _always_ returns `closeResult: null` (documented in the `WaveState` TSDoc and implemented that way in `getWaveState.ts`). So the move-on CTA is purely transient: it exists only in the browser tab that performed the closing turn, and only until that tab is reloaded or navigated away from.

**The code path that triggers it.** When a wave closes, the learner has a one-time window to click "move on". If they instead reload the Wave N page, hit browser-back to it from Wave N+1, or open a closed-wave URL directly, `useWaveState` mounts fresh: `closeResult` initializes to `null`, and `getWaveState` returns no close payload. `WaveSession` then computes `moveOn = undefined` and renders no advance button. The last questionnaire of a closed wave has already been answered, so `activeQuestionnaire` is also `null` — meaning the `Composer` renders in plain chat-text mode and is enabled (`disabled={isPending}`, which settles to `false` once the query loads).

**Why existing code doesn't prevent it.** The wire shape _does_ carry the information needed to detect this state: `getWaveState` returns `status: "active" | "closed"`, and `getWaveState`'s own design intent is that the UI gates on it. But `UseWaveStateResult` (`useWaveState.ts:26-34`) never exposes `status`, and `WaveSession` destructures only `turns`, `activeQuestionnaire`, `closeResult`, `isPending`, `submitChatText`, and `submitQuestionnaireAnswers`. `status` is fetched, validated, and then dropped — a closed wave is indistinguishable from an active one anywhere in the UI. `deriveWaveTurns` also deliberately does not emit a `move-on-cta` turn, and `renderTurn` returns `null` for that variant, so there is no scroll-based fallback affordance either.

**Impact.** The composer looks interactive but is a dead control. Typing and sending calls `submitChatText` → `submitTurn.mutate` → `submitWaveTurn`, which at `submitWaveTurn.ts:77-82` throws `TRPCError({ code: "PRECONDITION_FAILED" })` because `ctx.wave.status !== "open"`. The `submitTurn` `useMutation` (`useWaveState.ts:65-92`) registers **only** an `onSuccess` callback — there is no `onError` — so the rejected mutation produces no toast, no message, nothing. Worse, `WaveSession`'s `onSend` calls `setComposerValue("")` immediately after `submitChatText`, so the learner's typed text simply vanishes with zero feedback. The net result: a learner who revisits a finished wave has no in-app path forward to Wave N+1, and the one control that appears usable silently eats their input. The only escape is the `onNew` ("New") button, which routes to the home page — not to the next wave — or a manual URL edit. This breaks the core teaching-loop progression on a completely ordinary user action (page reload).

**How to fix.** Thread `status` through `useWaveState` (add it to `UseWaveStateResult`, pass `state.data.status`) and have `WaveSession` derive the move-on/return affordance from `status === "closed"` rather than only from the transient `closeResult`. On a reloaded closed wave there is no `nextWaveNumber` in `closeResult`, so the affordance should navigate by ordinal (e.g. `waveNumber + 1`) or surface a "return / continue" control. As defense-in-depth, also add an `onError` handler to the `submitTurn` mutation so any rejected turn shows a toast instead of failing silently, and consider disabling the Composer's chat-text mode when `status === "closed"`.

**Step-by-step proof.**

1. Learner finishes Wave 1. The final `submitWaveTurn` returns a `close-turn` result; `useWaveState`'s `onSuccess` runs `setCloseResult({...})` (`useWaveState.ts:78-83`). `WaveSession` now has `closeResult` truthy → `moveOn` is defined → the advance button renders.
2. Before clicking it, the learner reloads the page (accidental Cmd+R, tab restore, network hiccup) — or later browser-backs to `/course/{id}/wave/1`.
3. `useWaveState` mounts fresh: `useState<WaveCloseResult | null>(null)` → `closeResult === null`.
4. `wave.getState` resolves; `getWaveState` returns `{ status: "closed", chatLog: [...], closeResult: null, ... }`.
5. `WaveSession` computes `moveOn = closeResult ? {...} : undefined` → `undefined`. No advance button renders.
6. The wave's last questionnaire is already answered, so `activeQuestionnaire` is `null`. The `Composer` receives `questions={null}` and `moveOn={undefined}` → it renders the interactive chat-text input, `disabled={isPending}` → `false`.
7. The learner types "continue" and presses send. `onSend` calls `submitChatText("continue")` then `setComposerValue("")`.
8. `submitChatText` → `submitTurn.mutate({ payload: { kind: "chat-text", text: "continue" } })` → server `submitWaveTurn`.
9. `submitWaveTurn` loads the wave, hits `if (ctx.wave.status !== "open")` at line 77, and throws `PRECONDITION_FAILED`.
10. The mutation rejects. `useWaveState`'s `submitTurn` has no `onError` → nothing happens. The input is already cleared. The learner sees the wave do absolutely nothing, with no error, no toast, and no way to reach Wave 2 from this screen.

---

## bug_003 — Close turn cannot grade an MC question posed on the final mid-turn — wave can never close

**Severity:** normal · **File:** `src/lib/course/persistWaveClose.helpers.ts:52-61`

### PR comment

`applyCloseGradings` throws a plain `Error` on any `mc-index` close-grading (persistWaveClose.helpers.ts:54-60) on the assumption that MC is always graded mid-turn — but a questionnaire posed on the final mid-turn (turn 9) is answered by the learner on the close turn, so its MC question ids flow into `makeWaveCloseSchema`'s required-coverage `superRefine` and the model emits a schema-valid `{kind:"mc-index"}` grading for them. The throw fires inside `persistWaveClose`'s `db.transaction` (a post-parse runtime error, not a `ValidationGateFailure`), so `executeTurn`'s validate-and-retry cannot recover it — it aborts the transaction and propagates as a 500, meaning any wave whose final mid-turn poses an MC questionnaire can never close. Fix by grading close-turn MC mechanically (mirroring `executeWaveMid.grade.ts`) instead of throwing, or by barring questionnaires on the final mid-turn.

### Full reasoning

**What the bug is.** `applyCloseGradings` (`src/lib/course/persistWaveClose.helpers.ts:54-60`) hard-throws a plain `Error` whenever a close-turn grading has `kind === "mc-index"`. The comment justifies this with the premise _"MC questions are graded mid-turn... receiving an mc-index here means the LLM emitted a contract violation."_ That premise is false for one realistic case: a questionnaire posed on the **final mid-turn** has no subsequent mid-turn, so its MC questions are necessarily answered — and graded — at close.

**The code path that triggers it.** `waveMidTurnSchema.questionnaire` (`src/lib/prompts/waveTurn.ts:62-66`) is optional with **no constraint tied to `turnsRemaining`** — the model is structurally free to drop an MC-containing questionnaire on the 9th learner turn. The pedagogy prompt only _discourages_ ending on a quiz; nothing enforces it.

When that questionnaire is answered on the close turn, `submitWaveTurn` loads `ctx` via `loadWaveContext` (`submitWaveTurn.ts:68`) **before** appending the learner's close-turn answer to `chat_log` (`submitWaveTurn.ts:164`). So `ctx.wave.chatLog` is a stale snapshot in which the turn-9 questionnaire still has no later `user.answers` entry. `executeWaveClose` then calls `findOpenQuestionnaire(ctx.wave.chatLog)` (`executeWaveClose.ts:79`), which returns the turn-9 questionnaire as still-open, and feeds **all of its question ids — MC included** — into `makeWaveCloseSchema({ questionIds: ... })` (`executeWaveClose.ts:80-86`).

**Why existing code doesn't prevent it.** `makeCloseTurnBaseSchema`'s `superRefine` #3 ("Every question covered", `closeTurn.ts:153-161`) emits an issue for any `questionId` in `questionIds` not covered by a grading — so the model **must** emit a grading for the MC question id. `closeGradingItemSchema` (`closeTurn.ts:17-54`) is a discriminated union on **answer kind**, and `buildLearnerInput` renders an index-click as `<questionnaire_answer kind="mc-index" .../>`; the `mc-index` arm's own description says _"match the card the learner clicked."_ The model therefore emits a `{kind:"mc-index"}` grading that **parses cleanly through Zod** — no `ValidationGateFailure` is raised.

`executeTurn`'s retry loop (`executeTurn.ts:237-240`) only catches `ValidationGateFailure`; any other error is re-thrown. The `applyCloseGradings` throw happens inside `persistWaveClose`'s `db.transaction` (`persistWaveClose.ts:71-73`), which runs **after** `executeTurn` has already returned successfully (`executeWaveClose.ts:96-117`). There is no try/catch anywhere between `applyCloseGradings` and the tRPC boundary, so the error aborts the transaction and propagates `persistWaveClose` → `executeWaveClose` → `submitWaveTurn` → router as an unrecoverable 500.

**Impact.** There is **no valid grading path**: emitting `mc-index` throws; omitting the MC id fails `superRefine` #3 (ValidationGateFailure → retry → eventually exhausts, since no shape satisfies both the coverage refine and the non-throwing branch); emitting `free-text` for an index-click answer mislabels the answer kind against the schema's stated contract. Any wave whose final mid-turn poses an MC-containing questionnaire is permanently bricked — the wave can never close, blocking course progression. The model autonomously drops questionnaires roughly one turn in three and MC is a permitted type, so a meaningful fraction of waves will hit this; each is a hard, unrecoverable failure. This is entirely new code introduced by this PR (the wave-close path did not exist before).

**How to fix it.** Route close-turn `mc-index` gradings through the mechanical MC grading path instead of throwing — `executeWaveMid.grade.ts` already grades MC against the persisted correct index, and `applyAssessmentGrading` accepts an `{kind:"mc-index", correct}` signal, so `applyCloseGradings` can compute correctness server-side from the stored questionnaire and call it. Alternatively, prevent the trigger at the source by barring the model from posing a questionnaire on the final mid-turn (a `superRefine` on `waveMidTurnSchema` gated on `turnsRemaining`, which would surface as a recoverable `ValidationGateFailure`). The TODO.md item that proposes a `superRefine` to reject `mc-index` at close does **not** fix this — rejecting it at parse time still leaves no valid output the model can produce, so it converts a 500 into a retry-exhaustion failure rather than a working close.

**Step-by-step proof.**

1. `WAVE.turnCount = 10`. The model, on the assistant emission following the 9th learner submission (`turnsRemaining = 1`), drops a questionnaire containing an MC question `q-mc` — permitted: `waveMidTurnSchema.questionnaire` is optional and unconstrained by `turnsRemaining`.
2. The learner answers `q-mc` by clicking an option. This is their 10th submission. In `submitWaveTurn`, `consumed = 9`, `turnsRemaining = max(0, 10 - (9+1)) = 0` → `isCloseTurn = true`.
3. `loadWaveContext` (line 68) snapshots `ctx.wave.chatLog` — which does **not** yet contain the learner's close-turn `user.answers` entry (that is appended at line 164, after the snapshot).
4. `executeWaveClose` calls `findOpenQuestionnaire(ctx.wave.chatLog)` → the turn-9 questionnaire is still "open" (no later `user.answers`), so its question ids `["q-mc"]` go into `makeWaveCloseSchema({ questionIds: ["q-mc"] })`.
5. The LLM is dispatched. `superRefine` #3 forces a grading for `q-mc`. The learner's answer was rendered `kind="mc-index"`, so the model emits `gradings: [{ kind: "mc-index", questionId: "q-mc", rationale: "..." }]`.
6. This output parses cleanly — `closeGradingItemSchema` explicitly permits the `mc-index` arm. No `ValidationGateFailure`. `executeTurn` returns successfully.
7. `persistWaveClose` opens `db.transaction`; `applyCloseGradings` iterates `parsed.gradings`, hits `g.kind === "mc-index"`, and executes `throw new Error("[executeWaveClose] mc-index grading at close is a contract violation; questionId=q-mc")`.
8. The throw aborts the transaction and propagates uncaught through `executeWaveClose` and `submitWaveTurn` to the router → HTTP 500. `executeTurn`'s retry already returned at step 6, so nothing retries. The wave is permanently stuck on the close turn.

---

## bug_004 — Model-reused question ids collide with the assessments wave/question unique index, 500-ing the turn

**Severity:** normal · **File:** `src/lib/course/executeWaveMid.insert.ts:107-122`

### PR comment

`insertNewQuestionnaire` writes one assessment row per question with `questionId = q.id` (the model-generated id), but the new partial unique index `assessments_wave_question_unique` is keyed on `(wave_id, question_id)` only — requiring per-wave id uniqueness that nothing enforces. `waveMidTurnSchema`/`questionnaireSchema` have no id-uniqueness refine and the model is never told ids must be unique across a wave, so reusing short ids like `q1`/`q2` across questionnaires in one wave (or duplicating an id within a single questionnaire) raises an uncaught Postgres unique-constraint violation that aborts the `executeWaveMid` transaction as an unrecoverable 500. Fix by namespacing `question_id` per questionnaire (e.g. `${assistantMessageId}:${q.id}`), widening the index to include `turn_index`, or adding a uniqueness `superRefine` to `waveMidTurnSchema`.

### Full reasoning

**What the bug is.** Migration `0006_add-assessments-question-id.sql` and `src/db/schema/assessments.ts` add a **partial unique index** `assessments_wave_question_unique` on `(wave_id, question_id) WHERE question_id IS NOT NULL`. The index key is `(wave_id, question_id)` — it does **not** include `turn_index`. That means _any_ two assessment rows in the same wave that share a `question_id` collide, regardless of which turn produced them.

`question_id` is the model-generated `q.id` from a questionnaire. In `executeWaveMid.insert.ts:110-122`, `insertNewQuestionnaire` maps every question to an assessment row with `questionId: q.id` and batch-inserts them via `insertOpenAssessments`. That helper (`src/db/queries/assessments.ts`) does a plain `.insert(assessments).values([...]).returning()` with **no `onConflict` clause and no de-duplication** — a duplicate `(wave_id, question_id)` throws a Postgres 23505 unique-constraint violation.

**Why existing code doesn't prevent it.** Nothing enforces that the model's `q.id` values are unique per wave. `questionSchema.id` (`src/lib/prompts/questionnaire.ts:28-30`) is a plain `z.string()` described only as _"Stable identifier so responses can be matched back to questions"_ — a per-questionnaire response-matching concern, never stated as wave-globally unique. `questionnaireSchema` has a single `.refine` checking `questions.length >= 1`; `waveMidTurnSchema` (`src/lib/prompts/waveTurn.ts:49-67`) wraps `questionnaireSchema.optional()` and adds no `superRefine`. Neither the schema `.describe()` annotations nor `teaching.ts` ever tell the model its ids must be unique across the wave. LLMs naturally restart per-questionnaire numbering at `q1`/`q2`, so reuse across the multiple questionnaires a wave drops (~1 turn in 3 over a ~10-turn wave → 2-3 questionnaires) is near-inevitable.

Two concrete failure modes both produce the same uncaught error:

- **Intra-questionnaire:** the model emits two questions with the same `id` in one questionnaire → the single batch `INSERT` carries two rows with identical `(wave_id, question_id)`.
- **Cross-turn (the strong one):** the model poses a questionnaire on turn 3 using `q1`, then another on turn 6 also using `q1` → the turn-6 insert collides with the turn-3 row already in the table.

**Impact.** The batch `INSERT` runs inside `executeWaveMid`'s `db.transaction` (`executeWaveMid.ts:116`), which executes **after** `executeTurn` (lines 83-97) has already returned successfully. The unique-constraint violation is a post-parse runtime DB error — **not** a `ValidationGateFailure` — so `executeTurn`'s validate-and-retry loop (which already completed) cannot catch or recover it. The error rolls the transaction back and propagates `executeWaveMid` → `submitWaveTurn` → tRPC as a 500. The teaching turn hard-fails with no recovery path, on the core teaching loop, for ordinary model behaviour. The PR's own integration test corroborates the trap: `assessments.integration.test.ts` carries the comment _"the partial unique index `assessments_wave_question_unique` forbids dupes within a wave"_ and deliberately uses distinct ids to dodge it.

**How to fix.** Any of three approaches: (1) **Namespace `question_id` per questionnaire** at insert time — store `${assistantMessageId}:${q.id}` (or `${turnIndex}:${q.id}`) so collisions across questionnaires are impossible while the model keeps using simple ids. (2) **Widen the index** to `(wave_id, turn_index, question_id)` so distinct turns can reuse ids (does not fix the intra-questionnaire duplicate). (3) **Add a `superRefine` to `waveMidTurnSchema`** that rejects duplicate ids within `questionnaire.questions[]` — this surfaces as a `ValidationGateFailure` so `executeTurn` can retry, but a wave-global uniqueness refine is harder since the schema doesn't see prior turns' ids. Option (1) is the most robust: it eliminates both failure modes and requires no model-behaviour assumptions.

**Step-by-step proof (cross-turn reuse).**

1. Wave `W` is open. On turn 3 the model emits a `waveMidTurn` whose `questionnaire.questions` is `[{ id: "q1", type: "free_text", ... }, { id: "q2", ... }]`.
2. `executeTurn` parses it successfully (the ids are valid strings; no uniqueness check exists) and persists the `assistant_response` row.
3. `executeWaveMid` opens its transaction; `insertNewQuestionnaire` calls `insertOpenAssessments` which inserts assessment rows `(wave_id=W, question_id="q1")` and `(wave_id=W, question_id="q2")`. Transaction commits.
4. On turn 6 the model drops another questionnaire and — having no instruction otherwise — again numbers its questions `[{ id: "q1", ... }, { id: "q2", ... }]`.
5. `executeTurn` again parses successfully and persists the new `assistant_response`.
6. `executeWaveMid`'s transaction calls `insertOpenAssessments` with a row `(wave_id=W, question_id="q1")`. Postgres evaluates the partial unique index `assessments_wave_question_unique` on `(wave_id, question_id)`, finds the turn-3 row already present, and raises a 23505 unique-constraint violation.
7. The exception is uncaught, the `executeWaveMid` transaction rolls back, and the error propagates out as a tRPC 500. Because it is not a `ValidationGateFailure`, no retry path applies — the turn is permanently lost.

---

## bug_012 — Duplicate conceptUpdates entries double-advance a concept's SM-2 schedule at wave close

**Severity:** normal · **File:** `src/lib/course/persistWaveClose.ts:77-85`

### PR comment

`makeWaveCloseSchema`'s `superRefine` validates that each `conceptUpdates[]` name is an existing concept, but never checks for duplicate names — unlike the `gradings` and `plannedConcepts` dedupe refines already present in `closeTurn.ts`. If the close-turn model emits two entries for the same concept, `persistWaveClose` applies SM-2 twice in succession (each `applySm2Update` reads the prior iteration's write back through the same `tx`), silently double-advancing `repetitionCount`, `intervalDays`, `easinessFactor`, and `nextReviewAt` and corrupting the spaced-repetition schedule. Fix: add a duplicate-name `superRefine` to `conceptUpdates` mirroring the existing gradings/plannedConcepts dedupe checks.

### Full reasoning

**What the bug is.** `makeWaveCloseSchema` (`src/lib/prompts/waveClose.ts:42-52`) attaches a `superRefine` to the `conceptUpdates[]` array, but it only validates one thing per entry: `existing.has(u.name)` — i.e. that the concept name corresponds to a real concept on the course. It has **no duplicate-name check**. This is an inconsistency with the shared base schema: `makeCloseTurnBaseSchema` (`src/lib/prompts/closeTurn.ts`) explicitly dedupes the _other two_ LLM-emitted close arrays — `gradings` by `questionId` (rule 2, lines 144-152) and `nextUnitBlueprint.plannedConcepts` by `name` (rule 5, lines 173-181). `conceptUpdates` is the only LLM-emitted array in the close payload with zero duplicate protection. The author clearly treats duplicate emission as a real risk worth guarding against — `conceptUpdates` was simply missed.

**The code path that triggers it.** `persistWaveClose` (`src/lib/course/persistWaveClose.ts:77-85`) applies the SM-2 batch with a plain `for` loop, one `applySm2Update` call per entry, all sharing the same transaction handle `tx`. `applySm2Update` (`src/lib/course/applySm2Update.ts:32-64`) reads the concept's **current** SM-2 state via `getConceptByNameForCourse(courseId, name, params.tx)` — the caller's `tx` — runs the pure `calculateSM2`, then persists the next state via `updateConceptSm2(concept.id, ..., params.tx)`. Because the read is `tx`-scoped, a second `applySm2Update` call for the same concept name observes the write the first call made earlier in the same transaction. The `tx`-threading is intentional and correct (steps 3 and 5 of the close need to see the SM-2 writes) — but it is precisely what turns a benign duplicate into a _compounding_ corruption rather than an idempotent last-write-wins.

**Why existing code doesn't prevent it.** When the model emits two `conceptUpdates` entries with the same `name`, both pass the `existing.has(u.name)` check, so Zod parsing succeeds. Because the parse succeeds, `executeTurn` does **not** trigger a validation-gate retry — the payload is accepted as valid. `executeWaveClose` then calls `persistWaveClose`, which applies the double update with no error and no log. `calculateSM2` (`src/lib/spaced-repetition/sm2.ts:57-77`) has no same-day / already-reviewed guard — it purely advances from whatever current state it is handed, so two successive applications compound.

**Impact.** The spaced-repetition schedule is the product's core learning mechanism. A double-advance pushes `nextReviewAt` days further into the future than the learner's single demonstrated review warrants, inflates `repetitionCount` by 2 instead of 1, and double-adjusts `easinessFactor`. The concrete consequence: the learner is **not re-prompted** to review a concept they may not have actually mastered — silent data-integrity corruption, with no surfaced error. The trigger is realistic: the PR's own `docs/TODO.md` notes the close schema (`makeWaveCloseSchema`) is the most retry-prone, that `gpt-oss-120b` 'emits wrong field names/shapes', and that strict-mode constrained decoding is not actually enforced by Cerebras. The `.describe()` says 'one entry per concept' but nothing hard-enforces it — emitting one entry per _question_ when a concept is probed by multiple questions is a structurally-valid duplicate the current schema accepts. The base schema's dedup refines for `gradings`/`plannedConcepts` exist precisely because the model emits duplicate array entries.

**Step-by-step proof.** Take a fresh concept `ownership` at SM-2 defaults: `easinessFactor=2.5`, `intervalDays=0`, `repetitionCount=0`. The close-turn model emits `conceptUpdates: [{name:"ownership", qualityScore:5, reason:"…"}, {name:"ownership", qualityScore:5, reason:"…"}]`.

1. **Schema parse** — `makeWaveCloseSchema`'s `superRefine` iterates `conceptUpdates`: both entries are `name="ownership"`, both pass `existing.has("ownership")`. No issue is raised. Parse succeeds, so `executeTurn` does NOT retry.
2. **persistWaveClose loop, iteration 1** — `applySm2Update` reads `ownership` via `tx`: `rep=0, interval=0, EF=2.5`. `calculateSM2(quality=5)`: success, `repetitionCount=0` → `nextIntervalOnSuccess` returns `SM2.firstSuccessInterval` (≈1 day), `repetitionCount → 1`, EF adjusted upward. `updateConceptSm2` writes `rep=1, interval=1` via `tx`.
3. **persistWaveClose loop, iteration 2** — `applySm2Update` reads `ownership` via the **same** `tx` and now observes the iteration-1 write: `rep=1, interval=1`. `calculateSM2(quality=5)`: success, `repetitionCount=1` → `nextIntervalOnSuccess` returns `SM2.secondSuccessInterval` (≈6 days), `repetitionCount → 2`. `nextReviewAt = now + 6 days`.
4. **Final persisted state** — `repetitionCount=2, intervalDays=6, nextReviewAt ≈ now+6d`, EF double-adjusted. The correct single-review state was `repetitionCount=1, intervalDays=1, nextReviewAt ≈ now+1d`. The concept is now scheduled 6 days out instead of 1 — the learner skips a review they should have gotten.

**How to fix.** Add a duplicate-name `superRefine` to `conceptUpdates` in `makeWaveCloseSchema`, mirroring the existing dedupe pattern in `closeTurn.ts`:

```ts
const names = val.conceptUpdates.map((u) => u.name);
const dupes = names.filter((n, i) => names.indexOf(n) !== i);
if (dupes.length > 0) {
  ctx.addIssue({
    code: "custom",
    path: ["conceptUpdates"],
    message: `duplicate conceptUpdates names: ${[...new Set(dupes)].join(", ")}`,
  });
}
```

A rejected parse routes through `executeTurn`'s retry directive so the model re-emits a deduplicated batch — the same recovery path the gradings/plannedConcepts refines already rely on.

---

## Note on line numbers

Several reasoning blocks cite line numbers (e.g. `submitWaveTurn.ts:164`, `useWaveState.ts:61`) from the ultrareview's snapshot of the PR head. They are accurate as of commit `4b32871` but may drift as fixes land — treat them as starting points, not exact addresses.
