# Ubiquitous Language

Glossary of terms used across Nalu. Update this doc before renaming any of these concepts — the vocabulary is load-bearing.

---

## Agent

An LLM wrapped in a loop that appends messages each turn. The loop: send messages → receive response → if the response requests tools, execute them and append results → repeat until the model stops calling tools. Per [ampcode.com/notes/how-to-build-an-agent](https://ampcode.com/notes/how-to-build-an-agent), the whole thing is "an LLM, a loop, and enough tokens" — ~300-400 lines of real code. Complexity should emerge from engineering polish, not architecture or docs.

Nalu is a **heuristically structured** variant of this pattern. The outer loop is distributed across HTTP turns; the DB is the agent's memory. Mid-Wave turns also run a bounded inner tool loop: a `ToolLoopAgent` from `src/lib/agents/`, capped at `LLM.maxToolSteps`. On each turn the Harness injects signals the model didn't ask for — the turn countdown within the current Wave, and on the final turn of a Wave the concepts due for review and the fresh concepts for the next Wave, plus a response schema that requires the next Wave's blueprint. The LLM stays stateless; the Harness loads the Context from DB, appends injections plus the user's message, and sends. That injection layer is what makes Nalu a harness and not a passthrough.

## Blueprint

The `{topic, outline, openingText, plannedConcepts}` payload the LLM emits as the `nextUnitBlueprint` field of a close turn's JSON response (`blueprintSchema` in `src/lib/prompts/closeTurn.ts`). Both the scoping close and each Wave close emit one. A Wave close persists it on `waves.blueprint_emitted` and seeds the next Wave with it (on `waves.seed_source` as `{kind: "prior_blueprint", priorWaveId, blueprint}`). The scoping close seeds Wave 1 the same way, as `{kind: "scoping_handoff", blueprint}`.

## Card answer

What the User submits when the assessment-card UI replaces the chat input. A turn carries either a card answer or a chat message, never both. In a Wave, the Harness stores it as a `{role: "user", kind: "answers"}` entry in `waves.chat_log`. In `context_messages` it is a `user_message` row whose envelope carries `<questionnaire_answers>`. The server grades MC answers mechanically. The model grades free-text answers in the same turn: mid-Wave through the `recordComprehensionSignals` tool, and at the close turn in the `gradings` field. A typed answer to an MC question is free text; its envelope carries the options and the correct key, so the model grades it against the correct option. The schema CHECK still allows a `card_answer` row kind, but nothing writes it.

## Cumulative summary

The text on `courses.summary`. The scoping close turn writes the first one, from its `summary` field. Each Wave close rewrites it whole from its own `summary` field: the model compresses the prior summary and folds in the lesson. Every Wave's system prompt renders it as `<progress_summary>`. A Wave close also keeps the same text on `waves.summary`, a per-Wave snapshot that no code reads back.

## Baseline

The 7-9 assessment questions generated after the framework is confirmed. Mix of multiple choice (graded mechanically by `submitBaseline`, no LLM) and free-text (graded by a single batched LLM call inside `submitBaseline`). Its per-tier results set the learner's starting tier: `determineStartingTier` in `src/lib/scoring/startingTier.ts`, with the threshold `BASELINE.tierMasteryRatio`. The model grades answers; it never picks the tier.

## Concept

A discrete unit of knowledge the learner is tracked on. Concepts are created during baseline grading and during teaching sessions as the LLM identifies them. SM-2 schedules them for review. XP is awarded per graded answer, and each graded question names one concept.

## Context

The conversation state sent to the LLM on each turn — the entire message list treated as one append-only prefix. The LLM is stateless, so the Context is the only state it has access to. The Harness loads the current Context from DB and sends it as-is each turn; it does **not** regenerate the prompt from components per turn. The one exception is the system prompt. It is never stored. A pure renderer rebuilds it on every call from the phase's seed columns, so its bytes stay identical within a phase. A new phase gets a new system prompt. `docs/ARCHITECTURE.md` explains why.

Nalu has distinct phases, each with its own Context:

- **Scoping context** — one Context for the entire scoping phase (clarify → framework → baseline → grade). `renderScopingSystem` renders its system prompt; each scoping stage appends user/assistant messages to the growing prefix.
- **Wave context** — a fresh Context per Wave. `renderTeachingSystem` renders its system prompt from the Wave row: framework snapshot, tier, due-concepts snapshot, and the seeding _blueprint_ (`waves.seed_source`). It also renders the course summary. Wave 1's blueprint comes from the scoping close turn. Each later Wave's blueprint comes from the previous Wave's final turn.

Within a phase the prefix is byte-stable (keeps prompt cache warm). At phase boundaries the closing Context stays in the DB but never replays into future prompts. The DB stores Contexts as a row-per-message table; no prompt-from-components reassembly happens per turn.

## Learner input

Either the prose the User types into the chat input and submits as a message, or the collection of Responses to a Questionnaire submitted via the answer card UI. In both cases the Harness receives it server-side, persists it, and wrangles it into the next User envelope sent to the LLM. It is _what the User said_ before any prompt assembly.

## User envelope

The harness-built `role: user` message sent to the LLM each turn. Wraps the Learner input together with a bare `<stage>...</stage>` label and any Harness injections. The model only ever sees envelopes; raw Learner input never reaches it unwrapped.

## Per-stage schema

The Zod schema describing the LLM's expected output for one scoping stage (clarify, framework, baseline, scoping close). Single source of truth: produces the wire schema (Cerebras `response_format`), the runtime validator, and — via `.describe()` annotations rendered into the decoder's context — the model's own field-level guidance.

## Questionnaire

A `{ questions: Question[] }` payload with at least one question. Used identically across clarify, baseline, and teaching quizzes. The UI renders questions one at a time as an answer card.

## Question

One of two shapes: `free_text` (with a grading rubric) or `multiple_choice` (with four keyed options A/B/C/D, a free-text escape, and a `correct` key when graded). Stage-specific metadata (`conceptName`, `tier`, `correct`) is optional at the schema level and required by the per-stage refine where applicable.

## Response

The learner's reply to one Question: either a `choice` (MC option key) or a `freetext` body, never both. Distinct from MC `options`, which are the four candidate answers the model emits as part of the Question.

## Harness injection

Context content authored by the Harness (not the User, not the LLM). Turn-level injections ride inside the `user_message` envelope: `<turns_remaining>` on every Wave turn, and `<concepts_for_next_wave>` on a Wave's final turn. The scoping close's stage envelope ends with `<placement_rule>`: how the Harness places the learner, so the model pitches Wave 1 at that tier. The one Harness-authored row kind written is `harness_retry_directive`, after a failed attempt; new rows wrap it in `<harness_feedback>`. The schema CHECK still allows `harness_turn_counter` and `harness_review_block` row kinds, but nothing writes them. Content is wrapped in an XML tag, so the model reads it the same way it reads any other turn (P4: harness injections are visible in the Context, not hidden side-channel state).

## LLM-facing terminology

User-facing copy, code, DB columns, and internal docs all say **Wave**. LLM prompts say **lesson** — the model has strong "lesson" priors and zero training-data signal for "Wave." Prompt prose lives in `src/lib/prompts/` and says "lesson". Some machine labels the model reads still say "wave": `<stage>close wave</stage>`, the `<concepts_for_next_wave>` block (`src/lib/spaced-repetition/scheduler.ts`), and the close turn's wire schema name `wave_close`.

## Framework

The 3-8 proficiency tiers the LLM generates for a course after clarification. Each tier has a name, description, and example concepts. The PRD scopes learner editing; it is unbuilt.

## Harness

This repo. The system that wraps the LLM with deterministic logic (XP, SM-2 scheduling, tier advancement), persistence, auth, and UI. The LLM is a tool in the harness, not the harness itself. The harness is responsible for everything the LLM cannot be trusted with — scoring, progression, anti-gaming.

## LLM

The stateless text model, served by Cerebras through an OpenAI-compatible API. The `LLM_MODEL` env var selects it; the `justfile` notes the current default. Stateless: it holds no memory between HTTP calls. Each turn, the Harness loads the current Context from DB and sends it as-is — no regeneration from components. Only the system prompt is re-rendered per call, byte-identical within a phase (see **Context**). LLM calls go through `src/lib/llm/`: `provider.ts` builds the model, and `generate.ts` makes structured calls. Tool-loop turns run agents from `src/lib/agents/`.

## Router

`src/server/routers/`. Transport layer only — tRPC procedure dispatch, input Zod validation, and auth. Wave turns stream over a second transport, the route handler under `src/app/api/course/`. Calls one `src/lib/course/` function per turn and returns its result. That function owns the heuristics (turn-count decisions, wrap-up triggers, prompt shaping) and the persistence.

## Scoping

The first set of turns when a User starts a new course: clarify → framework → baseline → grade. One append-only conversation — `renderScopingSystem` renders one system prompt for the whole pass; each stage appends user/assistant messages onto the growing, byte-stable prefix (keeps the prompt cache warm, so extra round trips are cheap). Scoping rows stay in the DB once scoping completes, but they never replay into teaching.

## Scoping pass

One row in `scoping_passes`, opened by the first scoping call (`ensureOpenScopingPass`). Parents all scoping `context_messages` rows (clarification turns, framework turns, baseline turns). The structured outputs live on `courses.{clarification, framework, baseline}`, not on the pass. Teaching reads only those outputs; the scoping message history never reaches a Wave prompt (P-ON-05). The rows are kept, not deleted. The scoping-close transaction (`persistScopingClose`) closes the pass and stamps `closed_at`.

## Seed source

The discriminated-union JSONB on `waves.seed_source`. Either `{kind: "scoping_handoff", blueprint}` (Wave 1 — seeded from the blueprint the scoping close turn emits) or `{kind: "prior_blueprint", priorWaveId, blueprint}` (Wave N>1 — seeded from the prior Wave's emitted blueprint). Read by `renderTeachingSystem` to render the `<lesson_seed>` and `<planned_concepts>` blocks.

## Step

One LLM API call, the AI SDK's unit. A Turn spans one or more Steps: a tool loop runs up to `LLM.maxToolSteps`. A structured-turn retry adds one Step; a tool-turn retry reruns the whole loop. See the disambiguation under **Turn**.

The per-turn code that wraps those calls lives in `src/lib/course/`. Each LLM-backed function there loads DB state, applies this turn's heuristics, runs the turn through `src/lib/turn/`, and persists the result. Deterministic algorithms (XP, SM-2 math, tier advancement) live in pure modules in `src/lib/scoring/` and `src/lib/spaced-repetition/`.

## Teaching session

All turns after scoping. A teaching session is a sequence of Waves. The scoping Context is dead by this point; the first Wave's system prompt is built fresh from DB state (topic, framework, starting tier, course summary, and the blueprint from the scoping close turn). Each subsequent Wave opens its own Context with its own fresh system prompt built from the blueprint crafted at the previous Wave's close.

## Tier

One rung of a course's framework. Users advance a tier when enough current-tier concepts show mastery: `checkTierAdvancement` in `src/lib/scoring/progression.ts`, with thresholds in `PROGRESSION`. XP plays no part. The check runs at Wave close, gated by `WAVE.tierCheckInterval`. Deterministic code decides advancement; the model only supplies the quality scores it reads.

## Turn

One ping-pong: User → Router → LLM → Router → User. Each turn is a single HTTP call the User triggers, resolved by one or more Steps (tool loops and validation retries add Steps — see the disambiguation below). Within a Wave, turns append messages to the growing Context; the Harness also appends `<turns_remaining>N</turns_remaining>` each turn so the LLM can pace its teaching and close within the Wave's turn budget (`WAVE.turnCount` in `src/lib/config/tuning.ts`). On the final turn the Harness additionally appends `<concepts_for_next_wave>…</concepts_for_next_wave>` and requires the next Wave's blueprint (topic, outline, opening text, planned concepts) in its structured response.

**Disambiguation — Turn vs Step vs ChatEntry.** This definition deliberately diverges from dialogue-systems literature, where a "turn" is ONE speaker's contribution. In Nalu:

- **Turn** — the full exchange above (what the literature would call a round). `turn_index`, `turns_remaining`, `WAVE.turnCount`, `executeTurn` all count in this unit.
- **Step** — one LLM API call inside a turn (the AI SDK's unit: the tool loop runs up to `LLM.maxToolSteps` steps per turn; a retry reruns the call or the loop). A turn spans 1..N steps.
- **ChatEntry** (`src/lib/types/chatEntry.ts`) — one rendered message in the chat scroll, i.e. one speaker's contribution (the literature's "turn"). One Turn typically yields two ChatEntries.

Never use "turn" for a single contribution or a single API call — say ChatEntry or Step.

## User

The learner. Distinct from the developer, admin, or agent. When docs say "the user," they mean the learner interacting with the UI unless context says otherwise. There is no sign-up. In production, the learner's first API request mints a Supabase anonymous user (`src/server/requestUser.ts`); page loads never do. Outside production, the `x-dev-user-id` header stands in (`src/server/requestUser.ts`).

## Wave

A single ~5-7 minute teaching unit within a Teaching session — Nalu's equivalent of a Duolingo lesson. Each Wave is one Context (one append-only LLM conversation with a byte-stable prefix).

**Fixed turn count.** A Wave runs for `WAVE.turnCount` turns (default 10, in `src/lib/config/tuning.ts`). Pacing is not LLM-decided — the Harness enforces it. On every turn the Harness appends `<turns_remaining>N</turns_remaining>` so the LLM knows where it is in the Wave and can pace toward the close. This gives Waves a consistent shape across a course.

**Final turn does double duty.** On the last turn (`turns_remaining == 0`), the Harness additionally injects `<concepts_for_next_wave>…</concepts_for_next_wave>`. It lists the fresh concepts at the current tier and the SM-2 concepts now due. The model answers with one JSON response (`makeWaveCloseSchema`, no tools). It carries the closing message, the whole-course summary as of this close (see **Cumulative summary**), gradings for any answers submitted this turn, per-concept SM-2 scores, **and** the next Wave's _blueprint_: topic, outline, opening user-facing text, and planned concepts. The close transaction (`persistWaveClose`) opens the next Wave seeded with that blueprint and writes its opening text as turn 0. Pre-generating the opening text means the User returns to something to respond to, not a blank chat.

**Terminology split.** Internally (code, DB, docs, UI) the term is **Wave**. In LLM-facing prompt text the term is **lesson** — the model has strong priors around "lesson" and no pre-existing understanding of "Wave" in this domain. Structured JSON field names in the LLM's output can use either. See **LLM-facing terminology** for where the split lives.

The wave motif persists as design language (Hokusai palette). Tiers of the framework (e.g. "Tier 2: Borrowing Basics") are **not** Waves — they are tiers of the proficiency framework.
