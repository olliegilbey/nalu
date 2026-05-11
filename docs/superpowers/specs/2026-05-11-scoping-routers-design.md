# Scoping Routers — Design

**Date:** 2026-05-11
**Status:** Approved (pending user review of written spec)
**Scope:** First three tRPC procedures of the scoping flow (`clarify`, `generateFramework`, `generateBaseline`), plus the shared turn-lifecycle refactor that aligns scoping with the future teaching pattern.

---

## 1. Goal

Wire the scoping phase end-to-end through tRPC, refactoring the existing lib steps so the scoping conversation is persisted in `context_messages` the same way teaching will be. The refactor introduces a shared `executeTurn` primitive that both scoping (this spec) and teaching (future spec) will use, replacing the current "rebuild prompt from typed inputs each call" pattern with "load conversation from DB → render → call LLM → persist raw response."

This is **not** a green-field design. The schema, prompts, LLM wrapper, and three existing lib steps all already exist. This spec defines what changes, what stays, and how the new pieces fit together.

## 2. Non-goals (out of scope, explicitly)

- `submitBaseline` procedure and the `initialSummary` gap on `baselineEvaluationSchema`.
- Real Supabase Auth + RLS. Dev-stub seam only.
- Framework editing / `<curriculum_note>` flow.
- Teaching-phase routers, Wave loop, SM-2 due-concept injection.
- Streaming responses. All turns are request-response.
- Multi-device / parallel-writer concurrency on `getNextTurnIndex`.
- The "turn" → "exchange" vocabulary rename (logged in `docs/TODO.md`).

## 3. Architecture

### 3.1 The two data stores

**`context_messages`** — the literal conversation transcript. One row per message. Ordered by `(turn_index ASC, seq ASC)`. Stores raw text exactly as the LLM emitted it (XML tags, embedded JSON, the lot). This is the LLM's conversational memory — every future turn reads it back and feeds it to the model.

**`courses.{clarification, framework, baseline}` JSONB columns** — structured projections of the parsed payloads. Populated when a turn closes successfully. These exist because the deterministic harness (and future SM-2 logic, tier progression, etc.) needs to query structured data via SQL, not re-parse XML on every read.

The invariant: **rows are source of truth; JSONB projections are derived caches.** Any read that needs the canonical conversation goes through rows. Any read that needs typed data for SQL operations goes through JSONB.

#### 3.1.1 Concrete data walkthrough

A scoping session for a learner who wants to learn Rust. After `clarify` completes:

`context_messages` rows (for this `scoping_pass_id`):

| turn_index | seq | kind               | role      | content (abridged)                                                                                          |
| ---------- | --- | ------------------ | --------- | ----------------------------------------------------------------------------------------------------------- |
| 0          | 0   | user_message       | user      | `"Rust"`                                                                                                    |
| 0          | 1   | assistant_response | assistant | `"<response>Let me ask a few quick questions.</response><questions>[\"Beginner?\", \"Goal?\"]</questions>"` |

`courses` row (relevant columns):

```
id:            "abc-123"
topic:         "Rust"
status:        "scoping"
clarification: { questions: ["Beginner?", "Goal?"] }   ← parsed from assistant_response above
framework:     null
baseline:      null
```

After `generateFramework` completes (user supplied answers `["yes", "web servers"]`):

| turn_index | seq | kind               | role      | content                                                                             |
| ---------- | --- | ------------------ | --------- | ----------------------------------------------------------------------------------- |
| 0          | 0   | user_message       | user      | `"Rust"`                                                                            |
| 0          | 1   | assistant_response | assistant | `<response>...</response><questions>[...]</questions>`                              |
| 1          | 0   | user_message       | user      | `"<answers>[\"yes\", \"web servers\"]</answers>"`                                   |
| 1          | 1   | assistant_response | assistant | `"<response>Here's the framework.</response><framework>{tiers: [...]}</framework>"` |

`courses` row updates: `framework` JSONB column now populated with the parsed tiers.

A turn that hit a retry-then-success looks like this (turn 2 hypothetically):

| turn_index | seq | kind                      | role      | content                                                                                                                      |
| ---------- | --- | ------------------------- | --------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 2          | 0   | user_message              | user      | `"<request>generate baseline</request>"`                                                                                     |
| 2          | 1   | failed_assistant_response | assistant | `"<response>here are some questions</response>"` (no `<baseline>` tag)                                                       |
| 2          | 2   | harness_retry_directive   | user      | `"Your response was missing the required <baseline>{...}</baseline> tag. Reply with the full baseline payload in that tag."` |
| 2          | 3   | assistant_response        | assistant | `"<response>...</response><baseline>{...}</baseline>"`                                                                       |

All four rows persist in the DB. On _future_ turns, `renderContext` filters out rows at `seq=1` and `seq=2` (since the turn ended in `assistant_response`), so the LLM only sees the clean `[user_message → assistant_response]` pair for turn 2. Cache prefix stays byte-stable.

### 3.2 The three router procedures

All under a new `course` router at `src/server/routers/course.ts`. Concrete Zod shapes:

```ts
// course.clarify
input: z.object({ topic: z.string().min(1).max(MAX_TOPIC_LENGTH) });
output: z.object({
  courseId: z.string().uuid(),
  questions: z.array(z.string().min(1)),
  nextStage: z.literal("framework"),
});

// course.generateFramework
input: z.object({
  courseId: z.string().uuid(),
  answers: z.array(z.string().min(1)).max(MAX_CLARIFY_ANSWERS),
});
output: z.object({
  framework: frameworkSchema, // existing schema in src/lib/prompts/framework.ts
  nextStage: z.literal("baseline"),
});

// course.generateBaseline
input: z.object({ courseId: z.string().uuid() });
output: z.object({
  baseline: baselineSchema, // existing schema in src/lib/prompts/baseline.ts
  nextStage: z.literal("answering"),
});
```

Each procedure is a one-line router calling its corresponding lib step. All logic lives in `src/lib/course/{clarify,generateFramework,generateBaseline}.ts`. Routers contain zero business logic per `src/server/routers/CLAUDE.md`.

**Why three procedures, not one:** scoping is a fixed-recipe state machine where each stage has distinct semantics that survive collapsing:

| Stage     | Input schema              | LLM expected output tag        | Validation gate                                          | JSONB projection        |
| --------- | ------------------------- | ------------------------------ | -------------------------------------------------------- | ----------------------- |
| clarify   | `{ topic }`               | `<questions>[...]</questions>` | questions array non-empty, each is a string              | `courses.clarification` |
| framework | `{ courseId, answers[] }` | `<framework>{...}</framework>` | tiers ordered, ≥ min count, ≤ max count, IDs unique      | `courses.framework`     |
| baseline  | `{ courseId }`            | `<baseline>{...}</baseline>`   | tier IDs match framework, no duplicates, no out-of-scope | `courses.baseline`      |

Each gate's failure produces a _different_ harness retry directive — "your questions array was empty" vs "tier IDs don't match framework." Bundling these into one procedure would mean a runtime switch on stage to pick the right parser + directive builder; three procedures keep type-safety at the boundary and make each lib step a self-contained unit. The client UI is still a single chat input — the response payload's `nextStage` field tells the client which procedure to call next.

**Why this differs from teaching:** teaching will likely be one router procedure (`sendWaveMessage`) handling every Wave turn, because Wave turns share a parser and the per-turn variation (turn-counter directives, final-turn tag requirements) is internal to the lib step. Scoping's stages have hard transitions; Wave turns flow continuously inside a fixed-length window. Different shapes, different boundaries.

### 3.3 The shared turn lifecycle (`executeTurn`)

New primitive at `src/lib/turn/executeTurn.ts`. Stage-agnostic, called by every lib step (scoping today, teaching later).

```ts
executeTurn<T>({
  parent: ContextParent,           // wave or scoping pass
  seed: SeedInputs,                // for renderContext
  userMessageContent: string,      // the literal text of this turn's user message
  parser: (raw: string) => T,      // throws ValidationGateFailure on parse fail
  retryDirective: (err, attempt: number) => string,
}): Promise<{ parsed: T; usage: TokenUsage }>
```

Internal flow:

1. `turnIndex = getNextTurnIndex(parent)`.
2. Load all prior messages for this parent (`getMessagesForWave` / `getMessagesForScopingPass`).
3. Build an in-memory batch starting with `{ kind: user_message, seq: 0 }`.
4. Loop up to `MAX_PARSE_RETRIES + 1` attempts:
   - Render the LLM input via `renderContext(seed, [priorMessages, ...inMemoryBatchSoFar])`.
   - Call `generateChat(rendered)`.
   - Try the parser.
   - If success: append `{ kind: assistant_response, seq: ... }` to the batch, `appendMessages(batch)`, return `{ parsed, usage }`.
   - If `ValidationGateFailure`: append `{ kind: failed_assistant_response, content: raw }` then `{ kind: harness_retry_directive, content: retryDirective(err, attempt) }` to the batch, loop.
5. If loop exhausts: `appendMessages(batch)` (persist the failure trail), throw `ValidationGateFailure` with code `exhausted_retries`.

Transport errors (network, rate limit) propagate untouched — nothing is persisted, the user retry creates a fresh `turn_index`.

### 3.4 Per-procedure design

Each lib step follows the same shape:

```ts
export async function <procedure>(ctx, input) {
  const course = await getCourseById(input.courseId, ctx.userId);  // 404/403
  if (course.status !== 'scoping') throw new TRPCError('PRECONDITION_FAILED');

  // Idempotency: if JSONB column already populated, return cached.
  if (course.<column> !== null) return projection(course.<column>);

  const pass = await ensureOpenScopingPass(course.id);

  const { parsed } = await executeTurn({
    parent: { kind: 'scoping', id: pass.id },
    seed: buildSeed(course),
    userMessageContent: buildUserMessage(input),
    parser: <stage>Parser,
    retryDirective: <stage>RetryDirective,
  });

  await updateCourseScopingState({ courseId: course.id, <column>: parsed });

  return { ...projection(parsed), nextStage: <next> };
}
```

Stage-specific fields:

| Stage             | `column`        | `seed`                                | `userMessageContent`                                    | `nextStage`   |
| ----------------- | --------------- | ------------------------------------- | ------------------------------------------------------- | ------------- |
| clarify           | `clarification` | `{ topic }`                           | sanitised topic                                         | `"framework"` |
| generateFramework | `framework`     | `{ topic, clarification }`            | `<answers>...</answers>`                                | `"baseline"`  |
| generateBaseline  | `baseline`      | `{ topic, clarification, framework }` | literal string `"<request>generate baseline</request>"` | `"answering"` |

`clarify` is the only procedure that creates the course; the others assume the `courseId` arrives in input and the prior stages have populated their JSONB columns.

### 3.5 Authentication

Dev-stub seam: `protectedProcedure` reads `x-dev-user-id` header → `ctx.userId`. Throws `UNAUTHORIZED` if missing. Real Supabase Auth is a separate spec per `docs/TODO.md`.

### 3.6 Client UX contract

The server design depends on specific client behaviours. These are not the server's responsibility to enforce, but the server's correctness assumes them:

- **Single chat input.** The user only ever sees a chat textbox and a send button. There are no "generate framework" / "generate baseline" buttons. Stage transitions happen invisibly via the `nextStage` envelope.
- **Send disabled while pending.** The send button is disabled from the moment a request is in flight until the response renders. This is what makes server-side concurrent-write protection a backstop rather than a primary mechanism.
- **In-flight input persistence.** When a request fails (transport error, terminal exhaust), the textbox retains the user's typed input. The user should not have to retype. React state minimum; localStorage if survive-refresh is desired.
- **Stage dispatch.** The client maintains a `currentStage` state, initialised to `"clarify"`. Each response payload's `nextStage` updates it. The client picks the matching mutation (`course.clarify`, `course.generateFramework`, or `course.generateBaseline`) for the next send.
- **Card rendering (forward-looking, not in scope this spec).** When a teaching turn returns a card (multiple-choice), the client renders it from server-provided structured data only. The client never parses LLM XML/JSON. Server strips correct-answer keys before sending.

### 3.7 Key invariants (load-bearing rules)

Consolidated here so the implementer doesn't lose any:

1. **Rows are source of truth; JSONB projections are derived caches.** Reads that need conversation history go through rows; reads that need typed data for SQL go through JSONB. They can diverge in theory (separate UPDATE); rows always win.
2. **Strict role alternation per turn.** Within each turn, the rendered LLM messages must alternate `user → assistant` strictly. `renderContext`'s same-role coalescing assumes role transitions are stable across appends. Breaking alternation breaks the cache prefix.
3. **Atomic batch insert per turn.** Either every row of a turn lands, or none do. `appendMessages` is a single INSERT statement — atomic by default; no explicit transaction needed.
4. **The error message IS the retry directive.** `ValidationGateFailure` messages must be authored as model-readable text — the harness pipes them directly to the LLM as the recovery instruction. Quality of these messages determines retry success rate.
5. **`failed_assistant_response` rows are filtered from render when their turn has a success companion.** Always filter together with the paired `harness_retry_directive` row. Never filter rows from a turn that ended in terminal exhaust.
6. **Idempotency = "is the JSONB column populated?"** Cheap, deterministic, defense-in-depth against client misbehaviour.
7. **Server never sends raw LLM output to the client.** Every procedure returns a typed, hand-shaped payload. The client never sees XML tags, JSON embedded in tags, or answer keys.

## 4. Persistence

### 4.1 Atomicity per turn

`appendMessages` (new plural query in `src/db/queries/contextMessages.ts`) executes one `INSERT INTO context_messages VALUES (...), (...), ...` — atomic by default. No transaction wrapper needed. Either the entire turn's row batch lands or nothing does.

The JSONB projection write (`updateCourseScopingState`) is a separate non-transactional UPDATE. If row insert succeeds and projection update fails, the rows remain — projection can be recomputed from the latest `assistant_response` row. Rows are source of truth.

### 4.2 New `kind` values

Migration `NNNN_add_retry_kinds.sql` extends the `context_messages.kind` CHECK constraint to allow:

- `failed_assistant_response` — a model response that failed parser validation. `content` holds the raw text. `role = 'assistant'`.
- `harness_retry_directive` — the error-directive text the harness injected after a failed response. `content` holds the directive. `role = 'user'` (presented to the model as if from the user/system).

Both kinds persist in the DB indefinitely for prompt-tuning analytics.

### 4.3 The render filter

`renderContext` adds a per-turn bucketing pre-pass before its existing same-role coalescing reduce:

- Group rows by `turn_index`.
- For each turn group: if any row has `kind = assistant_response`, **drop** all `failed_assistant_response` + `harness_retry_directive` rows in that group.
- If no `assistant_response` in the group (terminal-exhaust turn): keep all rows.

Flatten the filtered groups back into row order and feed into the existing coalescing logic.

**Why this filter:** once the model recovers from a parse failure, future turns don't need to see the failed attempts — the model only cares that the conversation proceeded correctly. Filtering keeps the cache prefix byte-stable across successful turns. Terminal-exhaust turns can't be filtered (there's no success to swap them out), so they remain visible, signalling to the LLM that the previous turn never recovered.

**Cache implication:** every successful turn produces a clean prefix → cache hit on subsequent renders. Only terminal-exhaust turns permanently bloat the prefix from that point forward — acceptable, since the model needs the failure history to recover on the user's re-submit.

### 4.4 Idempotency

Each procedure's idempotency check is "is the relevant JSONB column populated?" If yes, return the cached projection without an LLM call. This protects against:

- Double-click submit
- React Strict Mode double-effect
- Client-side network retry

Concurrent-write races on `getNextTurnIndex` are prevented by client UX contract (send button disables until response arrives). Server-side idempotency is defense-in-depth only.

## 5. Error handling

### 5.1 LLM parse failure

Caught by `executeTurn`'s retry loop. Self-correction up to `MAX_PARSE_RETRIES + 1` attempts (default 3 total). Each failed attempt persists as `failed_assistant_response` paired with a `harness_retry_directive` row that contains the error message.

**The error message IS the retry directive.** Authors of parsers must write `ValidationGateFailure` messages as if the LLM will read them — because it will. Quality of these messages directly determines retry success rate. Aim for "Rust compiler explicit" — say exactly what was wrong and what the fix is.

Example. Suppose the framework parser fails because the LLM emitted `<framework>` but the JSON has duplicate tier IDs. The `ValidationGateFailure` thrown should read like this — and this is the _exact text_ the harness will paste back to the LLM as the retry user message:

```
Your previous response failed validation: duplicate tier IDs in <framework>.
Found "rust-basics" appearing twice. Each tier id must be unique.
Reply with a corrected <framework>{...}</framework> payload where every tier.id is distinct.
The rest of your response (<response>...</response>) is fine; just regenerate the <framework> tag.
```

Each parser author is responsible for writing similarly precise error messages for every failure mode their parser can produce. This is a load-bearing piece of the design — terse or vague error messages will cause cascading retry failures.

Terminal exhaust path: after the last failed attempt, persist the failure trail, throw `ValidationGateFailure` with code `exhausted_retries`. tRPC translates to a `500` with code `LLM_PARSE_EXHAUSTED`. Client shows generic "try again" UI; user re-submit creates a new `turn_index` with a fresh retry budget. Failed rows from the prior turn remain visible in render (terminal-exhaust case), so the LLM sees the recovery context on re-attempt.

### 5.2 LLM transport failure

Bounded by `LLM.maxRetries` inside the AI SDK. Anything that escapes propagates up; `executeTurn` lets it through untouched. Nothing is persisted (the batch never commits). Returns `503` with code `LLM_UNAVAILABLE`.

**Client requirement:** the user's typed input must persist in client-side state (React state minimum; localStorage if survive-refresh is wanted) until the server ACKs success. On transport failure, the input box retains text and shows "send failed, try again." Server is not involved in this; pure client UX.

### 5.3 Precondition failures

- `NOT_FOUND` — course missing or wrong owner.
- `FORBIDDEN` — dev-stub auth header absent.
- `PRECONDITION_FAILED` — `status !== 'scoping'`, or required prior stage's JSONB column is null.

These should not occur in normal client usage (the chat flow drives stages forward deterministically). When they do occur, surface a recoverable error and let the user restart.

### 5.4 Concurrent submit

Cannot happen by client contract (send disabled while pending). Idempotency check remains as backstop only.

## 6. Testing strategy

Co-located `*.test.ts` per project convention. The implementer should write **more tests than feels necessary**, especially around the retry/filter logic — bugs here silently degrade the LLM context across every future turn.

### 6.1 Unit tests

- `src/lib/llm/renderContext.test.ts` — existing cases stay. Add:
  - Failed-row filter: turn with `[user, failed, directive, success]` renders only `[user, success]`.
  - Terminal-exhaust: turn with `[user, failed, directive]` renders all three.
  - Cache-prefix stability under retry: rendering up to a turn-1 boundary is byte-identical whether turn 0 had retries or not.
- `src/lib/llm/parseAssistantResponse.test.ts` — extend with cases for new scoping parsers if they reuse this shape; otherwise create per-stage parser test files.
- `src/lib/turn/executeTurn.test.ts` (new) — mock LLM and DB queries. Cases: happy path, success-on-attempt-2, terminal-exhaust, transport-error mid-loop. Verify the retry directive content is built from the parser's error message.
- `src/lib/course/{clarify,generateFramework,generateBaseline}.test.ts` — mock `executeTurn`. Verify correct seed, user-message content, parser/directive passed. Verify JSONB projection write happens after success. Verify idempotency returns cached when populated.

### 6.2 Integration tests (testcontainers Postgres + mocked LLM)

- `src/server/routers/course.integration.test.ts` (new) — per procedure: happy path, retry-then-success, terminal exhaust, idempotency. Verify rows persisted, JSONB populated, response shape correct.
- `src/db/queries/contextMessages.integration.test.ts` — extend for `appendMessages` plural and new `kind` values.

### 6.3 Migration tests

- `src/db/migrations/schema.integration.test.ts` — extend: new CHECK constraint accepts new kinds, existing rows survive, old kinds still insert.

### 6.4 Out of test scope

- E2E against real LLM (manual smoke test only, cost-prohibitive on CI).
- Client UI (separate Playwright work).
- Auth (dev-stub seam).
- `getNextTurnIndex` race (single-writer-per-Wave invariant; documented in TODO).

## 7. Cleanup & documentation

### 7.1 Delete

- `src/lib/prompts/clarification.ts` → remove `buildClarificationPrompt`; keep prompt text constants.
- `src/lib/prompts/framework.ts` → remove `buildFrameworkPrompt`; keep text.
- `src/lib/prompts/baseline.ts` → remove `buildBaselinePrompt`; keep text.
- `src/lib/prompts/index.ts` → prune removed exports from the barrel.
- Existing tests `src/lib/course/{clarifyTopic,generateFramework,generateBaseline}.test.ts` → rewrite (the new test shape mocks `executeTurn`, not `generateStructured`).

**Do not touch:** `baselineEvaluation.ts`, `gradeBaseline.ts`, `gradeBaseline.internal.ts`, `determineStartingTier.ts`.

### 7.2 Create

- `src/lib/turn/executeTurn.ts` + `.test.ts`.
- `src/lib/turn/retryDirective.ts` — pure `(error, attempt) => string` helper.
- `src/lib/turn/CLAUDE.md` — describes stage-agnostic primitive contract.
- `src/server/routers/course.ts` — three procedures, each one-liner.
- `src/server/routers/course.integration.test.ts`.
- `src/db/migrations/NNNN_add_retry_kinds.sql`.

### 7.3 Modify

- `src/lib/course/clarifyTopic.ts` → rewrite, rename to `clarify.ts` for consistency.
- `src/lib/course/generateFramework.ts` → rewrite.
- `src/lib/course/generateBaseline.ts` → rewrite. Move existing invariant checks (out-of-scope tiers, duplicate IDs) into the new parser; they throw `ValidationGateFailure` so the retry loop catches them.
- `src/lib/llm/renderContext.ts` → add per-turn bucketing filter pre-pass.
- `src/db/queries/contextMessages.ts` → add `appendMessages` (plural). Extend `AppendMessageParams.kind` union.
- `src/server/routers/index.ts` → register `course` router.
- `src/server/trpc.ts` → add `protectedProcedure` with dev-stub auth.
- `src/lib/config/tuning.ts` → add `MAX_PARSE_RETRIES` (default 2).
- `src/lib/types/context.ts` → extend `SeedInputs` for scoping stages; verify alignment with `renderScopingSystem`.

### 7.4 CLAUDE.md files to update

Every CLAUDE.md whose claims about the code become false. Patches, not rewrites, unless the file becomes incoherent.

- `src/lib/course/CLAUDE.md` — currently describes per-step prompt builders + `generateStructured`. Rewrite to: lib steps build seed + user-message content, delegate to `lib/turn/executeTurn`, write JSONB projection on success.
- `src/lib/prompts/CLAUDE.md` — clarify: scoping prompts now own system text only (via `renderScopingSystem`); user-message construction lives in lib steps; teaching prompts unchanged.
- `src/lib/llm/CLAUDE.md` — extend §"Render & parse contract" with the filter rule explicitly: rendered turns that contain `assistant_response` drop their `failed_assistant_response` + `harness_retry_directive` siblings; terminal-exhaust turns render them through.
- `src/server/routers/CLAUDE.md` — add the wire-shape principle: typed payloads only, never raw LLM output, answer keys stripped from teaching-card responses (forward-looking).
- `src/lib/turn/CLAUDE.md` — new, from scratch.

### 7.5 TSDoc to rewrite

- Top-of-file TSDoc in each rewritten `course/*.ts` — the old text references `generateStructured` and prompt builders; must reflect the new pattern.
- `renderContext.ts` top-of-file TSDoc — extend with the filter rule and how it interacts with cache-prefix stability.
- `parseAssistantResponse.ts` TSDoc — currently teaching-specific. Either generalise (preferred) or split into per-phase parsers. Decide at implementation time.

### 7.6 TODO.md entries to add

- `harness_retry_directive` kind — review naming after production-log experience.
- `submitBaseline` `initialSummary` gap — `setCourseStartingState` requires it, but `baselineEvaluationSchema` has no summary field. Fix in the submitBaseline spec.

### 7.7 Discipline points for implementation agents

1. **Treat this spec as direction, not contract.** Active simplification welcome. If you spot two parallel helpers that should be one, an abstraction that doesn't earn its weight, or a planned indirection that can be inlined, raise it before writing the code. MVP wants smallest working version, not most thoroughly architected. (Captured in user memory.)
2. **Test more than feels necessary.** The render filter and retry loop are the highest-stakes pieces. The integration suite should include adversarial cases: turns with multiple failed attempts, turns where the only response is a failure, cache-prefix stability across rendered-then-rerendered scenarios.

## 8. Acceptance criteria

- All three router procedures pass integration tests against testcontainers Postgres with a mocked LLM.
- `just check` clean (typecheck, lint, tests).
- A manual end-to-end smoke test (real Cerebras LLM) completes scoping for one course: clarify → answers → framework → baseline. Verify rows in `context_messages`, JSONB populated on `courses`, prompt cache hits observable in logs.
- No file exceeds 200 LOC unless explicitly justified.
- Every CLAUDE.md and TSDoc reference to the deleted prompt builders is removed or rewritten.
