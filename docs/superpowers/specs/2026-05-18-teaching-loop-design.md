# Teaching Loop — Design

**Date:** 2026-05-18
**Status:** Drafted (pending user review)
**Scope:** End-to-end teaching loop: per-Wave teach → assess → SM-2 → XP, including Wave-close blueprint handoff that seeds the next Wave. Builds on the shared `makeCloseTurnBaseSchema` introduced by the submit-baseline spec.

---

## 1. Goal

Replace the `/course/[id]/wave/[n]/page.tsx` stub with a working teaching loop. After scoping closes, the learner navigates into Wave 1 and engages in a `WAVE.turnCount`-turn dialogue. Each turn the LLM teaches a beat and optionally drops a structured questionnaire (1-N MC or free-text questions). The final turn closes the Wave: it grades the last drop, applies SM-2 updates against concepts the model judges holistically retaught, awards a flat Wave-completion XP bonus, optionally runs the tier-advancement check, and emits a blueprint plus opening message that seeds Wave N+1.

The architectural thesis is **symmetry with scoping**: a Wave is one Context, append-only, terminated by a close turn that uses the same `makeCloseTurnBaseSchema` base as scoping-close. The only Wave-specific extension is `conceptUpdates[]` (the SM-2 batch). Scoping is a one-off conversation; teaching is the same conversation shape, repeated per Wave, seeded each time by the prior Wave's blueprint.

## 2. Non-goals

- **Streaming responses.** All LLM calls remain request-response.
- **Cross-Wave history** in the UI. Each Wave page renders its own Context only. A learner navigating to `/course/[id]/wave/3` does not see Waves 1–2.
- **Concept dedup across courses.** Concepts are per-course; identical concept names in two different courses are two distinct rows.
- **Streaming SM-2 mid-Wave.** Per-question gradings update assessment rows and XP only. SM-2 mutations occur exclusively at Wave-close, via the model's `conceptUpdates[]` batch decision.
- **Mid-Wave tier shifts.** Tier-advancement runs at Wave-close on a gated cadence (default every 2 Waves; tunable). Any shift takes effect at the next Wave's seed only.
- **Model swap.** Stay on `llama3.1-8b` until the Cerebras 2026-05-27 sunset.
- **Cross-phase chat UI.** Onboarding (scoping) and WaveSession live on separate routes.
- **Authoring tools** for hand-crafted Waves or curated concept libraries.

## 3. Architectural overview

### 3.1 Scoping ≈ Wave symmetry

| Aspect                | Scoping                                                        | Wave                                                                                        |
| --------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Context lifetime      | 1 per course                                                   | 1 per Wave                                                                                  |
| System prompt emitted | Once, on `clarify`                                             | Once, at Wave-open                                                                          |
| Mid-turn shape        | clarify-reply / framework / baseline-intro / baseline-reply    | teaching-reply, optional questionnaire drop                                                 |
| Close-turn schema     | `makeCloseTurnBaseSchema` + `{immutableSummary, startingTier}` | `makeCloseTurnBaseSchema` + `{conceptUpdates}`                                              |
| Final-turn payload    | Grades + close message + Wave 1 blueprint                      | Grades + close message + Wave N+1 blueprint + SM-2 updates                                  |
| Harness injections    | None mid-conversation                                          | `<turns_remaining>N</turns_remaining>` every turn; `<concepts_for_next_wave>` on final turn |
| Seed for next phase   | `seedSource.scoping_handoff.blueprint`                         | `seedSource.prior_blueprint`                                                                |

The reusable primitives are: `executeTurn` (already stage-agnostic), `makeCloseTurnBaseSchema`, `renderStageEnvelope`, `Composer`, `MessageBubble`, `FrameworkTierList`, and the per-question answer-shape (`shapeQuestionnaireAnswers`). New code is thin glue plus the Wave-specific mid-turn schema and persistence.

### 3.2 Context lifecycle per Wave

1. **Open.** Wave row exists with `seed_source = {kind: "prior_blueprint" | "scoping_handoff", blueprint}`. The harness emits the system prompt once (role block + pedagogy in prose + `<planned_concepts>` block derived from the blueprint), persists it as turn-0 assistant context, and persists the blueprint's `openingText` as turn-0 user-visible assistant text. The learner sees the opening message immediately on navigation; no LLM call is made on page load.
2. **Mid-turns 1 … `WAVE.turnCount - 1`.** Each user reply triggers one `executeTurn` call against `waveMidTurnSchema`. The harness appends `<turns_remaining>N</turns_remaining>` to the user envelope. The model responds with `userMessage` (teaching content), optional `comprehensionSignals[]` (per-question grading of any questions the user just answered), and optional `questionnaire` (1-N new questions to drop into the conversation).
3. **Close turn.** When `turnsRemaining === 0`, the harness appends `<concepts_for_next_wave>` carrying fresh and review-due concept names alongside the standard envelope. The schema swaps to `makeWaveCloseSchema`. The model emits one consolidated JSON: close grades, closing message, blueprint for Wave N+1 (with `plannedConcepts`), and `conceptUpdates[]` (the SM-2 batch).

### 3.3 No mid-Wave tier shift

Even if the close-turn model emits a `startingTier` proposal, the harness only applies it via the `progression.ts` rule at Wave-close, and only when `wave.number % WAVE.tierCheckInterval === 0`. Wave-internal turns operate at `currentTier` throughout. This is non-negotiable: Waves are 5-minute bites, and within-Wave drift would invalidate the system prompt's `<planned_concepts>` framing.

### 3.4 Append-only + retry pruning

`executeTurn` already enforces append-only and prunes `failed_assistant_response + harness_retry_directive` pairs from the loaded Context before each new turn. The 20-row steady-state Wave Context (10 user, 10 assistant) is unaffected by retries — the DB stores them for diagnostics; the model never re-sees them.

## 4. Schemas

### 4.1 Shared close-turn base (extends submit-baseline spec)

`makeCloseTurnBaseSchema(params)` is the shared base from `src/lib/prompts/closeTurn.ts`. This spec extends its parameters and shape:

**Parameter additions:**

- `freshConceptNames: readonly string[]` — concept names available for the next Wave (untaught at currentTier).
- `reviewDueNames: readonly string[]` — concept names SM-2-due at Wave-close.

**Schema additions to the base:**

`blueprintSchema` gains a structured field:

```ts
const plannedConceptSchema = z.object({
  name: z.string().min(1),
  tier: z.number().int(),
  role: z.enum(["fresh", "review"]),
});
// extended:
blueprintSchema = z.object({
  topic: z.string(),
  outline: z.string(),
  openingText: z.string(),
  plannedConcepts: z.array(plannedConceptSchema), // NEW
});
```

`superRefine` on the base:

- `role: "review"` planned concepts: name MUST appear in `reviewDueNames`.
- `role: "fresh"` planned concepts: loose — the model may introduce names not in `freshConceptNames` (this enables continuous concept discovery as the course progresses).
- Refine messages are teacher-style and surface through `ValidationGateFailure` for retry.

`closeGradingItemSchema` becomes a discriminated union by **answer kind** (not card kind), to handle MC-escape transforms (an MC question answered as free-text):

```ts
const closeGradingItemSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mc-index"),
    questionId: z.string(),
    rationale: z.string(),
    // No qualityScore: mechanical correctness only.
  }),
  z.object({
    kind: z.literal("free-text"),
    questionId: z.string(),
    verdict: z.enum(["correct", "partial", "incorrect"]),
    qualityScore: z.number().int().min(0).max(5),
    conceptName: z.string(),
    conceptTier: z.number().int(),
    rationale: z.string(),
  }),
]);
```

### 4.2 Wave-close-only extension

`makeWaveCloseSchema(params)` = `makeCloseTurnBaseSchema(params).and(...)` adding:

```ts
const conceptUpdateSchema = z.object({
  name: z.string().min(1), // must reference an existing concept on this course
  qualityScore: z.number().int().min(0).max(5),
  reason: z.string().min(1), // model's holistic justification
});

waveCloseExtension = z.object({
  conceptUpdates: z.array(conceptUpdateSchema), // may be empty
});
```

**Why batched at close, not per-question:** A single question is not enough evidence to declare a concept retaught. The model decides holistically across the Wave which concepts it has taught enough about to warrant an SM-2 advance. Per-question gradings still drive XP and feedback toasts; only SM-2 state lives in this batch.

A `superRefine` validates that every `conceptUpdates[].name` already exists on this course (lookup at retry-build time). Unknown names route to teacher-style retry with the list of valid names.

### 4.3 Wave mid-turn schema

`src/lib/prompts/waveTurn.ts`:

```ts
const comprehensionSignalSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mc-index"),
    questionId: z.string(),
    rationale: z.string(),
  }),
  z.object({
    kind: z.literal("free-text"),
    questionId: z.string(),
    verdict: z.enum(["correct", "partial", "incorrect"]),
    qualityScore: z.number().int().min(0).max(5),
    rationale: z.string(),
  }),
]);

export const waveMidTurnSchema = z.object({
  userMessage: z.string().min(1),
  comprehensionSignals: z.array(comprehensionSignalSchema).optional(),
  // Optional questionnaire-drop: 1-N questions, mixed MC + free-text.
  // Reuses the existing questionnaireSchema from src/lib/prompts/questionnaire.ts
  // (the same shape baseline emits today).
  questionnaire: questionnaireSchema.optional(),
});
```

**Discriminator-by-answer-kind rationale:** A multiple-choice question answered via the free-text escape is graded as a free-text question — the model only has free-text content to evaluate. So the signal discriminator follows the answer's surface form, not the original card type.

### 4.4 Blueprint handoff structure

Persisted on the next Wave's row at insert time:

```ts
type WaveSeedSource =
  | { kind: "scoping_handoff"; blueprint: BlueprintFromScopingClose }
  | { kind: "prior_blueprint"; blueprint: BlueprintFromWaveClose };
```

Both blueprint variants carry the extended fields: `topic`, `outline`, `openingText`, `plannedConcepts`. The Wave's `WaveSeedInputs` type (consumed by `executeTurn`) is constructed by `buildWaveSeed(course, waveRow)` and includes the course-level `immutableSummary` plus the per-Wave blueprint.

## 5. System prompt + pedagogy

### 5.1 JSON-everywhere contract

`src/lib/prompts/teaching.ts` is rewritten. The legacy multi-XML-tag output format is removed; the system prompt declares the single-JSON contract identically to scoping:

```
You respond with a single JSON object validated against the provided schema.
Do not emit XML tags or other framing.
```

### 5.2 Pedagogy in prose, merged into role block

A separate `<pedagogy>` block is rejected — pedagogy is part of who Nalu is, not a side-channel rule list. The `ROLE_BLOCK` becomes flowing prose:

```
<role>
You are Nalu, an expert teacher and tutor. You teach in short bite-sized
lessons — each lesson is about ten turns of dialogue, roughly five minutes
for the learner. Keep the pacing brisk and the energy warm.

Most turns you teach: a small idea, a worked example, a synthesising
question for the learner to think with. Sometimes you drop a formal
questionnaire — one to a few multiple-choice or short-answer questions
the learner submits as a batch. Use questionnaires sparingly, around one
turn in three, never twice in a row, and alternate types so the learner
doesn't fatigue.

End each lesson on a teaching beat or a synthesising question, not a
quiz. On the final turn the harness will surface concepts due for review
and fresh concepts available at the current tier; weave those into the
next lesson's outline and opening message. Use the exact concept names
from <planned_concepts> verbatim when you reference them in
`conceptName` or `conceptUpdates[].name` fields — the harness matches by
exact string.
</role>
```

### 5.3 `<planned_concepts>` block

Rendered once at Wave-open into the system prompt, derived from `seed_source.blueprint.plannedConcepts`. Format:

```
<planned_concepts>
- name: "Forces of supply and demand" (tier 2, fresh)
- name: "Price elasticity basics" (tier 2, review)
- ...
</planned_concepts>
```

This block is what makes concept-name drift impossible: the model is shown the canonical names it must use, and the close-turn `superRefine` enforces them for review-role updates.

### 5.4 `<concepts_for_next_wave>` injection (close-turn only)

On the final turn the harness appends a sibling block to the user envelope (not the system prompt — Context byte-stability) listing fresh and review-due concepts for the model to choose from when designing Wave N+1's blueprint:

```
<concepts_for_next_wave>
<fresh_at_current_tier>
- "Concept A"
- "Concept B"
</fresh_at_current_tier>
<review_due>
- "Concept X"  (last seen 4 days ago, EF 2.1)
- "Concept Y"  (last seen 7 days ago, EF 1.8)
</review_due>
</concepts_for_next_wave>
```

Empty-list handling: both lists may be empty. The renderer outputs `(none)` in each empty subblock; the model is instructed to design a consolidation lesson and emit `plannedConcepts: []`. The Wave-close tier-advancement gating runs unconditionally in this edge case (overrides the `wave.number % tierCheckInterval` cadence) so a stuck course can be promoted out.

### 5.5 Strict-mode duality

Already solved by `executeTurn` via `getModelCapabilities(modelName).honorsStrictMode`. Strong models receive the schema via `response_format`; weak models (current `llama3.1-8b`) get the inlined `<response_schema>` block. `renderWaveTurnEnvelope` and `renderWaveCloseEnvelope` both accept an optional `responseSchema: string` param matching the scoping envelope contract.

## 6. Lib step + persistence

### 6.1 `submitWaveTurn` entry point

`src/lib/course/submitWaveTurn.ts`. Single dispatch:

```ts
export async function submitWaveTurn(input: SubmitWaveTurnInput): Promise<SubmitWaveTurnOutput> {
  const { course, wave, priorMessages, openQuestionnaire } = await loadWaveContext(input);
  const turnsConsumed = countUserMessageTurns(priorMessages);
  const turnsRemaining = WAVE.turnCount - turnsConsumed - 1;
  const isCloseTurn = turnsRemaining === 0;
  const learnerInput = await buildLearnerInput(input.payload, openQuestionnaire);
  return isCloseTurn
    ? executeWaveClose(course, wave, learnerInput)
    : executeWaveMid(course, wave, learnerInput, turnsRemaining);
}
```

`buildLearnerInput` composes one of two envelope payloads:

- **chat-reply path:** wraps the learner's free-text in `<learner_reply>`.
- **card-answers path:** for each open question, emits a `<card_answer>` block discriminated by answer kind:
  - `kind="mc-index"` — carries `selected_index`, mechanical `verdict` (computed server-side from the persisted correct index), and `correct_index` (for model context).
  - `kind="free-text"` — carries the learner's text. (Originates from either a pure free-text card or an MC card answered via the free-text escape; `fromEscape: true` is annotated in the block for the model's context.)

### 6.2 `executeWaveMid` — per-turn side effects

1. Call `executeTurn({parent: {kind: "wave", id: wave.id}, seed: buildWaveSeed(course, wave), userMessageContent: learnerInput, responseSchema: waveMidTurnSchema})`.
2. On success, run `persistWaveMidTurn(tx, wave, parsed)`:
   - Apply each `comprehensionSignals[]` entry: update the matching open assessment row with verdict + (for free-text) qualityScore; compute and award per-question XP via `calculateXP` (free-text) or `calculateMcXp` (MC). **No SM-2 mutation.** No concept upsert here — concepts are upserted only when introduced.
   - If `questionnaire` is present, insert a new questionnaire row and N assessment rows; upsert any new concepts at default SM-2 (untaught) state. The `correctEnc` field is computed and stored on each MC assessment row.
   - Persist the `user_message + assistant_response` pair (already handled by `executeTurn`'s atomic write). The `user_message.kind` column is set authoritatively by the harness based on the inbound payload kind.
3. Return `{kind: "mid-turn", turnsRemaining, assistantContent, newQuestionnaire?, gradedSignals[]}`.

### 6.3 `executeWaveClose` — close transaction

Single transaction; all-or-nothing:

1. Append `<concepts_for_next_wave>` to the close envelope; render via `renderWaveCloseEnvelope`.
2. Call `executeTurn` with `responseSchema: makeWaveCloseSchema({scopeTiers, questionIds, freshConceptNames, reviewDueNames, existingConceptNames})`.
3. On success in a single DB transaction:
   1. **Apply close grades** — same logic as `persistWaveMidTurn` step 2a, against the close-turn `gradings[]`.
   2. **Apply `conceptUpdates[]`** — for each entry, call `calculateSM2(currentState, qualityScore, now)` and persist new state. SM-2 only; no XP from this step.
   3. **Mark Wave closed** — `waves[N].status = "closed"`, `closed_at = now()`.
   4. **Tier-advancement check** — gated by `(wave.number % WAVE.tierCheckInterval === 0) || (plannedConcepts.length === 0)`. Calls `progression.ts` which returns the new currentTier (possibly unchanged). Persist to `courses.current_tier`.
   5. **Insert Wave N+1 row** — `seed_source: {kind: "prior_blueprint", blueprint: parsed.blueprint}`, `status: "active"`, `started_at: now()`, `wave_number: N+1`.
   6. **Insert opening text** — Wave N+1's `openingText` is persisted as a turn-0 assistant `context_messages` row, so on first navigation the learner sees the opener with no LLM call.
   7. **Award completion XP** — `courses.total_xp += WAVE.completionXp` (flat bonus).
4. Return `{kind: "close-turn", closingMessage, nextWaveNumber, completionXpAwarded, tierAdvancedTo, gradedSignals[]}`.

### 6.4 Helper modules

- `src/lib/course/applyAssessmentGrading.ts` — shared per-question side effect: update assessment row, award per-question XP. No SM-2 touch.
- `src/lib/course/applySm2Update.ts` — close-only: read concept's current SM-2 state, call `calculateSM2`, persist. No XP touch.
- `src/lib/course/buildWaveSeed.ts` — assembles `WaveSeedInputs` from course + wave rows for `executeTurn`.
- `src/lib/course/buildLearnerInput.ts` — composes free-text / card-answers envelope payload.
- `src/lib/course/loadWaveContext.ts` — fetches course, wave, prior messages, open questionnaire (if any) in one round-trip.

### 6.5 XP timing — three paths

| Path                  | When XP fires                          | Where                                                                                    |
| --------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------- |
| MC-index correct      | Instant client-side toast on Confirm   | Composer decodes `correctEnc`, computes `calculateMcXp(tier, correct)` locally           |
| Free-text / MC-escape | Deferred toast on LLM response         | `useWaveState.onSuccess` walks `gradedSignals[]` and fires one toast per free-text entry |
| Wave-completion       | Toast/banner on close-mutation success | `useWaveState.onSuccess` on `kind === "close-turn"`, plus optional tier-advance banner   |

Server's `gradedSignals[].xpAwarded` for MC-index paths reconciles with the client's optimistic toast — discrepancies log a warning and trust the server value.

## 7. Router + UI wiring

### 7.1 `wave.*` tRPC sub-router

`src/server/routers/wave.ts`:

```ts
export const waveRouter = router({
  getState: protectedProcedure
    .input(z.object({ courseId: z.string().uuid(), waveNumber: z.number().int().min(1) }))
    .query(({ ctx, input }) => getWaveState({ userId: ctx.userId, ...input })),

  submitTurn: protectedProcedure
    .input(
      z.object({
        courseId: z.string().uuid(),
        waveNumber: z.number().int().min(1),
        payload: z.discriminatedUnion("kind", [
          z.object({ kind: z.literal("chat-reply"), text: z.string().min(1) }),
          z.object({
            kind: z.literal("card-answers"),
            questionnaireId: z.string(),
            answers: z.array(
              z.discriminatedUnion("kind", [
                z.object({
                  id: z.string(),
                  kind: z.literal("mc"),
                  selected: z.enum(["A", "B", "C", "D"]),
                }),
                z.object({
                  id: z.string(),
                  kind: z.literal("freetext"),
                  text: z.string().min(1),
                  fromEscape: z.boolean(),
                }),
              ]),
            ),
          }),
        ]),
      }),
    )
    .mutation(({ ctx, input }) => submitWaveTurn({ userId: ctx.userId, ...input })),
});
```

Mounted in `src/server/routers/index.ts` as `wave: waveRouter`.

### 7.2 `getWaveState` return shape

```ts
interface WaveState {
  readonly courseId: string;
  readonly waveNumber: number;
  readonly currentTier: number;
  readonly turnsRemaining: number;
  readonly messages: readonly RenderedMessage[]; // ordered, with user_message.kind
  readonly openQuestionnaire: OpenQuestionnaireForClient | null;
  readonly status: "active" | "closed";
  readonly closeResult: null | {
    readonly closingMessage: string;
    readonly nextWaveNumber: number;
    readonly completionXpAwarded: number;
    readonly tierAdvancedTo: number | null;
  };
}
```

`OpenQuestionnaireForClient` carries `correctEnc` (not `correctIndex`) on MC questions. All exposure of correct answers passes through `redactQuestionnaire(row)` in `src/lib/course/redactQuestionnaire.ts` — server-side encoding chokepoint.

### 7.3 `submitTurn` return shape

```ts
type SubmitWaveTurnOutput =
  | {
      readonly kind: "mid-turn";
      readonly turnsRemaining: number;
      readonly assistantContent: string;
      readonly newQuestionnaire: OpenQuestionnaireForClient | null;
      readonly gradedSignals: readonly GradedSignalForClient[];
    }
  | {
      readonly kind: "close-turn";
      readonly closingMessage: string;
      readonly nextWaveNumber: number;
      readonly completionXpAwarded: number;
      readonly tierAdvancedTo: number | null;
      readonly gradedSignals: readonly GradedSignalForClient[];
    };

type GradedSignalForClient =
  | { kind: "mc-index"; questionId: string; correct: boolean; xpAwarded: number }
  | { kind: "free-text"; questionId: string; qualityScore: number; xpAwarded: number };
```

### 7.4 `useWaveState` hook

Parallel to `useScopingState`. Drives `wave.getState` + `wave.submitTurn`. No auto-dispatch chain — Wave turns are entirely user-driven. On mutation success: emit deferred XP toasts from `gradedSignals[]`; on `close-turn`, emit completion banner; invalidate `getState` query.

### 7.5 Turn union refactor (phase-agnostic)

`src/lib/types/turn.ts`:

```ts
export type Turn =
  | { readonly kind: "user-text"; readonly content: string }
  | { readonly kind: "assistant-text"; readonly content: string }
  | {
      readonly kind: "assistant-text-with-framework";
      readonly userMessage: string;
      readonly tiers: ReadonlyArray<{ number: number; name: string; description: string }>;
    }
  | {
      readonly kind: "assistant-text-with-questionnaire";
      readonly content: string;
      readonly questionnaire: {
        readonly questions: readonly OpenQuestionForClient[]; // 1-N
        readonly questionnaireId: string;
      };
    }
  | { readonly kind: "user-card-answers"; readonly content: string }
  | { readonly kind: "move-on-cta"; readonly next: { phase: "wave"; n: number } };
```

Mapping from existing scoping variants is mechanical. `deriveTurns.ts` (scoping) is renamed-in-place. `MessageBubble` is unchanged — it consumes `{role, content}` and is agnostic to Turn kind. The Turn-kind switch lives in the page-level components (`Onboarding.tsx` for scoping, `WaveSession.tsx` for Waves).

### 7.6 `WaveSession.tsx` component

Parallel to `Onboarding.tsx`. Drives `useWaveState`, walks `turns[]`, renders `<MessageBubble>` for text turns, lets the Composer pick up the active questionnaire via `useWaveState.activeQuestionnaire`. `/course/[id]/wave/[n]/page.tsx` becomes a thin server-component wrapper:

```tsx
export default async function WavePage({ params }) {
  const { id, n } = await params;
  const waveNumber = Number.parseInt(n, 10);
  return <WaveSession courseId={id} waveNumber={waveNumber} />;
}
```

`<WaveSession>` validates `waveNumber` is a real wave on the course (via `getWaveState` rejection) and redirects to scoping on miss.

### 7.7 Composer reuse

The Composer already accepts `questions: ChoiceQuestion[] | null` and handles 1-N mixed-mode questionnaires. No Composer changes. `adaptOpenQuestion` (new helper in `adaptQuestionnaire.ts`) decodes `correctEnc` per-question client-side and produces a `ChoiceQuestion`.

### 7.8 `correctEnc` obfuscation

`src/lib/security/obfuscateCorrect.ts`:

```ts
export function encodeCorrect(questionId: string, index: number): string {
  return Buffer.from(`${questionId}:${index}`, "utf8").toString("base64");
}

export function decodeCorrect(questionId: string, encoded: string): number | null {
  const decoded = Buffer.from(encoded, "base64").toString("utf8");
  const [qid, idxStr] = decoded.split(":");
  if (qid !== questionId) return null;
  const n = Number.parseInt(idxStr, 10);
  return Number.isInteger(n) && n >= 0 ? n : null;
}
```

Casual deterrent only — keeps the correct answer off the wire as plaintext while still enabling instant client-side feedback. Worst-case bypass costs the cheater their own learning; explicitly accepted trade-off.

## 8. Persistence — schema deltas

### 8.1 Migration: `user_message.kind` column

First migration on the teaching-loop branch. Adds:

```sql
ALTER TABLE user_message
  ADD COLUMN kind TEXT
    CHECK (kind IN ('chat-reply', 'card-answers'));

-- One-time backfill of existing scoping rows. Baseline-answer rows carry
-- the persisted answers payload; clarify-reply rows are free-flowing.
UPDATE user_message SET kind = 'card-answers'
  WHERE id IN (SELECT id FROM user_message WHERE /* baseline-answer marker */);
UPDATE user_message SET kind = 'chat-reply' WHERE kind IS NULL;

ALTER TABLE user_message ALTER COLUMN kind SET NOT NULL;
```

The harness sets this authoritatively when persisting each row going forward; the backfill exists only to satisfy `NOT NULL` for pre-existing scoping rows. Scoping's `deriveTurns` still infers turn shape via row-ordering and doesn't depend on the column at read time.

Naming: `chat-reply` is free-flowing conversational text; `card-answers` is a batch submission against an open questionnaire. Both are textually free-text at the keyboard level — the distinction is intent.

### 8.2 Wave row `seed_source` JSONB schema

```ts
type WaveSeedSource =
  | { kind: "scoping_handoff"; blueprint: BlueprintFromScopingClose }
  | { kind: "prior_blueprint"; blueprint: BlueprintFromWaveClose };
```

Both blueprint variants carry `{topic, outline, openingText, plannedConcepts}`. The `scoping_handoff` variant additionally embeds the immutable summary at scoping-close time; the `prior_blueprint` variant relies on `courses.immutable_summary` (set once at scoping-close, never mutated).

### 8.3 Concept row extension

Existing concept rows already carry SM-2 fields. The close-turn `superRefine` requires a `getExistingConceptNames(courseId)` query at retry-build time. No schema change to concepts.

### 8.4 DB query extensions

New / extended queries in `src/db/queries/`:

- `waves.markClosed(waveId, closedAt)`
- `waves.insert({courseId, waveNumber, seedSource, openingText})`
- `assessments.insertBatch(rows)` — N questions per drop
- `assessments.updateGrading(id, verdict, qualityScore?)`
- `assessments.getOpenForWave(waveId)`
- `concepts.updateSm2(courseId, name, sm2State)`
- `concepts.getByNames(courseId, names)` for the close-turn validator

## 9. Tunables

`src/lib/config/tuning.ts` gains:

```ts
export const WAVE = {
  turnCount: 10,
  tierCheckInterval: 2, // MVP value; production target ~5
  completionXp: 50,
} as const;
```

Adds to `XP`:

```ts
export const XP = {
  basePerTier: 10,
  qualityMultipliers: { 0: 0, 1: 0, 2: 0.25, 3: 0.75, 4: 1.0, 5: 1.5 },
  mcCorrectMultiplier: 1.0, // equivalent to free-text qualityScore=4
} as const;
```

`calculateMcXp(tier, correct)` returns `correct ? XP.basePerTier * tier * XP.mcCorrectMultiplier : 0`. ESLint's `no-magic-numbers` rule in scoring already forbids inlining these values; the rule extends to `mcCorrectMultiplier`.

## 10. Concept-injection helpers

`src/lib/spaced-repetition/scheduler.ts` gains:

```ts
export async function getFreshConcepts(
  courseId: string,
  currentTier: number,
): Promise<readonly ConceptForInjection[]>;

export async function getDueConcepts(
  courseId: string,
  now: Date,
): Promise<readonly ConceptForInjection[]>;
// existing — no change.

export function renderConceptInjection(
  fresh: readonly ConceptForInjection[],
  due: readonly ConceptForInjection[],
): string;
```

`renderConceptInjection` returns the `<concepts_for_next_wave>` block. Both subblocks emit `(none)` for empty arrays so the model has an unambiguous signal in the consolidation edge case.

`getFreshConcepts` returns concepts where `taught_at IS NULL` AND `tier === currentTier`. Stays scoped to `currentTier` — promoting into higher tiers requires the tier-advancement check first.

## 11. Back-fills (scoping reuses Wave primitives)

To honor DRY symmetry, two back-fills land alongside the Wave code:

1. **`submitBaseline` schema params** — pass `availableConceptNames: scopingBaselineConceptNames`, `reviewDueNames: []` so the scoping-close `blueprintSchema` and refines accept the same shape Wave-close emits.
2. **`submitBaseline.persist`** — persist `plannedConcepts` onto `waves[1].seed_source.scoping_handoff.blueprint.plannedConcepts` so Wave 1 has the same blueprint structure Wave 2+ will have.
3. **`shapeBaselineAnswers` → `shapeQuestionnaireAnswers`** — rename, reuse from both `submitBaseline.ts` and `submitWaveTurn.ts`.

## 12. Testing strategy

### 12.1 Pure-function TDD

- `calculateMcXp` — table-driven tests for tier × correct/incorrect.
- `encodeCorrect` / `decodeCorrect` — round-trip + binding violation (questionId mismatch returns null).
- `renderConceptInjection` — empty / partial / full coverage.
- `deriveWaveTurns` — fixture-driven; covers chat-reply, card-answers, questionnaire-drop, close, move-on-cta.

### 12.2 Integration tests (real DB)

- `submitWaveTurn` mid-turn happy path: chat-reply → assistant text, no questionnaire.
- `submitWaveTurn` mid-turn with questionnaire drop: assertion that new assessment rows + open questionnaire surface on next `getWaveState`.
- `submitWaveTurn` mid-turn card-answers: assertion that assessments updated, XP awarded, no SM-2 mutation.
- `submitWaveTurn` close-turn: all-or-nothing transaction asserts (Wave closed + Wave N+1 inserted + SM-2 batched + completion XP awarded).
- `submitWaveTurn` close-turn with empty concept lists: consolidation path, unconditional tier check.
- Retry-pruning: forced ValidationGateFailure leaves no failed pair in the loaded Context.

### 12.3 Live-smoke (`CEREBRAS_LIVE=1`)

- One full Wave end-to-end against the live model, labels `"wave-mid"` and `"wave-close"`. Quiet mode collapses to ✓ summary; verbose mode shows prompt + response + parse outcome per turn.

### 12.4 UI

- Composer multi-card path already covered by scoping baseline tests; no new Composer test required.
- `useWaveState` test (jsdom): mock tRPC, assert toast-emission paths for each `gradedSignals` shape.

## 13. File delta summary

**New:**

- `src/lib/prompts/waveTurn.ts`, `waveClose.ts`
- `src/lib/course/submitWaveTurn.ts`, `executeWaveMid.ts`, `executeWaveClose.ts`
- `src/lib/course/persistWaveMidTurn.ts`, `persistWaveClose.ts`
- `src/lib/course/applyAssessmentGrading.ts`, `applySm2Update.ts`
- `src/lib/course/buildWaveSeed.ts`, `buildLearnerInput.ts`, `loadWaveContext.ts`
- `src/lib/course/getWaveState.ts`, `deriveWaveTurns.ts`, `redactQuestionnaire.ts`
- `src/lib/security/obfuscateCorrect.ts`
- `src/server/routers/wave.ts`
- `src/hooks/useWaveState.ts`
- `src/components/chat/WaveSession.tsx`
- Migration: `user_message.kind` column
- Colocated tests for each of the above

**Modified:**

- `src/lib/prompts/closeTurn.ts` — extend params with `freshConceptNames` / `reviewDueNames`; add `plannedConcepts` to blueprint; discriminated-union `closeGradingItemSchema`
- `src/lib/prompts/teaching.ts` — full rewrite (JSON-everywhere, prose ROLE_BLOCK, `<planned_concepts>` block)
- `src/lib/types/turn.ts` — phase-agnostic union
- `src/lib/types/context.ts` — `WaveSeedInputs`
- `src/lib/course/deriveTurns.ts` — mechanical rename
- `src/lib/course/adaptQuestionnaire.ts` — `adaptOpenQuestion` helper
- `src/lib/course/shapeBaselineAnswers.ts` → `shapeQuestionnaireAnswers.ts` (rename)
- `src/lib/course/submitBaseline.ts` + `.persist.ts` — back-fills
- `src/lib/scoring/xp.ts` — add `calculateMcXp`
- `src/lib/spaced-repetition/scheduler.ts` — add `getFreshConcepts`, `renderConceptInjection`
- `src/lib/config/tuning.ts` — `WAVE` group + `XP.mcCorrectMultiplier`
- `src/server/routers/index.ts` — mount `wave: waveRouter`
- `src/app/course/[id]/wave/[n]/page.tsx` — replace stub
- `src/components/chat/Onboarding.tsx` — Turn-kind switch updated to new union
- `src/db/queries/{waves,assessments,concepts,context_messages}.ts` — query extensions

**Unchanged:**

- `src/lib/turn/executeTurn.ts` (already stage-agnostic)
- `src/lib/prompts/scoping.ts`, `scopingClose.ts` (already use shared base)
- `src/lib/scoring/{xp,progression,baselineMerge}.ts` (xp gets one addition; others unchanged)
- `src/lib/spaced-repetition/sm2.ts`
- `src/components/chat/{Composer,MessageBubble,ChatShell,ChatHeader,SideMenu,FrameworkTierList}.tsx`

## 14. Rollout order

Migrations and tunables first, then schemas, then lib steps, then router, then UI. Branch implementer follows this order to keep each step independently verifiable.

1. Migration `user_message.kind` + DB query extensions.
2. `tuning.ts` `WAVE` group + `XP.mcCorrectMultiplier`.
3. `obfuscateCorrect.ts` + tests.
4. `closeTurn.ts` schema extensions + tests; submitBaseline back-fills.
5. `waveTurn.ts` + `waveClose.ts` schemas + tests.
6. `teaching.ts` rewrite.
7. `scheduler.ts` extensions + tests.
8. `executeWaveMid` / `executeWaveClose` / `submitWaveTurn` + tests.
9. `getWaveState` + `redactQuestionnaire` + tests.
10. `wave.ts` router + integration tests.
11. Turn union refactor + `deriveTurns` rename + `deriveWaveTurns` + tests.
12. `useWaveState` hook + tests.
13. `WaveSession.tsx` + page.tsx replacement.
14. `Onboarding.tsx` Turn-kind switch update.
15. Live-smoke verification.

## 15. Open questions / future work

- **Tier-advancement banner copy.** Default placeholder: "Promoted to Tier N!". Polish post-MVP.
- **Cross-Wave history exploration.** Out of scope; will need a parent course-level view.
- **Concept dedup tooling.** If concept-name drift becomes a real problem despite `<planned_concepts>` discipline, post-MVP we add a fuzzy-merge admin tool. Until then strict natural-key matching stands.
- **Model swap.** Locked to `llama3.1-8b` until 2026-05-27 sunset; `gpt-oss-120b` is the current floor candidate for the next-model evaluation.
- **Streaming.** Post-MVP. Will require Context-write reshaping; the current append-only design is compatible but unoptimized.
