# Submit Baseline — Design

**Date:** 2026-05-14
**Status:** Approved (pending user review of written spec)
**Scope:** The final tRPC procedure of the scoping flow (`submitBaseline`), the scoping-close LLM turn that produces it, and the shared close-turn primitive that the future Wave-end turn will reuse.

---

## 1. Goal

Wire the closing step of scoping end-to-end. `submitBaseline` accepts the learner's baseline answers, runs one final append-only LLM turn against the existing scoping Context, grades the answers, derives the starting state for teaching, persists everything atomically, and creates Wave 1's row primed for teaching. After this procedure returns, the course is in `status: 'active'` and Wave 1 can be opened with no further LLM call.

The scoping-close turn does triple duty in a single LLM response:

1. **Grades** the baseline (mechanical MC plus model-graded free-text).
2. **Closes** scoping with a user-facing wrap-up message and the durable artifacts that ground every future Wave (immutable learner profile + initial cumulative summary).
3. **Primes** Wave 1 with a blueprint that includes the opening message the learner will see when they enter their first lesson.

Because the same close-turn pattern repeats at the end of every Wave (Wave N's final turn primes Wave N+1), the schema is factored as a shared base extended for scoping-specific fields.

## 2. Non-goals (out of scope, explicitly)

- The Wave-end / next-Wave-blueprint turn itself. This spec factors out the shared base schema but does not implement Wave teaching loops.
- Contiguous-history chat UI. UI is per-phase: scoping view shows scoping; Wave N view shows Wave N. Cross-phase history exploration is post-MVP.
- The SM-2 due-concept injection at Wave boundaries. Baseline-introduced concepts are persisted with default SM-2 fields (untaught); SM-2 fires when teaching happens.
- Concept dedup / drift reconciliation across Waves. Strict natural-key upsert on `(course_id, lower(name))` is sufficient for MVP.
- Streaming responses. All turns are request-response.
- The `determineStartingTier` pure aggregator — deleted by this spec; the LLM emits `startingTier` directly.

## 3. Architecture

### 3.1 One turn, append-only

The scoping-close turn is the final turn of the existing scoping conversation. It appends to the same `context_messages` rows as `clarify`, `generateFramework`, `generateBaseline` — no new system prompt, no fresh Context. The Harness routes through `executeTurn` exactly as the prior scoping turns do, with a stage-specific user envelope rendered by `renderScopingCloseStage`.

The LLM response is a single JSON object validated against `makeScopingCloseSchema({ scopeTiers, questionIds })`. Validation failures route back into the model as teacher-style retry directives via `ValidationGateFailure`, following the JSON-everywhere contract already in use across scoping.

### 3.2 The shared close-turn schema

Scoping-close and the future Wave-end turn share most of their structured output. The shared base lives in `src/lib/prompts/closeTurn.ts`:

```ts
makeCloseTurnBaseSchema({ scopeTiers, questionIds }) → z.object({
  userMessage:       string,   // chat-visible closing message for this unit
  gradings:          item[],   // per-question grading; same shape both flavours
  summary:           string,   // the new state of courses.summary after this turn
  nextUnitBlueprint: blueprint // primes the following Wave
})
```

`closeGradingItemSchema` and `blueprintSchema` (`{ topic, outline, openingText }`) are exported from the same module so the future Wave-end schema reuses them.

The scoping flavour extends the base with two one-shot fields:

```ts
makeScopingCloseSchema({ scopeTiers, questionIds }) → base.extend({
  immutableSummary: string,   // written once at scoping close, never rewritten
  startingTier:     number,   // written once; clamped to scopeTiers server-side
})
```

The wave-end flavour (future) is anticipated to be `makeCloseTurnBaseSchema` unchanged, or with a small wave-specific extension.

### 3.3 Vocabulary on the wire

Internal code keeps team vocab (`Wave`, `scoping`, `tier`). Anything emitted on the wire to the LLM uses learner-facing substitutes:

- **Wave → "lesson"** (per existing project convention).
- **Scoping → "this planning conversation" / "the intake conversation so far"** — situational phrasing, not a single substitute.
- **Tier → "level"** in description text; the JSON field stays numeric.
- **Blueprint → "the plan for the first lesson"** in description text.

Field descriptions are written directive-first (what the model should produce), not explanatory (what the field is for the developer). Developer-meta phrases like "with no further LLM call" do not appear in wire text.

### 3.4 What the scoping-close turn emits

```ts
{
  userMessage:       string,   // shown in scoping view as closing message
  gradings: [{
    questionId:    string,    // copied verbatim from baseline.questions
    verdict:       "correct" | "partial" | "incorrect",
    qualityScore:  0..5,       // band-aligned with verdict
    conceptName:   string,
    conceptTier:   number,     // clamped to scopeTiers
    rationale:     string,
  }],
  immutableSummary: string,   // stable per-Wave learner profile, written once
  summary:          string,   // initial value of courses.summary (will evolve)
  startingTier:     number,   // clamped to scopeTiers
  nextUnitBlueprint: {
    topic:       string,
    outline:     string[],
    openingText: string,       // first assistant message of Wave 1
  },
}
```

Server-computed, never emitted: total XP, SM-2 state, `nextStage` (derivable from `courses.status`).

### 3.5 Data model changes

Three small extensions, no migrations:

**`courses.baseline` JSONB widens** (in `src/lib/types/jsonb.ts`):

```
{
  userMessage, questions, responses, gradings,   // existing
  immutableSummary,                              // NEW
  summarySeed,                                   // NEW — verbatim of LLM-emitted summary
  startingTier,                                  // NEW — verbatim of LLM-emitted starting tier
}
```

`summarySeed` is stored alongside `courses.summary` so the original scoping-close emission is preserved verbatim even after `courses.summary` is rewritten by future Wave-end turns.

**`gradings[]` items extend** with `conceptTier: number` so the concept upsert can place the concept at the LLM-chosen level.

**`seedSourceSchema` extends** so `scoping_handoff` carries the blueprint payload, symmetric with `prior_blueprint`:

```ts
seedSourceSchema = discriminatedUnion("kind", [
  { kind: "scoping_handoff", blueprint }, // CHANGED: was bare marker
  { kind: "prior_blueprint", priorWaveId, blueprint },
]);
```

This is the DRY hinge: Wave-open code reads the blueprint from `seed_source` uniformly regardless of provenance. Wave 1's open path becomes structurally identical to Wave N's.

**No new columns on `courses`**, no migration. The widened JSONB shape is enforced by Zod row-guards in `src/db/queries/courses.ts`.

### 3.6 Wave 1 row creation

`submitBaseline` inserts the Wave 1 row inside the same transaction that closes scoping. The row has:

- `course_id` = the course
- `wave_number = 1`
- `seed_source = { kind: "scoping_handoff", blueprint: nextUnitBlueprint }`
- Status fields per existing waves schema

Plus one `context_messages` row scoped to that wave:

- `wave_id = wave1.id`
- `role = "assistant"`
- `content = blueprint.openingText`
- `turn_index = 0`, `seq = 0`

So when the learner enters Wave 1 and sends their first message, the LLM's stateless replay sees: Wave 1 system prompt → assistant openingText → user reply. No additional LLM call is needed to open Wave 1.

### 3.7 Concept and assessment writes — Pattern B

Baseline grading is **data**, not an SM-2 review event.

For each grading item:

- `concepts`: upsert by `(course_id, lower(conceptName))` with `tier = conceptTier`. SM-2 fields stay at defaults — `lastReviewedAt`, `nextReviewAt`, `lastQualityScore` remain NULL. The concept enters the "never reviewed yet" state the schema explicitly models via its partial index.
- `assessments`: insert one row carrying the baseline `qualityScore`, `verdict`, `rationale`, plus the question and the learner's answer. Durable for analytics; does not affect SM-2.

This preserves the "untaught vs review-due" distinction that the future Wave selection logic depends on:

- **Untaught in scope** (`lastReviewedAt IS NULL`, `tier ≤ currentTier`) → candidates the model can choose to teach.
- **Due for review** (`nextReviewAt <= now`) → must surface at Wave boundary.

SM-2 first fires when a Wave actually teaches a concept.

### 3.8 XP computation

Total XP for the baseline is computed server-side and atomic:

```ts
totalXp = sum( calculateXP(startingTier, grading.qualityScore) for each grading )
```

`calculateXP` is the existing pure function. `startingTier` is the LLM-emitted, Zod-validated value (refine failures retry via the model). The LLM influences XP only indirectly through `qualityScore` and `startingTier`; it never emits an XP value, never sees XP in any prompt, and the formula is server-side and deterministic.

`courses.total_xp` is bumped via the existing atomic `incrementCourseXp(courseId, totalXp)` query inside the same transaction.

### 3.9 Field description examples (illustrative)

These are starting points showing the directive, outcome-led voice — what the model should produce, not what the field is for the developer. The implementer should adapt and refine them; they are not locked text.

**Grading item fields:**

```ts
questionId: z.string().describe(
  "The id of the question you are grading. Copy verbatim from the question this evaluation refers to.",
);

verdict: z.enum(["correct", "partial", "incorrect"]).describe(
  "Judge the learner's answer against the expected answer. Use 'correct' only when the answer captures the key idea; 'partial' when the learner shows some grasp but misses important pieces; 'incorrect' when the answer misses the point or is wrong.",
);

qualityScore: z.number()
  .int()
  .min(0)
  .max(5)
  .describe(
    "Score the answer 0-5. 5 = fluent, fully correct. 4 = correct with minor gaps. 3 = mostly right, notable gap. 2 = partial grasp, important errors. 1 = wrong but related. 0 = no understanding. Keep this in band with your verdict (correct → 4-5, partial → 2-3, incorrect → 0-1).",
  );

conceptName: z.string()
  .min(1)
  .describe(
    "Name the single concept this question probes. Use the noun-phrase a learner would search for, e.g. 'Rust ownership', not 'the idea that values have owners'. Keep names consistent across questions that probe the same concept.",
  );

conceptTier: z.number()
  .int()
  .describe(
    "Place the concept at the level a learner needs to reach to grasp it confidently. Use the level numbers from the framework you produced earlier in this conversation. Don't drift outside the framework's level range.",
  );

rationale: z.string().describe(
  "Two sentences. First sentence: name what the learner got right or wrong. Second sentence: what this tells you about where to start teaching them.",
);
```

**Blueprint fields:**

```ts
topic: z.string()
  .min(1)
  .describe(
    "Name the focus of the first lesson in 3-7 words. This is the headline the learner sees when they enter the lesson.",
  );

outline: z.array(z.string().min(1))
  .min(1)
  .describe(
    "List the beats of the first lesson, one bullet per beat, 3-6 bullets. Order them in the sequence you'll teach them. Each beat is a phrase, not a sentence.",
  );

openingText: z.string()
  .min(1)
  .describe(
    "Write the first message the learner sees when they open lesson 1. 2-4 sentences. Greet them by what you've learned about them, name what you'll teach in this lesson, invite their first response. Conversational, warm, no markdown headers.",
  );
```

**Top-level close-turn fields:**

```ts
userMessage: z.string()
  .min(1)
  .describe(
    "Write the message the learner sees as the closing of this planning conversation. Acknowledge a specific thing you've learned about them, then signal that their first lesson is ready. 2-3 sentences. Conversational.",
  );

summary: z.string()
  .min(1)
  .describe(
    "Write a 2-3 sentence summary of where this learner is starting from in this subject, based on how they performed so far. This summary will grow as the course progresses; you're writing its current state.",
  );
```

**Scoping-only extensions:**

```ts
immutableSummary: z.string()
  .min(1)
  .describe(
    "Capture the durable facts about this learner that should ground every future lesson: their background, what they're trying to achieve, what they already know, what motivates them. 3-5 sentences. Write what you'd want to be reminded of at the start of every lesson you teach them.",
  );

startingTier: z.number()
  .int()
  .describe(
    "Choose the framework level at which lesson 1 should begin teaching. Base it on the learner's performance: where did they show competence, where did they show gaps? Pick the lowest level at which they need real teaching. Stay inside the framework's level range.",
  );
```

The voice across all of these: imperative, outcome-led, learner-facing vocabulary (lesson/level), no developer-meta phrases ("with no further LLM call", "for downstream use", etc.), concrete length guidance where useful ("2-3 sentences", "3-6 bullets"), and inline restatements of band/range constraints so the model has the rule both in the description and in the refinement.

## 4. The lib step

```
src/lib/course/submitBaseline.ts          (orchestration: preconditions, executeTurn, calls persist)
src/lib/course/submitBaseline.persist.ts  (transaction body: all the writes)
src/lib/course/submitBaseline.internal.ts (MC grading helpers; content of old gradeBaseline.internal.ts)
```

Three files instead of two because the post-LLM persistence body is large enough that bundling it with the orchestration would breach the 200-LOC ceiling.

### 4.1 Orchestration (`submitBaseline.ts`)

Mirrors the structure of `generateBaseline.ts`:

```ts
export async function submitBaseline(params: SubmitBaselineParams) {
  const course = await getCourseById(params.courseId, params.userId);

  // Idempotency: status === 'active' returns persisted state
  if (course.status === "active") return buildCachedPayload(course);

  // Preconditions
  if (course.status !== "scoping") throw PRECONDITION_FAILED;
  if (course.framework === null || course.baseline === null) throw PRECONDITION_FAILED;
  assertAnswersCoverAllQuestions(course.baseline.questions, params.answers);

  // Mechanical MC grading (no LLM)
  const mcGradings = gradeMcAnswers(course.baseline.questions, params.answers);

  // Schema closed over runtime scopeTiers + questionIds
  const responseSchema = makeScopingCloseSchema({
    scopeTiers: course.framework.scopeTiers,
    questionIds: course.baseline.questions.map(q => q.id),
  });

  // Append-only scoping turn; pre-graded MCs handed to the model in envelope
  const pass = await ensureOpenScopingPass(course.id);
  const userMessageContent = renderScopingCloseStage({
    questions: course.baseline.questions,
    answers: params.answers,
    mcGradings,
    framework: course.framework,
  });
  const { parsed } = await executeTurn({
    parent, seed, userMessageContent, responseSchema, ...
  });

  // Merge mechanical MC gradings with LLM free-text gradings; compute total XP
  const merged = mergeAndComputeXp(parsed, mcGradings, course);

  // Persist atomically
  return persistScopingClose({ course, merged, params });
}
```

The all-MC shortcut from the legacy `gradeBaseline.ts` is **removed**: the scoping-close turn always runs because the model still owns the summaries, blueprint, and `startingTier` even when all questions were MC.

### 4.2 Persistence (`submitBaseline.persist.ts`)

Wrapped in a single `db.transaction`. Order:

1. UPDATE `courses.baseline` JSONB with the extended payload (raw `db.execute(sql\`UPDATE ...\`)`per the queries CLAUDE.md — Drizzle`.set()` is banned).
2. Upsert one concept per distinct `conceptName` in gradings (default SM-2 fields, tier from LLM).
3. Insert one assessment row per grading.
4. Insert the Wave 1 row with `seed_source = { kind: "scoping_handoff", blueprint }`.
5. Insert one `context_messages` row (wave_id = wave1.id, role = assistant, content = openingText).
6. `setCourseStartingState`: writes `summary` (from `summarySeed`), `starting_tier`, `current_tier = starting_tier`, flips `status` to `'active'`.
7. `incrementCourseXp(course.id, totalXp)`.

If any step fails, Postgres rolls the whole thing back; course stays in `scoping`. Retry is safe — the next `submitBaseline` call re-enters the LLM turn path because `status !== 'active'`.

### 4.3 The merge function

`mergeAndComputeXp` (pure, in `submitBaseline.ts` or a small sibling) does three things:

1. Asserts `startingTier` and every `conceptTier` are inside `scopeTiers`. Out-of-range values throw — they indicate a bug (the Zod refinement should have caught them and triggered the retry loop). Defence-in-depth, not silent clamping.
2. Merges mechanical MC gradings with LLM free-text gradings into the canonical `gradings[]` order matching `course.baseline.questions`.
3. Computes `totalXp` as the sum of `calculateXP(startingTier, qualityScore)` across the merged gradings.

Returns a plain object; no DB calls. Unit-tested as a pure function.

## 5. The router

```ts
// src/server/routers/course/submitBaseline.ts
export const submitBaselineProcedure = protectedProcedure
  .input(
    z.object({
      courseId: z.string().uuid(),
      answers: z.array(baselineAnswerSchema), // { questionId, answer }
    }),
  )
  .mutation(async ({ ctx, input }) =>
    submitBaseline({
      userId: ctx.user.id,
      courseId: input.courseId,
      answers: input.answers,
    }),
  );
```

Mounted in `src/server/routers/course.ts` alongside the existing scoping procedures.

Return type: `{ userMessage: string; wave1Id: string }`. The client renders `userMessage` in the scoping view, then offers the "start your first lesson" button which navigates into Wave 1's view; the Wave 1 view fetches its own state (including `openingText`) from `context_messages` directly.

## 6. Error handling

| Failure mode                                  | Surface          | Behaviour                                                                     |
| --------------------------------------------- | ---------------- | ----------------------------------------------------------------------------- |
| `courseId` not found / wrong user             | `getCourseById`  | Throws `NotFoundError("course", id)`. tRPC maps to 404.                       |
| Status not `'scoping'` nor `'active'`         | precondition     | `PRECONDITION_FAILED`.                                                        |
| Missing clarification/framework/baseline      | precondition     | `PRECONDITION_FAILED`.                                                        |
| Answers don't cover all baseline question ids | precondition     | `PRECONDITION_FAILED` with the missing ids.                                   |
| LLM returns malformed JSON                    | `executeTurn`    | `ValidationGateFailure` → retry up to `SCOPING.maxParseRetries`, then bubble. |
| `startingTier` outside `scopeTiers`           | superRefine      | `ValidationGateFailure` → retry with directive.                               |
| `conceptTier` outside `scopeTiers`            | superRefine      | Same.                                                                         |
| `verdict` / `qualityScore` out of band        | superRefine      | Same.                                                                         |
| DB transaction failure mid-way                | `db.transaction` | Rollback; course stays in `scoping`. Caller retries.                          |
| `status === 'active'` (idempotent retry)      | early return     | Reads persisted state, returns same payload shape. No LLM, no writes.         |

Refine messages are written as teacher-style retry directives so the model can fix its own output on the next attempt, consistent with the JSON-everywhere contract.

## 7. Testing

### 7.1 Pure-logic TDD (red → green)

- MC grading helpers in `submitBaseline.internal.ts` — keep existing unit tests, adjust imports.
- `clampAndMerge` — new pure function. Tests:
  - Out-of-range `startingTier` is clamped to scope.
  - Out-of-range `conceptTier` is clamped to scope.
  - Mechanical MC gradings merge with LLM gradings without duplicates and in the canonical question order.
  - Total XP equals sum of `calculateXP(startingTier, qualityScore)` across all gradings.

### 7.2 Integration tests (`submitBaseline.test.ts`)

Real Postgres via testcontainers. `executeTurn` mocked to return canned scopingClose JSON.

- **Happy path**: status `'scoping'` with valid baseline → executeTurn returns valid JSON → after call: status `'active'`, Wave 1 row exists with correct `seed_source`, concept rows present with default SM-2 fields, assessments inserted, `courses.summary` populated, `starting_tier == current_tier`, `total_xp` incremented, return shape correct.
- **Idempotency**: second invocation with status `'active'` returns the same payload shape; executeTurn mock is called once total (assert call count == 1).
- **Precondition failures**: missing baseline JSONB; missing framework; answers don't cover all questions; wrong user — each throws the right error.
- **Validation retry**: first executeTurn attempt returns `startingTier` outside scope → ValidationGateFailure → second attempt valid → final state correct, retry count observed.
- **Transaction rollback**: force a failure in the Wave insert → assert course is still `'scoping'`, no concepts or assessments persisted, no Wave row exists.

### 7.3 Live smoke (`just smoke`, opt-in)

`scripts/smoke/scoping-close.ts` drives a full scoping conversation against live Cerebras llama3.1-8b:

1. Create course, run `clarify`, `generateFramework`, `generateBaseline`.
2. Submit canned answers via `submitBaseline`.
3. Assert: parseable JSON; schema satisfied; `userMessage` and `openingText` non-empty; `startingTier` inside `scopeTiers`; gradings cover every question.

Validates the directive description style produces coherent output on the floor model before its 2026-05-27 deprecation.

### 7.4 What we don't test

The exact wording of `userMessage`, `immutableSummary`, `summary`, `openingText`, and `rationale` strings. Those are LLM creative outputs; we assert shape and presence, not content.

## 8. Cleanup

Files this milestone deletes or rewrites:

1. **Delete** `src/lib/prompts/baselineGrading.ts` (schema subsumed by `closeTurn.ts` + `scopingClose.ts`).
2. **Delete** `src/lib/course/gradeBaseline.ts` and `gradeBaseline.internal.ts` (content moves to `submitBaseline.*`).
3. **Delete** `src/lib/course/determineStartingTier.ts` and its tests (LLM emits `startingTier` directly).
4. **Rewrite** the `grading` stage block inside `src/lib/prompts/scoping.ts` to describe the full scoping-close emission with lesson/level vocabulary in directive voice.
5. **Update** `src/lib/types/jsonb.ts`: widen `baselineJsonbSchema`; extend `seedSourceSchema.scoping_handoff` to carry blueprint.
6. **Clear** the stale "migrate gradeBaseline to executeTurn" entry from `TODO.md` — already done in a prior milestone.

## 9. Acceptance criteria

The milestone is done when all of the following are true:

- `course.submitBaseline` exists as a tRPC mutation accepting `{ courseId, answers[] }` and returning `{ userMessage, wave1Id }`.
- Calling it on a `scoping`-status course performs exactly one append-only LLM turn against the existing scoping Context, validation-gated via `makeScopingCloseSchema`, with retry on refine failures.
- All artifacts persist atomically: `courses.baseline` JSONB widened with `immutableSummary`/`summarySeed`/`startingTier`; `concepts` upserted with default SM-2 fields; `assessments` inserted; `courses.summary`/`starting_tier`/`current_tier` populated; `courses.status` flips to `'active'`; `courses.total_xp` incremented deterministically; Wave 1 row inserted with `seed_source.scoping_handoff` carrying the blueprint and one `context_messages` row containing `openingText`.
- Idempotency works: a second call on `'active'` returns the same payload shape with no LLM call and no DB writes.
- All files removed per §8.
- `just check` passes (typecheck + lint + tests).
- `just smoke` passes once against live Cerebras llama3.1-8b.
- This work lands via PR from `feat/submit-baseline` to `main` — never committed directly to `main`.

## 10. Subsequent milestone seam

The next milestone is the Wave teaching loop. This spec sets it up to be small:

- `makeCloseTurnBaseSchema` is already in place; Wave-end likely uses it unchanged.
- `seedSourceSchema.scoping_handoff` already carries blueprint identically to `prior_blueprint`; Wave-open code reads either provenance uniformly.
- Wave 1 row is already created and primed by `submitBaseline`; the Wave teaching procedure does not need to handle Wave 1 specially.
