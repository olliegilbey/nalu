# Data Model & Schema — Design Spec

**Status:** Draft
**Date:** 2026-04-28
**Milestone:** Phase 2 unblocker — replaces PRD §3.4 `sessions(messages JSONB)` with a Wave + per-message Context model. Pre-requisite for tRPC scoping and Wave routers.

---

## 1. Overview & goals

The codebase has all pure algorithms (SM-2, XP, tier advancement), the LLM transport layer, and scoping Steps. It has no persistence layer. PRD §3.4's `sessions` table conflicts with the Wave model in PRD §4.2 + the glossary — `wave.turn` has nowhere clean to append, and the cache-stable prefix invariant is unverifiable against a JSONB blob.

This spec defines the persistence layer for MVP: tables, constraints, indexes, Drizzle layout, query surface, and the symmetric `renderContext` / `parseAssistantResponse` LLM I/O contract that bridges the harness and the LLM.

**Out of scope** (each is its own milestone):

- tRPC scoping procedures (next milestone after this).
- Wave engine (`wave.start`, `wave.turn`, `wave.close`).
- Auth wiring (Supabase Auth + RLS policies). Replaced here with a hardcoded dev-user stub.
- UI.

---

## 2. Cross-cutting principles

These hold across every section below. They're load-bearing — change one and parts of the schema change.

### P1 — Append-only Context, byte-stable prefix

Within a Wave (or scoping pass), `context_messages` rows are immutable post-write. The render function produces byte-identical bytes for past turns on every send. This is what makes Anthropic-style prefix caching hit, and what makes audit replay deterministic. No row is ever updated or deleted within an active Context. Compaction happens only at Wave boundaries via the next-Wave blueprint handoff (Codex's pattern, not Gemini's overwrite-history pattern).

### P2 — Server-authoritative writes

Every `context_messages` row, every `assessment` row, every `concepts` SM-2 update, every XP attribution is server-authored. The client never authors rows that feed scoring. Forced by: (a) anti-gaming (PRD §8 — XP must be deterministic and model-independent; client-authored quality_scores would inflate trivially), (b) prompt-cache integrity (cache is keyed by API caller — only the server hits it), (c) multi-device resumability (Nalu's value prop is "remembers how you're doing"; that requires one source of truth), (d) API key custody.

### P3 — Logical events on disk, rendered bytes at send-time

`context_messages` rows are typed logical events (each has a `kind` discriminator). The bytes the LLM sees come from a deterministic render function over those rows + the Wave seed columns. This matches Codex CLI's `RolloutItem` pattern (research validated). The benefit: row-level audit, schema migration without history rewrites, byte-stability comes from the render function being pure + rows being immutable.

### P4 — Harness injections are prompts, not flags

Every `harness_*` row's `content` is natural-language English wrapped in an XML tag, written for the model to read and act on. Bare data like `<turns_remaining>3</turns_remaining>` is wrong. Correct shape:

```
<turns_remaining>You have 3 turns left in this lesson. Pace your teaching so you can land a clean wrap-up in the final turn.</turns_remaining>
```

Final turn:

```
<turns_remaining>This is the final turn of the lesson. Close the current thread and emit two required blocks in the same response: (a) `<next_lesson_blueprint>` covering the topic to teach next, an outline, and the opening text the next lesson will greet the learner with; (b) `<course_summary_update>` integrating this lesson's events with the prior summary in ≤150 words. Do not begin teaching new material in this turn.</turns_remaining>
<due_for_review>The following concepts are due for review and should shape the next lesson's blueprint: ...natural-language list with names + last-quality summaries...</due_for_review>
```

All harness-tag rendering lives in `src/lib/prompts/harness.ts` (per P-PR-01). The natural-language wording is baked in at row-write time, not at render time. Render trivially concatenates immutable rows — cache-safe.

### P5 — LLM-facing terminology: lesson, not Wave

The model is prompted exclusively in terms of "lesson" (it has no training data for "Wave"). UI displays "Wave"; harness prompts say "lesson". Translation enforced inside `src/lib/prompts/`. "Tier" is unchanged (model recognises it).

### P6 — Structured-output contract is part of the data model

Every assistant response is a multi-tag envelope. The harness defines the envelope; the model fills it. Each tag is a top-level XML-like block; order doesn't matter; the harness extracts by tag name.

The teaching-turn envelope:

```
<response>...natural-language teaching, markdown, code blocks; this is what the user sees in chat...</response>

<comprehension_signal>
{ "concept_name": "...", "demonstrated_quality": 0-5, "evidence": "..." }
</comprehension_signal>      [optional, multiple allowed per turn — see §6.5 for the two flavours]

<assessment>
{ "questions": [ {...}, {...} ] }
</assessment>                [optional, when the model wants to drop a card]

<next_lesson_blueprint>
{ "topic": "...", "outline": [...], "openingText": "..." }
</next_lesson_blueprint>     [REQUIRED ONLY on a Wave's final turn]

<course_summary_update>
{ "summary": "...bounded prose, ≤150 words, integrating prior summary + this Wave's events..." }
</course_summary_update>     [REQUIRED ONLY on a Wave's final turn]
```

`<curriculum_note>` is intentionally NOT in the MVP envelope. The post-MVP framework-editing feature will design the tag and its consumer together (§10).

The baseline-evaluation envelope (one-shot call from `submitBaseline`, not a Wave turn):

```
<batch_evaluation>
{ "evaluations": [ { "question_id": "...", "concept_name": "...", "quality_score": 0-5, "is_correct": bool, "rationale": "..." }, ... ] }
</batch_evaluation>          [REQUIRED — one entry per non-mechanically-graded question]

<course_summary>
{ "summary": "...bounded prose, ≤200 words, learner-specific texture from baseline gradings..." }
</course_summary>            [REQUIRED — seeds courses.summary at scoping close]
```

Schemas live in `src/lib/types/llmResponse.ts`. Validated at the trust boundary post-extraction. Format definition for the model lives in the static system prompt's `<output_formats>` block (per P-PR-02 cache-efficient ordering). The full bidirectional vocabulary is enumerated in §6.5.

### P7 — Scoping is a Context, not a sequence of one-shot calls

Scoping is multi-turn, byte-stable, append-only — same Context discipline as a Wave. Reasons: (a) cache efficiency: subsequent scoping calls hit a long cached prefix instead of paying full prompt cost each time; (b) coherence: the model has the user's exact phrasing in scope when generating the framework, not just structured extracts; (c) uniformity: one Context model in the codebase. Scoping has its own parent table (`scoping_passes`); `context_messages` is polymorphic.

### P8 — No premature normalisation

JSONB for opaque snapshots we read whole and never query into (`framework`, `baseline`, `seed_source`, `blueprint_emitted`, `due_concepts_snapshot`). Typed columns and tables for things we join, filter, sort, or aggregate on (`concepts`, `assessments`, `waves`). If a JSONB-buried field later needs to be queryable, that's an additive migration — we'll see the need before we hit it.

### P9 — Single tag-vocabulary contract

The harness ↔ model interface is one closed set of XML-tagged blocks, defined in §6.5. Every tag the model emits and every tag the harness injects is enumerated there with its schema and direction. The static system prompt's `<output_formats>` block is the model-facing half; harness injection logic in `src/lib/prompts/harness.ts` is the harness-facing half. Both halves are generated from the same TS source of truth so they cannot drift. New tags require an additive change to that source of truth and a corresponding migration of the prompt template.

---

## 3. Tables and columns (DDL)

Postgres syntax for clarity; Drizzle TS schema in §7 mirrors it. All primary keys are `uuid` defaulting to `gen_random_uuid()` unless noted. All timestamps are `timestamptz`. All FKs cascade on parent delete unless noted.

```sql
-- 3.1 user_profiles ---------------------------------------------------------
CREATE TABLE user_profiles (
  id                  uuid PRIMARY KEY,            -- = auth.users(id) when auth wired; dev stub for now (§5)
  display_name        text NOT NULL,
  total_xp            integer NOT NULL DEFAULT 0,  -- cached aggregate; reconciled from courses
  custom_instructions text,                        -- pass-through verbatim; snapshotted onto waves at Wave start
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- 3.2 courses ---------------------------------------------------------------
CREATE TABLE courses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES user_profiles(id) ON DELETE CASCADE,
  topic            text NOT NULL,
  -- scoping outputs (immutable post-scoping):
  clarification    jsonb,                          -- { questions: [...], answers: [...] }
  framework        jsonb,                          -- { topic, scope_summary, tiers: [...] }; null until scoping emits
  baseline         jsonb,                          -- { questions: [...], answers: [...], gradings: [...] }; raw audit
  starting_tier    integer,                        -- determined from baseline; immutable post-scoping
  -- live state:
  current_tier     integer NOT NULL DEFAULT 1,     -- mutable; promotion/demotion via progression.ts
  total_xp         integer NOT NULL DEFAULT 0,     -- cached aggregate from assessments
  status           text NOT NULL DEFAULT 'scoping' -- 'scoping' | 'active' | 'archived'
                     CHECK (status IN ('scoping','active','archived')),
  summary          text,                           -- LLM-rewritten cumulative summary; seeded from baseline at scoping close, then rewritten on each Wave close via <course_summary_update>
  summary_updated_at timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- 3.3 scoping_passes --------------------------------------------------------
CREATE TABLE scoping_passes (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id  uuid NOT NULL UNIQUE REFERENCES courses(id) ON DELETE CASCADE,
  -- UNIQUE: one scoping pass per course (MVP). Drop if we ever support re-scoping.
  status     text NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','closed')),
  opened_at  timestamptz NOT NULL DEFAULT now(),
  closed_at  timestamptz
);

-- 3.4 waves -----------------------------------------------------------------
CREATE TABLE waves (
  id                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id                   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  wave_number                 integer NOT NULL,    -- 1-indexed within course
  tier                        integer NOT NULL,    -- snapshot at Wave start
  framework_snapshot          jsonb NOT NULL,      -- frozen from courses.framework at start
  custom_instructions_snapshot text,               -- frozen from user_profiles at start
  due_concepts_snapshot       jsonb NOT NULL,      -- frozen SM-2 due list at start: [{conceptId, name, lastQuality}]
  seed_source                 jsonb NOT NULL,      -- discriminated union (see below)
  turn_budget                 integer NOT NULL,    -- from config.WAVE_TURN_COUNT at Wave start
  status                      text NOT NULL DEFAULT 'open'
                                CHECK (status IN ('open','closed')),
  summary                     text,                -- emitted on close
  blueprint_emitted           jsonb,               -- the next-Wave handoff JSON; null for an open Wave
  opened_at                   timestamptz NOT NULL DEFAULT now(),
  closed_at                   timestamptz,
  UNIQUE (course_id, wave_number)
);

-- seed_source shape (TS, not SQL):
--   | { kind: 'scoping_handoff' }                                -- Wave 1; payload empty.
--                                                                  -- Wave 1's progress_summary block renders from courses.summary
--                                                                  -- (baseline-derived). Wave 1 has no opening_user_text — the
--                                                                  -- model generates the opening on its first turn.
--   | { kind: 'prior_blueprint', priorWaveId: string,
--       blueprint: { topic, outline, openingText } }             -- Wave 2+. Blueprint is embedded (not just referenced) for byte-stability.

-- 3.5 context_messages ------------------------------------------------------
CREATE TABLE context_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wave_id         uuid REFERENCES waves(id) ON DELETE CASCADE,
  scoping_pass_id uuid REFERENCES scoping_passes(id) ON DELETE CASCADE,
  turn_index      integer NOT NULL,                -- 0-based within parent. PER-TURN, NOT PER-LLM-CALL: a single turn that triggered a retry shares one turn_index.
  seq             smallint NOT NULL,               -- ordering within a turn
  kind            text NOT NULL                    -- enum below
                    CHECK (kind IN (
                      'user_message','card_answer','assistant_response',
                      'harness_turn_counter','harness_review_block'
                    )),
  role            text NOT NULL                    -- LLM-API role; 'system' is intentionally excluded — system content is rendered from seed columns, never persisted as a row (§9.1)
                    CHECK (role IN ('user','assistant','tool')),
  content         text NOT NULL,                   -- exact bytes
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT context_messages_one_parent
    CHECK ((wave_id IS NOT NULL) <> (scoping_pass_id IS NOT NULL))
);
-- card_answer rows are mutually exclusive with user_message rows for the same turn:
-- a turn that's a card answer has no separate user prose (the chat input becomes the
-- card UI per sim P-UI-02). Card-answer content is the rendered <card_answers> envelope (§6.5).

-- 3.6 concepts --------------------------------------------------------------
CREATE TABLE concepts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id          uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  name               text NOT NULL,                -- canonical; see §4 dedup model
  description        text,
  tier               integer NOT NULL,
  -- SM-2 state:
  easiness_factor    real NOT NULL DEFAULT 2.5,
  interval_days      integer NOT NULL DEFAULT 0,
  repetition_count   integer NOT NULL DEFAULT 0,
  last_quality_score integer,                      -- 0-5; nullable until first assessment
  last_reviewed_at   timestamptz,
  next_review_at     timestamptz,
  -- counters:
  times_correct      integer NOT NULL DEFAULT 0,
  times_incorrect    integer NOT NULL DEFAULT 0,
  first_seen_at      timestamptz NOT NULL DEFAULT now()
);

-- 3.7 assessments -----------------------------------------------------------
CREATE TABLE assessments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  wave_id         uuid NOT NULL REFERENCES waves(id) ON DELETE CASCADE,
  concept_id      uuid NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
  turn_index      integer NOT NULL,                -- which Wave turn produced this
  question        text,                            -- nullable: 'inferred' rows have no posed question (signal arrives from the model's reading of free-form dialogue)
  user_answer     text NOT NULL,                   -- for 'inferred', this is the user's prior message text that produced the signal
  is_correct      boolean NOT NULL,
  quality_score   integer NOT NULL,                -- 0-5
  assessment_kind text NOT NULL                    -- 'card_mc' | 'card_freetext' | 'inferred'
                    CHECK (assessment_kind IN ('card_mc','card_freetext','inferred')),
  xp_awarded      integer NOT NULL DEFAULT 0,
  assessed_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT assessments_question_required_for_card_kinds
    CHECK (assessment_kind = 'inferred' OR question IS NOT NULL)
);
```

### Decisions baked in

- **Baseline lives in `courses.baseline JSONB`**, not in `assessments`. The `assessments` table is exclusively in-Wave probes that earn XP. Baseline grades flow into `concepts` rows (seeding initial SM-2 state — see "Concept seeding lifecycle" below) but the question/answer/grading payload itself is one JSONB on the course — read whole.
- **Concept seeding lifecycle:**
  - At `submitBaseline`, one `concepts` row is inserted per baseline-graded concept. Non-engagement (q=0) concepts ARE seeded — sim P-XP-02. SM-2 state derives from `quality_score` on a single SM-2 step.
  - Framework `example_concepts` are descriptive only — they are NOT pre-seeded as `concepts` rows. Tier-3+ concepts the baseline didn't probe stay unseeded until the model first emits them.
  - Beyond baseline, the harness upserts a concept row at `<assessment>` parse time (so the assessment row has a `concept_id` when the answer eventually comes back) AND at `<comprehension_signal>` parse time (for inferred signals). Both paths use `INSERT … ON CONFLICT (course_id, lower(name)) DO UPDATE` (§4 dedup).
  - Concept `tier` is set at first sighting and immutable thereafter. The model emitting a different tier on a later encounter is treated as a slip; the existing `tier` is preserved.
- **`courses.summary` is the qualitative cumulative summary.** Seeded at scoping close from the baseline batch evaluation's prose summary. Rewritten at every Wave close via the `<course_summary_update>` tag in the final-turn structured response (§9.2). No separate `starting_context` column — the initial summary IS what the dropped column would have stored, and Wave 1's `<progress_summary>` block renders from `courses.summary` exactly like every other Wave.
- **`waves.framework_snapshot` and `custom_instructions_snapshot`** freeze inputs at Wave start. Critical for byte-stable rendering: if the user edits custom instructions or the framework gets edited between Waves, the in-flight Wave's seed inputs don't drift. `courses.summary` does NOT need a per-Wave snapshot because the partial unique index "at most one open Wave per course" guarantees it only changes at Wave close — between Wave-N-open and Wave-N-close it is stable.
- **`waves.due_concepts_snapshot`** freezes the SM-2 due list embedded in the Wave seed. Same snapshot drives the final-turn `harness_review_block` (filtered to exclude concepts assessed within this Wave — derived from `assessments` rows for this `wave_id`).
- **`seed_source` as a discriminated union JSONB** captures both Wave-1 (scoping handoff, empty payload) and Wave-N+1 (prior blueprint embedded for byte-stability) cases without nullable-column proliferation.
- **No `seed_rendered` snapshot column.** `renderContext` re-renders deterministically from structured columns. Cost of a template change is one cache miss for in-flight Waves; recoverable.
- **`tool` pre-allocated in `context_messages.role` enum** for post-MVP tool calls (sim §3 NB foreshadows WebSearch). `system` is excluded — system content is rendered from seed columns at send time, never persisted as a row.
- **`context_messages.content` holds raw bytes.** For `user_message` rows: sanitised, `<user_message>`-wrapped text. For `card_answer` rows: the rendered `<card_answers>` envelope per §6.5. For `assistant_response`: the full multi-tag response from the model (or the templated fallback on second-failure — §9.2). For `harness_*`: the rendered natural-language tag (per P4).
- **`courses.total_xp` and `user_profiles.total_xp` are cached aggregates.** Reconciled from `assessments.xp_awarded` sums; reconciliation logic is a query-layer concern (§7).

---

## 4. Concept dedup model

The model emits concept names like "aliasing XOR mutability". Across Waves the same concept may resurface with slightly different phrasing. Dedup approach:

**Strict natural key + model is told existing names.** `UNIQUE (course_id, lower(name))`. The model is given the existing concept list in the Wave seed (the SM-2 due list embeds them; the framework names them; the prior Wave's blueprint can name them). The query layer uses `INSERT ... ON CONFLICT (course_id, lower(name)) DO UPDATE` for upserts.

Drift cost: occasional duplicates. Recoverable post-MVP via a fuzzy-match reconciliation pass.

---

## 5. Identity & auth stub

Auth is its own milestone (RLS policies are a real design task). For this milestone:

- `user_profiles.id` references `auth.users(id)` (production-correct shape from day one).
- `DEV_USER_ID` env var (validated in `src/lib/config/env.ts`).
- Seed script (`bun src/db/seed.ts`) inserts a row into `auth.users` and `user_profiles` with that UUID against the local Supabase stack.
- All tRPC procedures read `DEV_USER_ID` from env until auth lands.

When auth is wired, the dev row becomes a normal user; production never sees the dev UUID.

---

## 6. Indexes and constraints

### Constraints

- **All FKs `ON DELETE CASCADE`** — chain: user → courses → (waves, scoping_passes, concepts) → (context_messages, assessments).
- **CHECK constraints on enums:** `courses.status`, `waves.status`, `scoping_passes.status`, `context_messages.kind`, `context_messages.role`, `assessments.assessment_kind`. Defence-in-depth alongside Drizzle/TS types.
- **UNIQUE constraints:**
  - `waves (course_id, wave_number)` — wave numbering monotonic within a course.
  - `concepts (course_id, lower(name))` — functional unique index for §4 dedup.
  - `scoping_passes (course_id)` — at most one scoping pass per course (MVP).
- **Polymorphic parent on `context_messages`:** `CHECK ((wave_id IS NOT NULL) <> (scoping_pass_id IS NOT NULL))`.
- **Partial unique invariant: at most one open Wave per course.**
  ```sql
  CREATE UNIQUE INDEX waves_one_open_per_course
    ON waves (course_id) WHERE status = 'open';
  ```
  Hard guarantee at the DB level. Closing a Wave (`status → 'closed'`) is what unblocks opening the next.
- **Partial uniques for context ordering** (replaces a single `UNIQUE (wave_id, turn_index, seq)`):
  ```sql
  CREATE UNIQUE INDEX context_messages_wave_order
    ON context_messages (wave_id, turn_index, seq)
    WHERE wave_id IS NOT NULL;
  CREATE UNIQUE INDEX context_messages_scoping_order
    ON context_messages (scoping_pass_id, turn_index, seq)
    WHERE scoping_pass_id IS NOT NULL;
  ```

### Indexes

| Index                                                                   | Purpose                                                           |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `courses (user_id)`                                                     | "list this user's courses"                                        |
| `concepts (course_id, next_review_at) WHERE next_review_at IS NOT NULL` | hot path: "what's due now". Partial keeps it small.               |
| `concepts (course_id, tier)`                                            | tier-advancement aggregates over current-tier concepts            |
| `assessments (wave_id)`                                                 | final-turn de-dup: "what concepts were assessed inside this Wave" |
| `assessments (concept_id, assessed_at DESC)`                            | concept history view; SM-2 audit                                  |

Composite uniques (above) cover the remaining FK indexing needs.

### Deliberately not indexed (yet)

- `assessments.assessed_at` standalone — no MVP query sorts by global recency without a wave/concept scope.
- `concepts.first_seen_at` — analytics, defer.
- `waves.opened_at` / `closed_at` — defer until streak/timeline UI.
- `context_messages.created_at` — `(turn_index, seq)` already gives strict order; `created_at` is for audit only.

### Hot-path note

The SM-2 due-list query (`next_review_at <= now()`) runs at every Wave start and is the most cache-sensitive read path. The partial index keeps it lean. If the dataset ever grows past the partial index's selectivity, consider `(course_id, next_review_at) INCLUDE (id, name, tier, last_quality_score)`. Post-MVP.

---

## 6.5 Tag vocabulary contract

The complete set of XML-tagged blocks crossing the harness ↔ model boundary. Per P9, this is the single source of truth — the static system prompt's `<output_formats>` block and `src/lib/prompts/harness.ts` both derive from these definitions and cannot drift.

### Model → harness (model emits, harness extracts)

| Tag                       | Required when                              | Schema (TS)                                                                                                                  | Persisted as                                                                                                             | Side effects                                                                                                                                                                                                                                                                                                                                               |
| ------------------------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<response>`              | Every teaching turn                        | `string` (markdown)                                                                                                          | Part of `assistant_response` row                                                                                         | Rendered to user; rest of envelope stripped from view                                                                                                                                                                                                                                                                                                      |
| `<comprehension_signal>`  | Optional, ≥0 per turn                      | `{ concept_name, demonstrated_quality: 0-5, evidence }`                                                                      | Within `assistant_response` row; triggers `assessments` row                                                              | Concept upsert; SM-2 update; XP award. Two flavours: (i) **graded** — fired in response to a `<card_answers>` request from the harness, scoring a free-text or freetext-escape card answer; (ii) **inferred** — model's read of the user's free-form prose. Schema identical; harness routes by whether a `<card_answers>` row appeared in the prior turn. |
| `<assessment>`            | Optional, ≤1 per turn                      | `{ questions: [{ question_id, concept_name, tier, type, question, options?, correct?, freetextRubric?, explanation? }, …] }` | Within `assistant_response` row; concepts upserted on parse                                                              | Card rendered to user; `assessments` rows wait for answers in next turn                                                                                                                                                                                                                                                                                    |
| `<next_lesson_blueprint>` | REQUIRED on Wave's final turn              | `{ topic, outline: string[], openingText }`                                                                                  | `waves.blueprint_emitted`; embedded into next Wave's `seed_source`                                                       | Closes Wave; seeds Wave N+1                                                                                                                                                                                                                                                                                                                                |
| `<course_summary_update>` | REQUIRED on Wave's final turn              | `{ summary }` (≤150 words)                                                                                                   | `courses.summary` (overwrites); `courses.summary_updated_at`                                                             | Replaces cumulative summary                                                                                                                                                                                                                                                                                                                                |
| `<batch_evaluation>`      | REQUIRED in `submitBaseline` response only | `{ evaluations: [{ question_id, concept_name, quality_score, is_correct, rationale }, …] }`                                  | `courses.baseline` (raw JSONB) + per-concept `concepts` upsert with seeded SM-2. NO `assessments` rows (see note below). | Drives starting-tier determination; SM-2 seeding                                                                                                                                                                                                                                                                                                           |
| `<course_summary>`        | REQUIRED in `submitBaseline` response only | `{ summary }` (≤200 words)                                                                                                   | `courses.summary` (initial seed)                                                                                         | Initial cumulative summary                                                                                                                                                                                                                                                                                                                                 |

**Note on baseline `assessments` rows:** baseline gradings are stored as `concepts` rows (SM-2 seeded) + raw `courses.baseline` JSONB. They do NOT generate `assessments` table rows — that table is exclusively for in-Wave probes (per §3 decisions). The `concepts.times_correct` / `times_incorrect` counters are bumped at `submitBaseline` from the gradings.

### Harness → model (harness writes as `context_messages` rows; model reads)

All harness injections are natural-language English wrapped in an XML tag (P4). Wording is baked in at row-write time, not at render time.

| Tag                  | Row `kind`             | When written                                                    | Content shape                                                                                                                                                                                                                                                                                        |
| -------------------- | ---------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<user_message>`     | `user_message`         | Every user-prose turn                                           | Sanitised user prose, XML-escaped, wrapped: `<user_message>{prose}</user_message>`                                                                                                                                                                                                                   |
| `<card_answers>`     | `card_answer`          | Every card-answer turn (mutually exclusive with `user_message`) | Per-question envelope: question_id, type, the user's choice/text, harness-determined grading status (e.g. "marked CORRECT against your stated answer (B)"), concept name. Tells the model which questions need its grading via `<comprehension_signal>` and which are already mechanically resolved. |
| `<turns_remaining>`  | `harness_turn_counter` | Every turn                                                      | Natural-language pacing instruction (P4 example)                                                                                                                                                                                                                                                     |
| `<due_for_review>`   | `harness_review_block` | Final turn of a Wave only                                       | Filtered SM-2 due list (excludes concepts assessed within this Wave) as natural-language list with concept names + last-quality summaries                                                                                                                                                            |
| `<schema_violation>` | (not persisted)        | Retry attempt within a turn (§9.2)                              | In-memory only. Quotes the validation error and instructs the model to re-emit.                                                                                                                                                                                                                      |

### Output-format block in the system prompt

The static `<output_formats>` block in the Wave system prompt enumerates the five model→harness teaching-turn tags: `<response>` (every turn), `<comprehension_signal>` (optional, ≥0 per turn), `<assessment>` (optional, ≤1 per turn), `<next_lesson_blueprint>` (required on final turn), `<course_summary_update>` (required on final turn). The baseline-evaluation envelope (`<batch_evaluation>` + `<course_summary>`) is described in `src/lib/prompts/baseline.ts` separately — it's a one-shot call, not a Wave turn. Tag definitions are generated from the same TS source so the prompt and the parser cannot drift.

---

## 7. Drizzle layout

### File structure

```
src/db/
├── schema/
│   ├── index.ts             # re-exports all tables + relations
│   ├── userProfiles.ts
│   ├── courses.ts
│   ├── scopingPasses.ts
│   ├── waves.ts
│   ├── contextMessages.ts
│   ├── concepts.ts
│   └── assessments.ts
├── client.ts                # drizzle instance, connection pooling
├── seed.ts                  # dev-user seeding (§5)
├── queries/                 # query layer (§8)
└── migrations/              # drizzle-kit output, committed
    ├── 0000_init.sql
    └── meta/
```

Split per domain so each schema file stays under the 200-line limit and is browseable.

### Migration tooling

- **`drizzle-kit`** for SQL generation. Project-root `drizzle.config.ts` points at `src/db/schema/`, outputs to `src/db/migrations/`, reads `DATABASE_URL` from env.
- **Workflow:** edit schema TS → `bun drizzle-kit generate --name <descriptive>` → review SQL diff → commit both. Pre-commit hook runs `drizzle-kit check` to catch out-of-sync state.
- **Apply:** `bun drizzle-kit migrate` runs pending migrations. Same command in dev, CI, and production deploy.
- **No raw `db push`** — every change has a reviewable migration artifact in git.

### Schema-to-Zod approach

Layered:

1. **`drizzle-zod`** auto-generates `selectSchema` and `insertSchema` per table. Lives next to the table file.
2. **Hand-written refinements** in `src/lib/types/` for things drizzle-zod can't infer:
   - JSONB column inner shapes (`framework`, `baseline`, `clarification`, `seed_source`, `blueprint_emitted`, `due_concepts_snapshot`).
   - Constrained primitives (e.g., `tierSchema = z.number().int().min(1).max(5)`; `qualityScoreSchema` already exists in `src/lib/types/spaced-repetition.ts`).
   - Branded types if useful (`CourseId`, `WaveId`).
3. **Trust-boundary schemas compose them.** E.g., `coursesSelectSchema.extend({ framework: frameworkSchema })` overrides JSONB-as-unknown with the strict shape. Used by query layer's read functions per existing P-IM rule.

### Type exports

```ts
// src/db/schema/courses.ts
export const courses = pgTable("courses", { ... });
export type Course = InferSelectModel<typeof courses>;
export type CourseInsert = InferInsertModel<typeof courses>;
export const coursesInsertSchema = createInsertSchema(courses);
export const coursesSelectSchema = createSelectSchema(courses);
```

Conventions: table identifier camelCase (`courses`), DB name snake_case (`courses`), TS row type PascalCase singular (`Course`).

### Connection client

```ts
// src/db/client.ts
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { env } from "@/lib/config/env";

const client = postgres(env.DATABASE_URL, { prepare: false }); // PgBouncer compat
export const db = drizzle(client, { schema });
export type DB = typeof db;
```

`prepare: false` because Supabase's pooled connection (`:6543`) goes through PgBouncer in transaction mode. Two URLs in env (Supabase convention):

- `DATABASE_URL` — pooled, for app queries
- `DIRECT_URL` — direct, for migrations (drizzle-kit reads this)

### Local dev workflow

- `supabase start` — local Postgres + Auth + Studio.
- `bun drizzle-kit migrate` — runs migrations against local.
- `bun src/db/seed.ts` — inserts dev user (§5).
- `just dev` — works against local Supabase out of the box.

`justfile` gets recipes: `just db-reset`, `just db-migrate`, `just db-seed`, `just db-generate <name>`.

### Drift discipline

- Schema TS is source of truth. Hand-edited generated migrations forbidden (lint rule against modifying generated files).
- Pre-commit: `drizzle-kit check`.
- CI: spin up ephemeral Postgres, run all migrations + integration tests against it.

---

## 8. Query layer (`src/db/queries/`)

One file per domain. Each file exports typed functions; raw Drizzle calls do not leak past these files (per `src/db/queries/CLAUDE.md` — "only place SQL or Supabase client calls exist"). Reads Zod-validate at the boundary using the trust-boundary schemas from §7.

### Files and their surfaces

```
src/db/queries/
├── userProfiles.ts
│   getUserById(id) → UserProfile
│   ensureDevUser() → UserProfile          # idempotent; for seed + dev
│   incrementUserXp(id, amount) → void
│
├── courses.ts
│   createCourse({ userId, topic }) → Course
│   getCourseById(id) → Course
│   listCoursesByUser(userId) → readonly Course[]
│   updateCourseScopingState(id, patch) → Course   # partial: clarification, framework, baseline, etc.
│   setCourseStartingState(id, { initialSummary, startingTier, currentTier }) → Course
│   updateCourseSummary(id, summary) → Course      # called from Wave close via <course_summary_update>
│   updateCourseTier(id, newTier) → Course
│   incrementCourseXp(id, amount) → Course
│   archiveCourse(id) → void
│
├── scopingPasses.ts
│   openScopingPass(courseId) → ScopingPass
│   getOpenScopingPassByCourse(courseId) → ScopingPass | null
│   closeScopingPass(id) → ScopingPass
│
├── waves.ts
│   openWave({ courseId, waveNumber, tier, frameworkSnapshot, customInstructionsSnapshot,
│              dueConceptsSnapshot, seedSource, turnBudget }) → Wave
│   getOpenWaveByCourse(courseId) → Wave | null
│   getWaveById(id) → Wave
│   closeWave(id, { summary, blueprintEmitted }) → Wave
│   listClosedWavesByCourse(courseId) → readonly Wave[]   # for UI history
│
├── contextMessages.ts
│   appendMessage({ parent: { kind: 'wave', id } | { kind: 'scoping', id },
│                   turnIndex, seq, kind, role, content }) → ContextMessage
│   getMessagesForWave(waveId) → readonly ContextMessage[]      # ordered by (turn_index, seq)
│   getMessagesForScopingPass(scopingPassId) → readonly ContextMessage[]
│   getNextTurnIndex({ parent }) → number                       # max(turn_index) + 1
│   getLastAssessmentCard(waveId) → AssessmentCard | null       # extracts the most recent <assessment> from assistant_response rows; used by card-answer turn to look up correct answers
│
├── concepts.ts
│   upsertConcept({ courseId, name, description, tier, sm2State }) → Concept
│   getConceptsByCourse(courseId) → readonly Concept[]
│   getDueConceptsByCourse(courseId, now: Date) → readonly Concept[]   # next_review_at <= now
│   updateConceptSm2(id, sm2State) → Concept                    # ef, interval, rep, last_quality, last_reviewed_at, next_review_at
│   incrementCorrect(id) → void
│   incrementIncorrect(id) → void
│
├── assessments.ts
│   recordAssessment({ waveId, conceptId, turnIndex, question, userAnswer,
│                      isCorrect, qualityScore, assessmentKind, xpAwarded }) → Assessment
│   getAssessmentsByWave(waveId) → readonly Assessment[]        # for final-turn de-dup
│   getAssessmentsByConcept(conceptId) → readonly Assessment[]
│
└── index.ts                # re-exports all
```

### Conventions

- Read functions return readonly arrays of typed rows; write functions return the affected row.
- Every read passes results through the trust-boundary Zod schema (validates JSONB shape on read).
- No transactions in the function signatures themselves — transactional operations are composed at the tRPC procedure layer where the unit of work is defined. Drizzle's `db.transaction()` is used there.
- Error model: throw typed errors (`NotFoundError`, `ConflictError`); tRPC adapter maps to procedure errors.

---

## 9. Render & parse — LLM I/O contract

This section defines the symmetric pair: turning rows + Wave columns into LLM messages (render), and turning the LLM's response into rows + derived state (parse).

### 9.1 Render: `renderContext`

Lives in `src/lib/llm/renderContext.ts`. Pure function, no side effects, no I/O.

```ts
interface RenderContextParams {
  readonly seed: WaveSeedInputs | ScopingSeedInputs; // structured seed inputs
  readonly messages: readonly ContextMessage[]; // ordered (turn_index, seq)
}

interface RenderedContext {
  readonly system: string; // rendered seed
  readonly messages: readonly LLMMessage[]; // role/content pairs ready for the LLM
}

interface LLMMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
}

function renderContext(params: RenderContextParams): RenderedContext;
```

**Determinism contract:** same inputs → same outputs, byte-identical, every call. Tested explicitly:

```ts
it("is byte-stable across calls", () => {
  const a = renderContext(fixture);
  const b = renderContext(fixture);
  expect(a.system).toBe(b.system);
  expect(a.messages).toEqual(b.messages);
});

it("preserves prefix when a turn is appended", () => {
  const prefix = renderContext({ seed, messages: messages.slice(0, -2) });
  const full = renderContext({ seed, messages });
  expect(full.system).toBe(prefix.system);
  for (let i = 0; i < prefix.messages.length; i++) {
    expect(full.messages[i]).toEqual(prefix.messages[i]);
  }
});
```

The second test is the cache-invariant test: if it fails, prompt caching breaks.

**Composition rules:**

- `seed` → `system` content via prompt template functions in `src/lib/prompts/{teaching,scoping}.ts`.
- `messages` are emitted in row order. Consecutive same-role rows may be concatenated into one LLM message (e.g., a `user_message` row + an immediately following `harness_turn_counter` row both with role `user` collapse into one user-role message).
- `tool`-role rows (post-MVP) follow the LLM API's tool-result placement.

**Open detail (resolve in implementation milestone):** exact attachment point for `<turns_remaining>` — concatenated into the user message's content vs as its own role-`user` message immediately following. Both work with the row schema; pick whichever yields cleaner cache-key behaviour against the Cerebras / OpenAI-compatible target.

### 9.2 Parse: `parseAssistantResponse`

Lives in `src/lib/llm/parseAssistantResponse.ts`. Pure function.

```ts
interface ParsedAssistantResponse {
  readonly response: string; // user-visible text from <response>
  readonly comprehensionSignals: readonly ComprehensionSignal[];
  readonly assessment: AssessmentCard | null;
  readonly nextLessonBlueprint: NextLessonBlueprint | null;
  readonly courseSummaryUpdate: CourseSummaryUpdate | null;
  readonly raw: string; // verbatim model output for persistence
}

function parseAssistantResponse(raw: string): ParsedAssistantResponse;
```

Each tag schema lives in `src/lib/types/llmResponse.ts` (Zod). Extraction uses the existing `extractTag` utility.

**Order of operations after the LLM call returns successfully:**

1. **Persist the (validated) response** as one `assistant_response` row in `context_messages`. See "Retry & failure handling" below for what counts as "the response."
2. **Parse + validate** each tag with its Zod schema (already done as part of the success gate).
3. **Write derived rows transactionally:**
   - Each `<comprehension_signal>` → resolve to a `concepts` row by `(course_id, lower(name))`; upsert if missing (with the tier the model emitted on this signal); SM-2 step; insert `assessments` row. The `assessment_kind` is determined by whether the prior turn included a `<card_answers>` row asking for grading: if yes and the signal's concept matches a question in that envelope → `card_freetext`; otherwise → `inferred`. XP increment on `courses` and `user_profiles`.
   - `<assessment>` → upsert `concepts` rows for each question's `concept_name` (so each subsequent answer has a `concept_id`). No `assessments` row yet — those wait for the user's answers in the next turn.
   - `<next_lesson_blueprint>` (final turn only) → `waves.blueprint_emitted` + `waves.status = 'closed'` + `waves.closed_at`.
   - `<course_summary_update>` (final turn only) → `courses.summary` (overwrite) + `courses.summary_updated_at = now()`.
4. **Tier advancement check** (calls existing `progression.ts` over current-tier concepts). If passed, update `courses.current_tier`.

**Retry & failure handling:**

Validation gates: the response is "valid" iff `<response>` is present (every turn) AND, on a Wave's final turn, BOTH `<next_lesson_blueprint>` AND `<course_summary_update>` are present. Optional tags (`<comprehension_signal>`, `<assessment>`) that fail their inner Zod schema are dropped silently; the rest of the turn proceeds.

- **Retry policy: at most one retry per turn.** If the first call's response fails the validation gate, the harness constructs an in-memory message list containing: (i) the original render, (ii) the failed assistant response, (iii) a corrective harness message wrapped as `<schema_violation>` (P4 natural language, naming the specific failure), and re-issues the call.
- **Persistence of the retry:** the failed response and the `<schema_violation>` correction are NEVER persisted to `context_messages`. They live only in the in-memory message list constructed for the retry call. The successful retry response IS persisted as the single `assistant_response` row for that turn.
- **`turn_index` / `<turns_remaining>` are per-turn, not per-LLM-call.** A retry shares one turn_index with the first attempt; the harness's `<turns_remaining>N</turns_remaining>` injection uses the same N for both calls.
- **Second-failure behaviour:** if the retry ALSO fails the validation gate, the harness writes a templated fallback `assistant_response` row with content `<response>I had trouble formatting my response cleanly there. Could you rephrase or continue your thought, and I'll pick it back up?</response>`. NO derived state is written: no comprehension signals fired, no XP awarded, no SM-2 updates, no Wave close. The user's `user_message` (or `card_answer`) row IS persisted — the user's input is never lost. The turn DOES count against `turn_budget`. There is no third retry; the turn ends and the user's next message starts a fresh turn.
- **Audit:** raw bytes of failed attempts are not persisted to `context_messages`. The deferred `llm_call_logs` table (§10) closes this gap when it lands; for MVP, debug via Vitest fixtures and ephemeral logs.

### 9.3 The harness loop (one Wave turn, end-to-end)

Sequence the tRPC procedure in the next milestone implements. Two turn variants — prose turn and card-answer turn — diverge only at step 2.

```
 1. Read Wave row, all context_messages for this wave_id.
 2a. Prose turn (input is user prose):
     Sanitize incoming user input; render <user_message>...</user_message>;
     append as user_message row (turn_index = next, seq = 0).
 2b. Card-answer turn (input is structured card submission referencing a card emitted in turn N-1):
     For each MC question with a letter answer (i.e. NOT freetext-escape):
       - Look up the LLM-stated correct answer from the prior <assessment> row.
       - Compute is_correct mechanically; map to quality_score (4 correct, 1 incorrect — see tuning).
       - Compute xp_awarded via tier × 10 × multiplier.
       - Insert assessments row (assessment_kind = 'card_mc'), bump concept counters,
         run SM-2 step on concepts row, increment courses.total_xp + user_profiles.total_xp.
       - Emit XP toast event for the client (P-UI-03).
     Render <card_answers> envelope (§6.5): per-question summary stating type,
       user's selection/text, and pre-graded outcome where applicable; explicit "please
       grade" for freetext + freetext-escape questions.
     Append as card_answer row (turn_index = next, seq = 0).
 3. Compute turns_remaining = turn_budget - turn_index - 1.
 4. Render harness_turn_counter content (natural language, per P4). On the final turn the wording also instructs the model to emit `<next_lesson_blueprint>` AND `<course_summary_update>` (P4 final-turn example). Append as harness_turn_counter row (seq = 1).
 5. If final turn: also render harness_review_block (filtered SM-2 due list excluding concepts already assessed in this Wave); append as additional row (seq = 2).
 6. renderContext(seed, all rows for this wave) → {system, messages}.
 7. LLM call.
 8. Validate response (§9.2 retry gate). If first attempt fails, retry once in-memory
    (do NOT persist failed attempt or correction). If retry also fails, persist templated
    fallback as assistant_response and skip step 9 derived writes.
 9. Persist successful (or fallback) response as assistant_response row.
10. parseAssistantResponse → derived state writes (§9.2 step 3). Skipped on fallback.
11. Return user-facing response text + assessment card (if any) + any XP toasts to the caller.
```

Steps 2b (mechanical pre-grading + card_answer row write), 9, and 10 all run inside one Drizzle transaction. The pre-graded XP toasts from step 2b are emitted to the client as part of the same response payload — they are not a separate side channel.

---

## 10. Open items deferred to later milestones

- **Tier-reduction thresholds** in `tuning.ts` (concrete numbers — sim §10.9 open item).
- **Mechanical-MC quality-score mapping** — sim §4.2 implies 4 for correct, 1 for incorrect; confirm exact mapping in `tuning.ts` (probably alongside the existing `qualityMultiplier` table).
- **Card-answer collection state machine** — IndexedDB vs localStorage vs server-side draft; survival across refresh (UI milestone).
- **Multi-question card UX** — tabbed vs stacked vs progressive-reveal (UI milestone).
- **Concept name fuzzy-dedup pass** — post-MVP reconciliation if natural-key dedup leaks (§4).
- **`llm_call_logs` audit table** — generic per-call log with raw bytes + token tracking (PRD §12 token tracking can live here). Closes the audit gap left by the no-persist retry policy (§9.2). Post-MVP but worth landing soon after MVP for ops visibility.
- **`<curriculum_note>` + `curriculum_notes` table** — when post-MVP framework editing earns its keep, design the tag schema, the persistence table, and the consumer (auto-edit vs user-surfaced suggestion) together. Deliberately omitted from the MVP envelope to avoid speculative schema.
- **`tier_changes` history** — for streak/milestone UX.
- **Auth wiring** — Supabase Auth + RLS policies (its own milestone).
- **Cache hot-path verification** — verify static-block stability against Cerebras / OpenAI-compatible cache behaviour (sim §10.9).
- **`turns_remaining` exact attachment point** — concatenate into user message content vs separate role-user message (§9.1 open detail).
- **Per-concept qualitative notes column** — if Wave-by-Wave summary rewrite turns out to lose concept-specific texture for concepts the learner doesn't re-encounter for many Waves, consider an additive `concepts.notes text` column. Not justified yet; the mitigation is prompt engineering on `<course_summary_update>` to preserve learner-specific observations.
- **Zod bound-violation retry generalisation** — the existing TODO for scoping `generateStructured` retries is now subsumed by §9.2's retry policy. The retry mechanism is unified across scoping and teaching once the corresponding tRPC procedures are built.

---

## 11. Migration & validation plan

### Migration order (single `0000_init.sql`)

1. `user_profiles`
2. `courses`
3. `scoping_passes`
4. `waves`
5. `concepts`
6. `context_messages`
7. `assessments`
8. All indexes (composite uniques, partials, hot-path indexes)
9. `CREATE EXTENSION IF NOT EXISTS pgcrypto` if `gen_random_uuid()` not already available

### Validation gates before this milestone closes

- `bun drizzle-kit migrate` succeeds against fresh local Supabase from zero.
- `bun src/db/seed.ts` creates dev user idempotently.
- All query-layer functions have at least one happy-path test against a live local Postgres (Vitest + testcontainers OR Supabase local).
- `renderContext` tests pass: byte-stable across calls + prefix preservation across appends, including across `card_answer` rows.
- `parseAssistantResponse` tests pass: validation gate fires when `<response>` missing; final-turn gate requires both `<next_lesson_blueprint>` and `<course_summary_update>`; optional-tag failures don't fail the whole turn.
- Retry-policy tests pass: failed first attempt + retry success → only the successful response is persisted; second failure → templated fallback is persisted, no derived state writes; turn_index identical across both attempts in either case.
- `assessments_question_required_for_card_kinds` CHECK rejects a `card_mc` row with NULL `question` and accepts an `inferred` row with NULL `question`.
- `bun typecheck` and `bun lint` pass.
- CI runs migrations + tests against ephemeral Postgres.
- Knip reports no unused exports from the schema or query layer.

---

## 12. Affected and updated documents

- **`docs/PRD.md` §3.4** — replace the existing data model with this spec's §3. Keep the prose around it; update only the SQL block.
- **`docs/PRD.md` §4.2 + §5.1** — rename `<next_wave_blueprint>` → `<next_lesson_blueprint>` per P5 (LLM-facing = "lesson"). Add `<course_summary_update>` to the final-turn structured-response description. PRD §4.2's "append to course.summary" wording becomes "rewrite via `<course_summary_update>`."
- **`docs/PRD.md` §4.2** — describe the card-answer turn variant: chat input becomes the card UI; mechanical MC pre-grading happens server-side before the LLM call; LLM grades free-text via `<comprehension_signal>` on the next turn.
- **`docs/UBIQUITOUS_LANGUAGE.md`** — add entries for: `Context`, `scoping pass`, `harness injection`, `seed source`, `blueprint`, `card answer`, `cumulative summary`, plus the LLM-facing-terminology rule (P5).
- **`docs/ux-simulation-rust-ownership.md` §10/§11** — same `<next_wave_blueprint>` → `<next_lesson_blueprint>` rename for consistency with P5. Add a brief note that `<curriculum_note>` (P-CV-05) is post-MVP and not in the MVP envelope.
- **`docs/TODO.md`** — strike the "Data-model rewrite for Waves + per-message Context rows" item; the Zod bound-violation retry item is subsumed by §9.2 (note this in the entry rather than removing entirely until the implementation lands). Add any items deferred to §10 that aren't already there.
- **`src/db/queries/CLAUDE.md`** — extend with the file list in §8. Update the existing `sessions.ts` mention to `waves.ts` + `scopingPasses.ts` + `contextMessages.ts`.
- **`src/lib/llm/CLAUDE.md`** — extend with the `renderContext` / `parseAssistantResponse` contract (§9) and the tag vocabulary contract reference (§6.5).
