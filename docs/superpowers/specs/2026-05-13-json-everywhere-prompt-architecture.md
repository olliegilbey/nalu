# JSON-Everywhere Prompt Architecture — Design

**Date:** 2026-05-13
**Status:** Draft (pending user review)
**Scope:** Scoping-phase prompt + parse rewrite, end-to-end. Includes `gradeBaseline` migration to `executeTurn` and the JSONB storage-shape rewrite that falls out of it. Teaching is explicitly out of scope and will follow the same pattern in a later spec.

---

## 1. Goal

Replace the current XML-bracketed prompt + parse contract with a JSON-everywhere contract enforced at decode time. The model emits one JSON object per turn matching a Zod-derived schema; the same schema drives wire-level constrained decoding (Cerebras `response_format: { type: "json_schema", strict: true }`), runtime validation, and — by virtue of the schema's `description` fields being part of what the provider feeds the decoder — the model's own field-level guidance. The user envelope and parser are stage-specific; the system prompt is slim and stage-agnostic.

This is a rewrite of the contract surface only. The DB schema (with JSONB storage-shape updates to match the new wire shapes), `executeTurn`, the `ValidationGateFailure` retry mechanism, the live-smoke observability layer, and the router/lib step structure all stay.

## 2. Why

Empirical and documented failures justify the rewrite, not aesthetic preference:

- **Live smoke shows real failures** under `llama3.1-8b`: the clarify model emits `<clarifying_questions>` instead of `<questions>`; framework `exampleConcepts` arrays come back with fewer than four items. Both are recoverable via retry, but both reveal the same root cause — the model has no guard rail forcing it onto the wire shape.
- **Meta's own model card** for Llama 3.1 8B states the model "cannot reliably maintain conversation alongside tool/structure instructions in the system prompt." Our current system prompt mixes a generous role block with two large per-stage instruction constants (`FRAMEWORK_TURN_INSTRUCTIONS`, `BASELINE_TURN_INSTRUCTIONS`). The 8B is the weakest model Cerebras offers and is therefore our deliberate prompt-quality floor (see memory `feedback_weak_model_means_weak_prompt.md`). The right fix is a slimmer prompt, not a bigger model.
- **Cerebras supports OpenAI-compatible `response_format: { type: "json_schema", strict: true }`** in constrained-decoding mode. Constrained decoding at the token level is strictly stronger than "ask the model nicely and retry on parse failure" — it makes invalid JSON unreachable for the decoder.
- **Drift risk in schema-vs-prompt copy.** Today the JSON shape is described twice: once in Zod (for parse) and once in prose inside the prompt (for the model). Anything that exists in two places drifts. Zod-as-single-source plus `.describe()` annotations collapse this to one definition — the provider tokenises descriptions into the decoder's context.

## 3. Non-goals

- **Teaching-phase migration.** The same pattern will extend to teaching turns, but teaching has its own concerns (Wave boundaries, SM-2 injection, blueprint emission, append-only context) that warrant their own spec. Scoping must work first.
- **llama3.1-8b → successor floor model.** Tracked as project memory `project_llama_8b_deprecation.md` (sunset 2026-05-27). Successor selection is a separate calibration task; this spec is model-agnostic and will work for both the 8B floor and any stronger model.
- **UI implementation.** The wire/data side is in scope. UI rendering of `userMessage` + Questionnaire/Answer cards is a separate frontend task.
- **Streaming.** All turns remain request-response.
- **Claude / non-Cerebras providers.** Claude expresses structured output via tool-use, which breaks plain-text history replay (tool-use messages can't be re-serialised as `role: assistant` text without lossy reconstruction). Deferred — see §6.

**In scope (was previously a non-goal):** `gradeBaseline` migration to `executeTurn`. Stripping it out of `generateStructured` is the only way to avoid two parallel scoping prompt contracts living in the repo simultaneously — exactly the "skeletons that confuse future agents" the user flagged. See §4.9.

## 4. Architecture

### 4.1 Stage-agnostic system prompt (slim)

The scoping system prompt is short: persona + topic interpolation only. The per-stage contract lives entirely in the user envelope (§4.2) and in the per-stage schema's `description` fields (which Cerebras renders into the decoder's context as part of strict-mode `response_format`).

Shape (illustrative — exact wording iterates from smoke-test feedback):

> You are Nalu, an expert teacher and tutor. You are building a bespoke course for a learner on the topic of **`<topic>`**. Each turn, reply with a single JSON object matching the response schema attached to that turn. No prose outside the JSON.

What is in: persona, topic interpolation, the one-line "reply in JSON matching the attached schema" rule. What is out: per-stage instructions (envelope), field-by-field semantics (`.describe()` on the schema), why-structured-output prose (the constraint enforces it; the model doesn't need to be convinced).

This system prompt is emitted exactly once per scoping pass (the existing one-system-message-per-Context rule is preserved). Tuning this prompt is expected; the architecture is what's load-bearing, not the exact wording.

### 4.2 Per-stage user envelopes (bare stage labels)

Each turn's user-role message is built by the harness as a _minimal_ envelope: the stage label and the learner's input. No prose copy of the schema, no field-by-field guide, no stage-specific instructions beyond the label. The schema's own `description` annotations carry all per-field semantics; cross-field invariants live on parent/array `.describe()` (§4.5).

Envelope template:

```xml
<stage>generate baseline</stage>
<learner_input>
[The prose the user typed, or a rendered transcript of their questionnaire answers.]
</learner_input>
```

Per-stage envelope labels:

| Stage               | Envelope label                      | Structured payload field                       |
| ------------------- | ----------------------------------- | ---------------------------------------------- |
| `clarify`           | `<stage>clarify</stage>`            | `questions` (a `Questionnaire` — §4.4)         |
| `generateFramework` | `<stage>generate framework</stage>` | `framework` (existing `frameworkSchema`)       |
| `generateBaseline`  | `<stage>generate baseline</stage>`  | `baseline` (a Questionnaire wrapper — §4.4)    |
| `gradeBaseline`     | `<stage>grade baseline</stage>`     | `gradings` (per-question rubric output — §4.9) |

Envelope assembly + sanitisation lives in `src/lib/prompts/scoping.ts` next to the system-prompt renderer. Learner input is sanitised at the prompt layer exactly as today.

### 4.3 `userMessage` + structured payload, every turn

Every assistant JSON object carries a `userMessage` field. This is the chat-bubble prose shown to the learner — warm, brief framing. It is not a place to enumerate the questions, list tier names, or restate the baseline questions. The structured payload (`questions`, `framework`, `baseline`, `gradings`) carries those.

The fields the model emits fall into **three visibility tiers**, all flowing through the same JSON object:

1. **Chat-visible** — `userMessage`. Rendered verbatim as the assistant's chat bubble. Only this field ever becomes prose the learner reads.
2. **UI-rendered structure** — fields the UI displays as cards/components but not as prose: question `prompt` text, MC `options`, framework `tiers` (names + descriptions), and so on.
3. **Server-only state** — fields the model emits for the harness to consume but the UI never displays: `correct` (the right answer for an MC), `freetextRubric` (grading guidance), `conceptName` and `tier` on a baseline question, free-text grading verdicts on a grade-baseline turn, and — in the forthcoming teaching phase — SM-2 concept-coverage deltas, per-turn concept-assessed lists, blueprint metadata, and similar tracking fields.

Visibility is documented inline in `.describe()` text via `[UI]` / `[server]` / `[chat]` prefixes (§4.4 below). The wire schema does not enforce visibility — that's a UI/harness concern — but the model is told plainly via the description so it doesn't, e.g., echo a `correct` answer inside `userMessage`.

### 4.4 Unified `Questionnaire` and `Question` shape

A single `Question` discriminated union, used by clarify, baseline, and (later) teaching quizzes. A `Questionnaire` is `{ questions: Question[] }` with at least one question. The UI presents questions one at a time; the learner submits the whole questionnaire before the model sees responses.

Each field below is annotated with its visibility tier (§4.3): `[UI]` = UI-rendered to the learner, `[server]` = harness-only state never shown, `[chat]` = chat-bubble prose.

```ts
const questionSchema = z.discriminatedUnion("type", [
  z.object({
    id: z
      .string()
      .describe("[server] Stable identifier so responses can be matched back to questions."),
    type: z.literal("free_text").describe("[server] Question kind discriminator."),
    prompt: z.string().describe("[UI] The question shown to the learner."),
    freetextRubric: z
      .string()
      .describe(
        "[server] How to grade a free-text response. For elicitation (clarify) " +
          "this can be a one-liner like 'no grading — informational'. Never shown to the learner.",
      ),
    // Stage metadata — required for baseline + teaching quizzes; absent for clarify.
    conceptName: z
      .string()
      .optional()
      .describe("[server] Concept this question probes. Required for baseline + teaching quizzes."),
    tier: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "[server] Framework tier this question targets. Required for baseline + teaching quizzes.",
      ),
  }),
  z.object({
    id: z.string().describe("[server] Stable identifier."),
    type: z.literal("multiple_choice").describe("[server] Question kind discriminator."),
    prompt: z.string().describe("[UI] The question shown to the learner."),
    options: z
      .object({
        A: z.string(),
        B: z.string(),
        C: z.string(),
        D: z.string(),
      })
      .describe(
        "[UI] Four keyed options shown to the learner. Learner can also bypass " +
          "via the free-text escape rendered alongside the buttons.",
      ),
    correct: z
      .enum(["A", "B", "C", "D"])
      .optional()
      .describe(
        "[server] Correct option key. NEVER shown to the learner. " +
          "PRESENT for graded questions (baseline, quiz) so the client can score MC immediately " +
          "without a round-trip; ABSENT for elicitation (clarify) where there is no right answer.",
      ),
    freetextRubric: z
      .string()
      .describe("[server] How to grade if the learner uses the free-text escape. Never shown."),
    conceptName: z.string().optional().describe("[server] Concept probed."),
    tier: z.number().int().positive().optional().describe("[server] Framework tier targeted."),
  }),
]);

const questionnaireSchema = z.object({
  questions: z
    .array(questionSchema)
    .describe(
      "One or more questions. UI shows them one at a time; the learner submits " +
        "the whole questionnaire before the model sees responses. " +
        "Clarify: 2–4 questions; baseline: count is determined by scope tiers.",
    ),
});
```

Cross-field invariants (count bounds, tier-scope, exclusive-or on responses) are documented in array/parent `.describe()` text and enforced post-decode by Zod `.refine` / `.superRefine` — Cerebras strict mode disallows `minItems`/`maxItems` so these never reach the wire schema, but Zod still gates them and the refine `.message` flows into the retry directive (§4.7).

Stage rules (enforced at parse time via `.refine`/`.superRefine` on the per-stage schema, not on the shared `questionSchema`):

- **Clarify:** all questions can be either type. `conceptName`, `tier`, and `correct` are absent. 2–4 questions.
- **Baseline:** every question has `conceptName` and `tier`; every MC has `correct`. Tier-scope invariants stay where they are today (in the per-stage parser).
- **Teaching quiz (future):** same shape as baseline.

Matching `Response` shape, used identically across stages:

```ts
const responseSchema = z
  .object({
    questionId: z.string(),
    choice: z.enum(["A", "B", "C", "D"]).optional(),
    freetext: z.string().optional(),
  })
  .describe("Exactly one of `choice` | `freetext` set."); // enforced by superRefine.

const responsesSchema = z.object({ responses: z.array(responseSchema) });
```

Naming note: "responses" is the learner's reply to a question. "answers" in MC nomenclature refers to the four options the model emits (which we call `options`). This rename is part of the JSONB storage rewrite (§4.8).

### 4.5 Schema as single source of truth

One Zod schema per stage, defined once in `src/lib/prompts/`. From this Zod source we derive:

1. **Wire schema** — JSON Schema for `response_format: { type: "json_schema", strict: true }`. Produced via `z.toJSONSchema()` (Zod v4 native, no plugin). Stripped of keywords Cerebras strict mode rejects (§4.6).
2. **Runtime validator** — the Zod schema itself, used by the harness post-decode inside `executeTurn` (see §4.7).
3. **Model-facing field guide** — _not a separate construct._ `.describe()` annotations survive `z.toJSONSchema()` as JSON Schema `description` fields, which Cerebras tokenises into the decoder's context as part of strict-mode `response_format`. The model reads the descriptions as schema metadata, not as data to populate. No `renderSchemaBlock` helper, no field-by-field prose injection into the envelope.

This is the simplification the brainstorming converged on: every per-field hint and every cross-field invariant lives on `.describe()`, the schema is the only artefact the model needs, and there is no second prose copy to drift.

### 4.6 Cerebras `response_format` constraints — explicit handling

Cerebras's strict JSON-schema mode has documented limits:

- Total schema ≤ 5000 characters
- Depth ≤ 10
- **No `minItems` / `maxItems`** on arrays
- **No `pattern` (regex)** on strings
- **No `minLength` / `maxLength`** on strings
- **No `minimum` / `maximum`** on numbers
- **No `format`** keyword
- **No `$ref` / recursion**
- **`anyOf`** supported but limited; `oneOf` is the safer encoding for discriminated unions (Zod v4 `discriminatedUnion` → `oneOf` natively)
- **Optional fields are allowed** (more permissive than OpenAI's strict mode, which requires every property in `required`) — the wire schema can use `optional()` on `conceptName`/`tier`/`correct` without manual rewriting

**Enforcement deadline:** Cerebras moves from soft-validation to hard rejection of non-compliant schemas on **2026-07-21**. After that date, any prohibited keyword in the wire schema returns a 4xx — no quiet acceptance. This spec must be in production well before then.

The current Zod schemas use `.min(2).max(4)` on arrays, `.regex(/^b\d+$/)` on baseline ids, `.min(1)` on strings, and `.int().positive()` on tiers. Sending these to Cerebras strict mode unmodified will be rejected.

Resolution: a thin `toCerebrasJsonSchema(zodSchema)` helper produces the wire form by:

1. `z.toJSONSchema(zodSchema)` — convert.
2. Walk the result and drop the rejected keywords (`minItems`, `maxItems`, `pattern`, `minLength`, `maxLength`, `minimum`, `maximum`, `format`, `$ref`).
3. Assert size ≤ 5000 chars + depth ≤ 10 (throw at build time if exceeded — not a runtime concern).
4. Return the trimmed schema.

The **dropped constraints are still enforced** — by the Zod parse that runs after the model returns. This is the layer that already throws `ValidationGateFailure` and triggers retries. The wire schema guarantees JSON shape; Zod enforces business invariants.

A unit test asserts that for every stage schema, `toCerebrasJsonSchema` output contains none of the forbidden keywords and respects the size/depth budget.

### 4.7 Retry mechanism — simplified

`executeTurn` keeps its `ValidationGateFailure` retry loop. The harness now does the validation itself: the caller passes `responseSchema: ZodSchema` into `executeTurn`, the harness JSON-parses the raw text and Zod-parses against the schema, and on failure throws `ValidationGateFailure` with a directive. The per-stage `parser` arg goes away — every stage's parse is `JSON.parse → schema.parse → cast`.

Retry directives are now generic by default, with `.refine` `.message` text passing through for business-invariant failures:

- **Shape failure** (the model returned malformed JSON or missed a required field — rare under strict mode but possible if the provider returns text outside the JSON envelope): generic directive — _"Your previous response did not match the required schema. Reply with a single JSON object matching the schema for this turn."_
- **Business-invariant failure** (`.refine` / `.superRefine` rejected the shape — e.g. baseline question tier 5 outside scope tiers [1,2], or clarify questionnaire had 5 items): the `.message` from the failing refine is the directive verbatim. Refine messages name the offending field path and the violated rule.

No bespoke per-stage retry directives, no parser-level error mapping, no diagnostic-heuristic library beyond what `diagnoseFailure.ts` does for live-smoke observability.

The live-smoke observability layer (`formatTurn.ts` + `diagnoseFailure.ts`) is unchanged in role. `diagnoseFailure` heuristics are updated to recognise JSON-only failure modes (e.g. "userMessage missing", "wrong stage payload field present") rather than XML wrapping-tag mismatches.

### 4.8 JSONB storage-shape rewrite

The current `clarificationJsonbSchema` and `baselineJsonbSchema` in `src/lib/types/jsonb.ts` are out of sync with the new wire shapes — they use old field names (`text` instead of `prompt`, `single_select` instead of `multiple_choice`, `answers` instead of `responses`) and loose typing (`z.unknown()[]`). They get rewritten in this change.

Pattern: **one JSONB column per stage; each column stores a wrapper around the wire-shape question payload plus typed learner responses (and, for baseline, gradings).** No translator helpers (`toBaselineJsonb`, `toClarificationJsonb`, etc.) — the wire shape is the storage shape, modulo the response-collection wrapper.

```ts
// clarificationJsonbSchema
z.object({
  questions: z.array(questionSchema), // wire shape, see §4.4
  responses: z.array(responseSchema), // populated after the learner submits
});

// frameworkJsonbSchema — unchanged in spirit; tightened types where currently z.unknown
z.object({
  tiers: z.array(tierSchema),
  estimatedStartingTier: z.number().int().positive(),
  baselineScopeTiers: z.array(z.number().int().positive()),
});

// baselineJsonbSchema
z.object({
  questions: z.array(questionSchema), // wire shape
  responses: z.array(responseSchema), // learner's reply
  gradings: z.array(gradingSchema), // per-question rubric output from gradeBaseline
});
```

Field renames across the codebase:

| Old                             | New               |
| ------------------------------- | ----------------- |
| `text` (question body)          | `prompt`          |
| `single_select` (question type) | `multiple_choice` |
| `answers` (learner input)       | `responses`       |
| `answers` (MC option list)      | `options`         |

`z.unknown()[]` on `baselineJsonbSchema.questions` and `.answers` is replaced by the precise schemas above. Translator helpers (`toBaselineJsonb`, etc.) are deleted; lib steps write the wire-shape payload directly with `responses: []` / `gradings: []` initialisation.

**Migration:** the app is pre-launch and `scoping_passes` carries no production data. On deploy, truncate all in-flight rows in `scoping_passes` and `context_messages`, plus reset `courses.clarification` / `.framework` / `.baseline` to `NULL`. A migration script under `src/db/migrations/` performs the truncate. No back-compat shim, no dual-read.

### 4.9 `gradeBaseline` migration to `executeTurn`

`gradeBaseline` currently uses the legacy `generateStructured` path (the old XML-wrapped extraction model), which means scoping has two parallel prompt-contract worlds — XML for grading, JSON-everywhere for everything else. This migration retires the legacy path entirely.

Changes:

- `gradeBaseline.ts` reshapes to mirror `generateBaseline.ts`: fetch course → preconditions → idempotency check → open pass → `executeTurn` with the grade-baseline `responseSchema` → persist `gradings` into `courses.baseline.gradings` → return typed payload.
- New `gradeBaselineSchema` in `src/lib/prompts/baseline.ts` (or a sibling `baselineGrading.ts`): `{ userMessage: string, gradings: Array<{ questionId, verdict, conceptDelta }> }` with `verdict` ∈ `correct | partial | incorrect` and `conceptDelta` the SM-2 input. The shape is locked here at architecture-level; field-level tuning happens in the implementation plan.
- `buildBaselineEvaluationPrompt` (`src/lib/prompts/baselineEvaluation.ts`) and the corresponding `buildClarificationPrompt` / `buildFrameworkPrompt` / `buildBaselinePrompt` builders **are deleted**. They exist today only because `gradeBaseline` reconstructed the scoping history via the legacy XML builder. Once `gradeBaseline` rides on `executeTurn` and re-uses `renderContext` like every other stage, the builders have no callers.
- `generateStructured` (the legacy XML extraction call site in `src/lib/llm/`) loses its only caller. Delete it.
- All-MC shortcut (the `ZERO_USAGE` early return path that skipped the LLM when every baseline question was MC) is preserved but reshaped to write `gradings` derived from the stored `correct` keys without calling the LLM. This was the right optimisation; the migration just relocates it to the same lib-step pattern.

This is the "strip the relics so future agents aren't confused by skeletons" the user flagged during brainstorming.

## 5. File-level impact (sketch)

| File                                                                              | Change                                                                                                                                                                                                                                          |
| --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/prompts/scoping.ts`                                                      | System prompt trimmed to persona + topic + one-line JSON rule. Per-stage instruction constants (`FRAMEWORK_TURN_INSTRUCTIONS`, `BASELINE_TURN_INSTRUCTIONS`) deleted. Envelope assembly (`renderStageEnvelope({ stage, learnerInput })`) added. |
| `src/lib/prompts/{clarify,framework,baseline}.ts`                                 | Per-stage Zod schemas with `.describe()` on every field. Cross-field invariants on parent/array `.describe()` + `.refine`/`.superRefine`.                                                                                                       |
| `src/lib/prompts/questionnaire.ts`                                                | New file. `questionSchema`, `questionnaireSchema`, `responseSchema`. Used by clarify + baseline (+ later quizzes).                                                                                                                              |
| `src/lib/prompts/baselineEvaluation.ts`                                           | **Deleted.** Caller (`gradeBaseline`) migrates to `executeTurn` + `renderContext`.                                                                                                                                                              |
| `src/lib/prompts/clarification.ts` + legacy `build*Prompt` builders               | **Deleted.** No remaining callers after `gradeBaseline` migration.                                                                                                                                                                              |
| `src/lib/llm/toCerebrasJsonSchema.ts`                                             | New file. `z.toJSONSchema` → strip strict-mode-rejected keywords → assert size/depth budget.                                                                                                                                                    |
| `src/lib/llm/generate.ts`                                                         | Accept `responseSchema` param; pass through to provider as `providerOptions.cerebras.response_format: { type: "json_schema", strict: true, json_schema: { schema: toCerebrasJsonSchema(...) } }`.                                               |
| `src/lib/llm/generateStructured.ts`                                               | **Deleted** (legacy XML extraction; only caller was `gradeBaseline`).                                                                                                                                                                           |
| `src/lib/course/parsers.ts`                                                       | **Deleted.** Validation moves into `executeTurn`: `JSON.parse(raw) → schema.parse(parsed)`. Refine messages drive retry directives.                                                                                                             |
| `src/lib/course/{clarify,generateFramework,generateBaseline,gradeBaseline}.ts`    | Pass `responseSchema` into `executeTurn`. Translator helpers (`to*Jsonb`) deleted — write wire-shape directly. `gradeBaseline` reshaped to the standard lib-step pattern (see §4.9).                                                            |
| `src/lib/turn/executeTurn.ts`                                                     | Accept `responseSchema: ZodSchema` instead of `parser`. Harness does `JSON.parse → schema.parse` and throws `ValidationGateFailure` with generic-or-refine-message directive on failure.                                                        |
| `src/lib/turn/diagnoseFailure.ts`                                                 | Heuristics updated for JSON-only failures (`userMessage` missing, wrong stage payload field present, etc.). XML/tag heuristics removed.                                                                                                         |
| `src/lib/types/jsonb.ts`                                                          | `clarificationJsonbSchema`, `frameworkJsonbSchema`, `baselineJsonbSchema` rewritten per §4.8. Tighten `z.unknown()[]` → precise schemas. Field renames (`text`→`prompt`, `single_select`→`multiple_choice`, `answers`→`responses`/`options`).   |
| `src/db/queries/courses.ts`                                                       | Validation against new JSONB schemas. No SQL changes (JSONB is opaque to Postgres); only the in-app validators move.                                                                                                                            |
| `src/db/migrations/<timestamp>_jsonb_rewrite.sql`                                 | New file. Truncate `scoping_passes` + `context_messages`; reset `courses.clarification` / `.framework` / `.baseline` to NULL. Pre-launch — no data preservation.                                                                                |
| `docs/UBIQUITOUS_LANGUAGE.md`                                                     | Add: Learner input, User envelope, Per-stage schema, Questionnaire, Question, Response (learner input). Rename: Card answer → Card response.                                                                                                    |
| `src/lib/turn/CLAUDE.md`, `src/lib/course/CLAUDE.md`, `src/lib/prompts/CLAUDE.md` | Update to match new contract; remove references to deleted modules.                                                                                                                                                                             |

DB schema (column types) is untouched. `context_messages` row content changes from "XML-wrapped + JSON tags" to "JSON object as text" — both fit `text`/`jsonb`.

## 6. Open questions and deferrals (none blocking)

- **System-prompt wording.** §4.1 gives a _shape_, not final copy. The first version goes in based on the principles here; the smoke harness (`just smoke`) is the iteration loop. Bad responses → adjust system-prompt framing or per-field `.describe()` text → re-smoke. Treat the wording as a tuning surface, not a contract.
- **Claude / non-Cerebras providers.** Claude expresses structured output through tool-use, which produces `tool_use` / `tool_result` message blocks that can't be losslessly serialised back to plain `assistant: <text>` for context replay. Migration would require either a separate context-rendering path for Claude or an architectural pivot to message-block storage. Deferred — Cerebras is the only provider we ship against today, and the wire-format adapter (§4.6's `toCerebrasJsonSchema`) is provider-scoped on purpose.
- **AI SDK deeper integration.** Vercel AI SDK is request/response — it does not manage conversation state, so `renderContext` + `context_messages` stay. There may be value in adopting more of its primitives (typed streaming, etc.) later; explicitly out of scope for this rewrite. We continue calling `generateText` with `providerOptions.cerebras.response_format` set per turn.
- **MVP pruning of context_messages.** No additional pruning beyond the existing "drop failed retries + their directives on successful turn" behaviour in `renderContext`. The next major decision (when to prune for long sessions) is teaching-phase concern and stays deferred.
- **Strict-mode size budget.** Stage schemas after stripping are well under 5000 chars (baseline is the largest at ~1500 today, will rise modestly with `.describe()` text but well within budget). `toCerebrasJsonSchema` asserts the limit so a regression fails at build time, not at runtime.
- **`Response` schema location.** Lives next to `questionSchema` in `questionnaire.ts`. If/when teaching introduces a different response shape we revisit. YAGNI.
- **Teaching's additional server-only fields.** Out of scope here, but worth flagging: teaching turns will extend the `[server]` tier with SM-2 concept-coverage deltas, per-turn concept-assessed lists, and blueprint metadata on Wave-final turns. The visibility-tier pattern (§4.3) and Questionnaire/Question shape carry forward unchanged; the teaching-turn output schema is a new sibling, not a rework.

## 7. Ubiquitous Language additions

Inline previews — full entries added to `docs/UBIQUITOUS_LANGUAGE.md` in the same change.

- **Learner input** — Either the prose the User types into the chat input and submits as a message, or the collection of Responses to a Questionnaire submitted via the answer card UI. In both cases the Harness receives it server-side, persists it, and wrangles it into the next User envelope sent to the LLM. It is _what the User said_ before any prompt assembly.
- **User envelope** — The harness-built `role: user` message sent to the LLM each turn. Wraps the Learner input together with a bare `<stage>...</stage>` label. The model only ever sees envelopes; raw Learner input never reaches it unwrapped.
- **Per-stage schema** — The Zod schema describing the LLM's expected output for one scoping stage (clarify, framework, baseline, grade-baseline). Single source of truth: produces the wire schema (Cerebras `response_format`), the runtime validator, and — via `.describe()` annotations rendered into the decoder's context — the model's own field-level guidance.
- **Questionnaire** — A `{ questions: Question[] }` payload with at least one question. Used identically across clarify, baseline, and teaching quizzes. The UI renders questions one at a time as an answer card.
- **Question** — One of two shapes: `free_text` (with a grading rubric) or `multiple_choice` (with four keyed options A/B/C/D, a free-text escape, and a `correct` key when graded). Stage-specific metadata (`conceptName`, `tier`, `correct`) is optional at the schema level and required by the per-stage refine where applicable.
- **Response** — The learner's reply to one Question: either a `choice` (MC option key) or a `freetext` body, never both. Distinct from MC `options`, which are the four candidate answers the model emits as part of the Question.

## 8. Self-review

- **Placeholder scan:** no TBDs; every file in §5 has a concrete change description. §4.1 system-prompt copy is illustrative — flagged as such in §6 as a tuning surface, not a placeholder.
- **Internal consistency:** §4.4 question shape matches §7 description matches §4.8 storage shape. Strict-mode constraints in §4.6 cross-referenced from §4.5. Visibility tiers in §4.3 cross-referenced from §4.4 (field annotations). `gradeBaseline` migration in §4.9 lines up with §3 non-goals (removed) and §5 file list (deletions).
- **Scope check:** scoping end-to-end (clarify → framework → baseline → grade-baseline). Teaching, llama-successor migration, Claude/AI-SDK deeper integration, post-MVP context pruning explicitly deferred in §3/§6.
- **Drift surface:** `.describe()` is the only model-facing field copy. No `renderSchemaBlock`, no envelope field guides, no per-stage retry-directive constants. The schema is the contract.
- **Deletion list explicit:** `parsers.ts`, `generateStructured.ts`, `baselineEvaluation.ts`, `clarification.ts`, the legacy `build*Prompt` builders, all `to*Jsonb` translator helpers, per-stage `FRAMEWORK_TURN_INSTRUCTIONS` / `BASELINE_TURN_INSTRUCTIONS`. "No skeletons" is enforced by the §5 table.
- **Hard deadline acknowledged:** Cerebras strict-mode hard enforcement begins 2026-07-21 (§4.6). This spec must be in production before then.
