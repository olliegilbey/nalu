# Ubiquitous Language

Glossary of terms used across Nalu. Update this doc before renaming any of these concepts — the vocabulary is load-bearing.

---

## Agent

An LLM wrapped in a loop that appends messages each turn. The loop: send messages → receive response → if the response requests tools, execute them and append results → repeat until the model stops calling tools. Per [ampcode.com/notes/how-to-build-an-agent](https://ampcode.com/notes/how-to-build-an-agent), the whole thing is "an LLM, a loop, and enough tokens" — ~300-400 lines of real code. Complexity should emerge from engineering polish, not architecture or docs.

Nalu is a **heuristically structured** variant of this pattern. The loop exists but is distributed across HTTP turns; the DB is the agent's memory. On each turn the Harness injects signals the model didn't ask for — the turn countdown within the current Wave, and on the final turn of a Wave the SM-2 concepts due for review plus an instruction to draft the next Wave's blueprint. The LLM stays stateless; the Harness loads the Context from DB, appends injections plus the user's message, and sends. That injection layer is what makes Nalu a harness and not a passthrough.

## Blueprint

The `{topic, outline, openingText}` payload the LLM emits inside `<next_lesson_blueprint>` on a Wave's final turn. Persisted on `waves.blueprint_emitted` and consumed as the seed for the next Wave (where it lands on `waves.seed_source` as `{kind: "prior_blueprint", priorWaveId, blueprint}`).

## Card answer

A `context_messages` row of kind `card_answer` — what the User submits when the chat input is replaced by the assessment-card UI. Mutually exclusive with `user_message` for a given turn (the chat input becomes the card; the model grades free-text via `<comprehension_signal>` on the next turn after server-side mechanical MC pre-grading).

## Cumulative summary

The text on `courses.summary`. Rewritten end-to-end on every Wave close via the model's `<course_summary_update>` block — never appended. Capped at ≤150 words by the prompt contract; the model is responsible for compressing earlier-Wave material as the course grows.

## Baseline

The 7-9 assessment questions generated after the framework is confirmed. Mix of multiple choice (graded mechanically by the Router) and free-text (graded by a single batched LLM call inside `submitBaseline`). Determines the learner's starting tier.

## Concept

A discrete unit of knowledge the learner is tracked on. Concepts are created during baseline grading and during teaching sessions as the LLM identifies them. SM-2 schedules them for review; XP is awarded per concept.

## Context

The conversation state sent to the LLM on each turn — the entire message list treated as one append-only prefix. The LLM is stateless, so the Context is the only state it has access to. The Harness loads the current Context from DB and sends it as-is each turn; it does **not** regenerate the prompt from components per turn. Regeneration only happens at phase boundaries, where a new system prompt is crystallised from DB state and becomes message #0 of the new Context.

Nalu has distinct phases, each with its own Context:

- **Scoping context** — one Context for the entire scoping phase (clarify → framework → baseline → grade). Only `clarification.ts` emits `role: system`; subsequent scoping prompts append user/assistant messages to the growing prefix.
- **Wave context** — a fresh Context per Wave. The first Wave's system prompt is built from DB state (topic, framework, starting tier, `startingContext`, initial SM-2 due concepts). Each subsequent Wave's system prompt is built from the _blueprint_ drafted by the LLM on the previous Wave's final turn plus fresh SM-2 state.

Within a phase the prefix is byte-stable (keeps prompt cache warm). At phase boundaries the closing Context is archived for history/UI but never replayed into future prompts. The DB stores Contexts as a row-per-message table; no prompt-from-components reassembly happens per turn.

## Harness injection

A `context_messages` row authored by the Harness (not the User, not the LLM) — kinds `harness_turn_counter` (every turn's `<turns_remaining>`) and `harness_review_block` (final-turn `<due_for_review>`). Content is natural-language English wrapped in an XML tag, so the model reads it the same way it reads any other turn (P4: harness injections are visible in the Context, not hidden side-channel state).

## LLM-facing terminology

User-facing copy, code, DB columns, and internal docs all say **Wave**. LLM prompts say **lesson** — the model has strong "lesson" priors and zero training-data signal for "Wave." Translation lives entirely in `src/lib/prompts/`; nothing else needs to know about the split.

## Framework

The 3-8 proficiency tiers the LLM generates for a course after clarification. Each tier has a name, description, and example concepts. User-editable before baseline generation.

## Harness

This repo. The system that wraps the LLM with deterministic logic (XP, SM-2 scheduling, tier advancement), persistence, auth, and UI. The LLM is a tool in the harness, not the harness itself. The harness is responsible for everything the LLM cannot be trusted with — scoring, progression, anti-gaming.

## LLM

The stateless text model (currently Cerebras' `llama-4-scout-17b-16e-instruct` via OpenAI-compatible API). Stateless: it holds no memory between HTTP calls. Each turn, the Harness loads the current Context from DB and sends it as-is — no regeneration from components. Regeneration only happens at phase boundaries, where a new system prompt is built. All LLM access goes through `src/lib/llm/` (`provider.ts` + `generate.ts`); direct `ai` SDK imports elsewhere are forbidden.

## Router

`src/server/routers/`. Transport layer only — tRPC procedure dispatch, input/output Zod validation, auth, DB persistence glue. Calls one Step per turn and returns its result. The Router does **not** contain heuristic business logic (turn-count decisions, wrap-up triggers, prompt shaping) — that lives in Steps.

## Scoping

The first set of turns when a User starts a new course: clarify → framework → baseline → grade. One append-only conversation — only `clarification.ts` emits `role: system`; later scoping prompts append user/assistant messages onto the growing, byte-stable prefix (keeps the prompt cache warm, so extra round trips are cheap). Scoping prompts are discarded once scoping completes; they never leak into teaching.

## Scoping pass

One row in `scoping_passes`, created when a User starts a course. Parents all scoping `context_messages` rows (clarification turns, framework turns, baseline turns) and stores the resulting clarification/framework/baseline JSONB as it crystallises. After scoping closes, the message history is discarded — only the structured outputs persist on `courses` (P-ON-05).

## Seed source

The discriminated-union JSONB on `waves.seed_source`. Either `{kind: "scoping_handoff"}` (Wave 1 — seeded directly from the course's framework + `startingContext`) or `{kind: "prior_blueprint", priorWaveId, blueprint}` (Wave N>1 — seeded from the prior Wave's emitted blueprint). Read by `renderTeachingSystem` to render the `<lesson_seed>` block.

## startingContext

A handoff string emitted by the batched `submitBaseline` LLM call. Consumed by the fresh teaching-session system prompt to seed the first learning session ("here's what this learner knows, here's where to begin"). Stored on the course row (extends the `baseline` JSONB column).

## Step

`src/lib/course/*.ts`. One file = one LLM call wrapped up, and the home of the per-turn heuristic business logic. Each Step loads DB state, applies the heuristics needed for this turn (turn-countdown injection within the current Wave, SM-2 due concepts on the final turn of a Wave, next-Wave blueprint emission on the final turn), appends injections plus the user's message to the Context, calls the LLM via `src/lib/llm/`, parses output via Zod, and returns a typed result. Deterministic algorithms (XP, SM-2 math, tier advancement) are **not** in Steps — they live in pure modules (`src/lib/scoring/`, `src/lib/spaced-repetition/`, `src/lib/progression/`) that Steps and Routers call. The Router persists whatever the Step returns. Steps never call each other directly; the Router sequences them.

## Teaching session

All turns after scoping. A teaching session is a sequence of Waves. The scoping Context is dead by this point; the first Wave's system prompt is built fresh from DB state (topic, framework, starting tier, `startingContext`, initial SM-2 due concepts). Each subsequent Wave opens its own Context with its own fresh system prompt built from the blueprint crafted at the previous Wave's close.

## Tier

One rung of a course's framework. Users advance through tiers by accumulating XP and satisfying minimum concept thresholds. Advancement is deterministic and model-independent.

## Turn

One ping-pong: User → Router → LLM → Router → User. Each turn is a single HTTP call the User triggers, resolved by one Step which makes one LLM call. Within a Wave, turns append messages to the growing Context; the Harness also appends `<turns_remaining>N</turns_remaining>` each turn so the LLM can pace its teaching and close within the Wave's turn budget (`WAVE_TURN_COUNT` in `src/lib/config/tuning.ts`). On the final turn the Harness additionally appends `<due_for_review>…</due_for_review>` and instructs the LLM to include the next Wave's blueprint (topic, outline, opening text) in its structured response.

## User

The learner. Distinct from the developer, admin, or agent. When docs say "the user," they mean the learner interacting with the UI unless context says otherwise.

## Wave

A single ~5-7 minute teaching unit within a Teaching session — Nalu's equivalent of a Duolingo lesson. Each Wave is one Context (one append-only LLM conversation with a byte-stable prefix).

**Fixed turn count.** A Wave runs for `WAVE_TURN_COUNT` turns (default 10, in `src/lib/config/tuning.ts`). Pacing is not LLM-decided — the Harness enforces it. On every turn the Harness appends `<turns_remaining>N</turns_remaining>` so the LLM knows where it is in the Wave and can land its closing quiz within the final few turns (wrap-up window ≈ `turns_remaining ≤ 3`). This gives Waves a consistent shape across a course.

**Final turn does double duty.** On the last turn (`turns_remaining == 0`), the Harness additionally injects `<due_for_review>…</due_for_review>` listing SM-2 concepts that are now due, and instructs the LLM to emit — in one structured response — both the closing exchange (quiz/summary) for the current Wave **and** the next Wave's _blueprint_: topic, outline, and opening user-facing text. The blueprint is persisted; when the User continues (immediately or after a pause), the next Wave's system prompt is built from it, opening a fresh Context. Pre-generating the opening text means the User returns to something to respond to, not a blank chat.

**Terminology split.** Internally (code, DB, docs, UI) the term is **Wave**. In LLM-facing prompt text the term is **lesson** — the model has strong priors around "lesson" and no pre-existing understanding of "Wave" in this domain. Structured JSON field names in the LLM's output can use either. The Router/Step is the translation point.

The wave motif persists as design language (wave-shaped XP bar, Hokusai palette). Tiers of the framework (e.g. "Tier 2: Borrowing Basics") are **not** Waves — they are tiers of the proficiency framework.
