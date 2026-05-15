# Submit Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the closing step of scoping end-to-end. `course.submitBaseline` runs one append-only LLM turn that grades the baseline, derives `startingTier`, writes the durable summaries, primes Wave 1 with a blueprint, and atomically flips `courses.status` from `'scoping'` to `'active'`.

**Architecture:** One LLM call shaped by a shared `makeCloseTurnBaseSchema({ scopeTiers, questionIds })` extended with two scoping-only fields (`immutableSummary`, `startingTier`). Mechanical MC grading runs first, then `executeTurn` runs unconditionally (the LLM still owns summaries and blueprint even when every answer is MC). All writes happen inside one DB transaction: widen `courses.baseline` JSONB; upsert one concept per distinct `conceptName` with default SM-2 fields (Pattern B — untaught, not a review event); insert Wave 1 row with `seedSource.scoping_handoff` carrying the blueprint; insert one `context_messages` row with `openingText` scoped to Wave 1; `setCourseStartingState` flips status; `incrementCourseXp`. Wave 1 is then openable with no further LLM call.

**Tech Stack:** Next.js 16.2, tRPC v11, Drizzle ORM, Zod v4 (wire) + Zod v3 (storage round-trip), Vitest, testcontainers Postgres. Uses **bun** (not npm). Pre-commit hooks NEVER bypassed (`--no-verify` is forbidden — see KARPATHY.md, AGENTS.md).

**Reference spec:** `docs/superpowers/specs/2026-05-14-submit-baseline-design.md` — read in full before starting; this plan implements it task-by-task.

**Branch:** `feat/submit-baseline` (already checked out; spec committed as `ab9443d`). PR to `main` — never commit directly to main.

---

## Discipline (read before every task)

1. **Simplification bias.** The spec is direction, not contract. Before each new file or abstraction, ask: can this collapse into an existing primitive? Can two helpers be one? Can an indirection be inlined? Raise it in the PR description, then either simplify or document why not. The user has flagged the project trends toward over-engineering; active collapse is welcome (see `feedback_simplification_bias_during_impl`).
2. **TDD.** Every task is red → green → commit. Run the failing test before implementation. Verify it fails for the right reason (not a typo or import error).
3. **Never bypass git hooks.** No `--no-verify`, no `HUSKY=0`, no skipping pre-commit. Fix the underlying issue. CI re-runs every check anyway.
4. **200-LOC ceiling per file.** If a file approaches it, split it before exceeding.
5. **Commit after each task.** Conventional Commits (`feat:`, `refactor:`, `test:`, `chore:`, `docs:`).
6. **Run `just check` locally before pushing** — typecheck + lint + tests. CI is a backstop, not the first check.
7. **`just smoke` is opt-in** — it hits live Cerebras and costs tokens. Run it once before opening the PR.

---

## Decision points the implementer will hit

These are flagged here so the agent surfaces them rather than silently committing one direction. Document the choice in the PR description.

### D1. Baseline assessment-table writes

Spec §3.7 says "Insert one assessment row per grading." But `assessments.waveId` is NOT NULL (FK → waves) and `assessments_question_required_for_card_kinds` requires non-null `question` for `card_mc`/`card_freetext` kinds. Three options:

- **(A) Insert against Wave 1's id with turnIndex 0.** Mixes baseline analytics into the Wave 1 timeline. The `openingText` row in `context_messages` is also at Wave 1 turn 0 — but `assessments.turn_index` is independent from `context_messages.turn_index`, so no collision. Cleanest if analytics is wanted.
- **(B) Defer — gradings live solely in `courses.baseline.gradings` JSONB for MVP.** Adds an entry to `TODO.md`. Simplification-bias winner.
- **(C) Make `assessments.wave_id` nullable.** Schema migration; broader blast radius.

**Recommended: (B) for MVP.** `courses.baseline.gradings` already carries the full grading record. SM-2 isn't fired by baseline (Pattern B). If we later need timeline analytics across baseline+teaching, a backfill from JSONB is straightforward. Document and TODO.

### D2. Concept upsert when `description` is unavailable at baseline time

`upsertConcept({ courseId, name, tier, description? })` accepts an optional description. The scoping-close turn does not emit per-concept descriptions (the grading item carries `conceptName`, `conceptTier`, `rationale` — but `rationale` is question-specific, not concept-general).

- **(A) Omit description.** Concept rows get `null` description; future teaching prompts fill it in lazily.
- **(B) Use the `rationale` from the first grading as a temporary description.** Mixes per-question reasoning into concept-level metadata. Bad.

**Recommended: (A).** Skip description on baseline upserts. The `concept.description` column already permits null.

### D3. Where `mergeAndComputeXp` lives

The spec sketches it as a pure function. Two homes:

- **(A) Inline in `submitBaseline.ts`.** Pure local helper, tests via the orchestration test.
- **(B) Sibling file `submitBaseline.merge.ts` with its own unit tests.** Easier TDD; clearer 200-LOC budgets.

**Recommended: (B).** It's small enough that the unit-test surface is worth the second file. Keeps `submitBaseline.ts` focused on orchestration.

### D4. Concept-set used for upsert when duplicates appear

Multiple gradings can share a `conceptName` (e.g. two questions probing "ownership"). The first grading sets the `conceptTier`. If later gradings disagree on tier:

- **(A) `tier` is immutable post-first-sight.** `ON CONFLICT (course_id, lower(name)) DO NOTHING` already enforces this. The second tier value is silently ignored.
- **(B) Validate that all gradings agree on `conceptTier` per concept; refine-fail the LLM if not.**

**Recommended: (A).** The Zod `superRefine` step can still warn the LLM via the description ("Keep `conceptTier` consistent across questions probing the same concept"). Post-hoc reconciliation is YAGNI for MVP.

---

## File structure (what gets created / modified / deleted)

**Create:**

- `src/lib/prompts/closeTurn.ts` — shared `makeCloseTurnBaseSchema`, `closeGradingItemSchema`, `blueprintSchema` (wire) with directive `.describe()` text. Re-exports nothing the future Wave-end won't also use.
- `src/lib/prompts/closeTurn.test.ts` — round-trip + refine tests for the base schema.
- `src/lib/prompts/scopingClose.ts` — `makeScopingCloseSchema`, `renderScopingCloseStage` envelope renderer. Extends the base with `immutableSummary` + `startingTier` and the close-turn superRefine that gates tier-band alignment.
- `src/lib/prompts/scopingClose.test.ts` — refine tests for scoping-only extensions.
- `src/lib/course/submitBaseline.ts` — orchestration: preconditions → mechanical MC → executeTurn → mergeAndComputeXp → persist.
- `src/lib/course/submitBaseline.test.ts` — integration test (mocked executeTurn + real Postgres via testcontainers).
- `src/lib/course/submitBaseline.persist.ts` — transaction body: JSONB widen → concept upsert → wave1 insert → context_messages.openingText → setCourseStartingState → incrementCourseXp.
- `src/lib/course/submitBaseline.persist.test.ts` — integration test for the persist body in isolation.
- `src/lib/course/submitBaseline.merge.ts` — pure `mergeAndComputeXp(parsed, mcGradings, course)` function.
- `src/lib/course/submitBaseline.merge.test.ts` — unit tests for the merge.
- `src/lib/course/submitBaseline.internal.ts` — verbatim move of `gradeBaseline.internal.ts` content; minor rename adjustments.
- `scripts/smoke/scoping-close.ts` — live opt-in smoke driver.

**Modify:**

- `src/lib/types/jsonb.ts` — widen `baselineJsonbSchema` with `immutableSummary`, `summarySeed`, `startingTier`; extend `gradings[]` items with `conceptTier`; extend `seedSourceSchema.scoping_handoff` to carry `blueprint`.
- `src/lib/types/jsonb.test.ts` (if exists; else create alongside) — extend the round-trip test to cover the widened shapes.
- `src/db/queries/courses.integration.test.ts` — extend `courseRowGuard` coverage for the widened baseline shape.
- `src/db/queries/waves.integration.test.ts` — extend `waveRowGuard` coverage for `scoping_handoff` with blueprint.
- `src/server/routers/course.ts` — mount `submitBaseline` mutation.
- `src/server/routers/course.integration.test.ts` — end-to-end happy-path through submitBaseline.
- `src/lib/prompts/scoping.ts` — extend the `stage` union with `"close scoping"` (the new stage label) OR replace the `"grade baseline"` label with `"close scoping"`. See Task 4.
- `src/lib/course/CLAUDE.md` — add a line about submitBaseline and the three-file split.
- `src/lib/prompts/CLAUDE.md` — note the close-turn shared base.

**Delete (after parity):**

- `src/lib/prompts/baselineGrading.ts` and its test (schema subsumed by `closeTurn.ts` + `scopingClose.ts`).
- `src/lib/course/gradeBaseline.ts` and `gradeBaseline.test.ts` (function replaced by submitBaseline; mechanical MC moves into `submitBaseline.ts`).
- `src/lib/course/gradeBaseline.internal.ts` (content moved verbatim to `submitBaseline.internal.ts`).
- `src/lib/course/determineStartingTier.ts` and `determineStartingTier.test.ts` (LLM emits `startingTier` directly).

**Out-of-scope (do NOT touch):**

- Wave teaching loop. The Wave-end close schema is set up by `closeTurn.ts` but not implemented.
- SM-2 review writes on baseline (Pattern B — untaught).
- Streaming responses.
- Real Supabase Auth/RLS.
- Assessment-table baseline writes (deferred per D1).

---

## Task 0: Pre-flight

- [ ] **Step 1: Confirm branch and clean state**

Run:

```bash
git branch --show-current
git status
```

Expected: `feat/submit-baseline`, working tree clean (`.claude/scheduled_tasks.lock` ignored). If not on the branch, `git checkout feat/submit-baseline`.

- [ ] **Step 2: Run baseline `just check`**

Run: `just check`
Expected: PASS (typecheck + lint + tests all green on the spec-only commit `ab9443d`).

If anything fails here, stop and report — the plan assumes a green baseline.

---

## Task 1: Widen `baselineJsonbSchema` and extend `seedSourceSchema` (Zod v3, storage)

**Files:**

- Modify: `src/lib/types/jsonb.ts`
- Modify (or create): `src/lib/types/jsonb.test.ts`

- [ ] **Step 1: Write the failing test**

Open `src/lib/types/jsonb.test.ts` (create if absent — colocated test). Add cases for the widened shapes:

```ts
import { describe, it, expect } from "vitest";
import { baselineJsonbSchema, seedSourceSchema, blueprintSchema } from "./jsonb";

describe("baselineJsonbSchema (widened)", () => {
  it("accepts the closing payload with summaries, startingTier, and per-grading conceptTier", () => {
    const parsed = baselineJsonbSchema.parse({
      userMessage: "wrap-up",
      questions: [
        {
          id: "b1",
          type: "multiple_choice",
          prompt: "Q",
          options: { A: "a", B: "b", C: "c", D: "d" },
          freetextRubric: "rubric",
          conceptName: "ownership",
          tier: 2,
        },
      ],
      responses: [{ questionId: "b1", choice: "A" }],
      gradings: [
        {
          questionId: "b1",
          conceptName: "ownership",
          conceptTier: 2,
          verdict: "correct",
          qualityScore: 5,
          rationale: "fine",
        },
      ],
      immutableSummary: "durable profile",
      summarySeed: "evolving summary v0",
      startingTier: 2,
    });
    expect(parsed.startingTier).toBe(2);
    expect(parsed.gradings[0].conceptTier).toBe(2);
  });

  it("rejects verdict/qualityScore mismatch", () => {
    expect(() =>
      baselineJsonbSchema.parse({
        userMessage: "x",
        questions: [],
        responses: [],
        gradings: [
          {
            questionId: "b1",
            conceptName: "c",
            conceptTier: 1,
            verdict: "correct",
            qualityScore: 1,
            rationale: "r",
          },
        ],
        immutableSummary: "s",
        summarySeed: "s",
        startingTier: 1,
      }),
    ).toThrow(/qualityScore/);
  });
});

describe("seedSourceSchema.scoping_handoff carries blueprint", () => {
  it("requires blueprint on scoping_handoff", () => {
    const ok = seedSourceSchema.parse({
      kind: "scoping_handoff",
      blueprint: { topic: "t", outline: ["a"], openingText: "hi" },
    });
    expect(ok.kind).toBe("scoping_handoff");
    expect(() => seedSourceSchema.parse({ kind: "scoping_handoff" })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/lib/types/jsonb.test.ts`
Expected: FAIL with messages about unknown keys (`startingTier`, `conceptTier`) or missing `blueprint` on `scoping_handoff`.

- [ ] **Step 3: Widen `baselineJsonbSchema` in `src/lib/types/jsonb.ts`**

In the `--- courses.baseline ---` block, extend `baselineGradingSchema` and `baselineJsonbSchema`:

```ts
export const baselineGradingSchema = z
  .object({
    questionId: z.string(),
    conceptName: z.string(),
    conceptTier: z.number().int().positive(),
    verdict: z.enum(["correct", "partial", "incorrect"]),
    qualityScore: qualityScoreSchema,
    rationale: z.string(),
  })
  .superRefine((val, ctx) => {
    const [lo, hi] = VERDICT_QUALITY_BANDS[val.verdict];
    if (val.qualityScore < lo || val.qualityScore > hi) {
      ctx.addIssue({
        code: "custom",
        path: ["qualityScore"],
        message: `verdict='${val.verdict}' requires qualityScore in [${lo}, ${hi}], got ${val.qualityScore}.`,
      });
    }
  });

export const baselineJsonbSchema = z.object({
  userMessage: z.string(),
  questions: z.array(v3Question),
  responses: z.array(v3Response),
  gradings: z.array(baselineGradingSchema),
  immutableSummary: z.string(),
  summarySeed: z.string(),
  startingTier: z.number().int().positive(),
});
export type BaselineJsonb = z.infer<typeof baselineJsonbSchema>;
```

- [ ] **Step 4: Extend `seedSourceSchema.scoping_handoff` to carry blueprint**

Replace the existing `scoping_handoff` arm:

```ts
export const seedSourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("scoping_handoff"),
    blueprint: blueprintSchema,
  }),
  z.object({
    kind: z.literal("prior_blueprint"),
    priorWaveId: z.string().uuid(),
    blueprint: blueprintSchema,
  }),
]);
```

Note: `blueprintSchema` is already defined above this block — no reordering needed.

- [ ] **Step 5: Run all tests to confirm green and no regressions**

Run: `bunx vitest run src/lib/types/ src/db/queries/`
Expected: PASS. Any pre-existing test that constructs a `BaselineJsonb` fixture without the new fields will break — fix those fixtures inline (search for `baselineJsonbSchema` / `BaselineJsonb` usages and add `immutableSummary: ""`, `summarySeed: ""`, `startingTier: 1` to existing test rows that exercise scoping-active state; for scoping-in-progress fixtures, omit the keys — wait, the schema requires them).

**Backfill strategy:** the JSONB column is nullable on the table; `courseRowGuard` only parses when non-null. So existing fixtures that store a partial baseline (during scoping) need to either:

- Be removed (the partial-baseline path is now `generateBaseline` writing `{ userMessage, questions, responses: [], gradings: [] }` only) — but the widened schema rejects that.

Resolution: split `baselineJsonbSchema` into two:

```ts
// What `generateBaseline` writes after questions are generated but before close.
export const baselineQuestionsJsonbSchema = z.object({
  userMessage: z.string(),
  questions: z.array(v3Question),
  responses: z.array(v3Response),
  gradings: z.array(baselineGradingSchema),
});

// What `submitBaseline` writes on close. Includes everything plus close-turn outputs.
export const baselineClosedJsonbSchema = baselineQuestionsJsonbSchema.extend({
  immutableSummary: z.string(),
  summarySeed: z.string(),
  startingTier: z.number().int().positive(),
});

// Row-guard reads accept either shape — the closed shape is a strict superset.
export const baselineJsonbSchema = z.union([
  baselineClosedJsonbSchema,
  baselineQuestionsJsonbSchema,
]);
export type BaselineJsonb = z.infer<typeof baselineJsonbSchema>;
export type BaselineClosedJsonb = z.infer<typeof baselineClosedJsonbSchema>;
```

Discriminate at the consumer site by checking `"startingTier" in baseline`.

Adjust the test above so `baselineQuestionsJsonbSchema` covers the partial case and `baselineClosedJsonbSchema` covers the widened case. The union test for `baselineJsonbSchema` proves both parse.

- [ ] **Step 6: Commit**

```bash
git add src/lib/types/jsonb.ts src/lib/types/jsonb.test.ts
git commit -m "feat(jsonb): widen baseline schema for close-turn payload and seed-source blueprint"
```

---

## Task 2: Wire-side shared close-turn schemas (`closeTurn.ts`)

**Files:**

- Create: `src/lib/prompts/closeTurn.ts`
- Create: `src/lib/prompts/closeTurn.test.ts`

This file owns the `zod/v4` wire schema for the close-turn fields that both scoping-close and (future) wave-end share: `userMessage`, `gradings[]`, `summary`, `nextUnitBlueprint`. The base is parameterised on `{ scopeTiers, questionIds }` so the tier-band and id-coverage refines are runtime-closed.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/prompts/closeTurn.test.ts
import { describe, it, expect } from "vitest";
import { makeCloseTurnBaseSchema } from "./closeTurn";

const validPayload = {
  userMessage: "wrap-up text",
  gradings: [
    {
      questionId: "b1",
      verdict: "correct" as const,
      qualityScore: 5,
      conceptName: "ownership",
      conceptTier: 2,
      rationale: "Two-sentence rationale. Tells us where to start.",
    },
  ],
  summary: "Initial summary of where they're starting.",
  nextUnitBlueprint: {
    topic: "Ownership basics",
    outline: ["intro", "moves", "borrows"],
    openingText: "Welcome. We'll start with how Rust tracks ownership.",
  },
};

describe("makeCloseTurnBaseSchema", () => {
  it("accepts a valid payload", () => {
    const schema = makeCloseTurnBaseSchema({ scopeTiers: [1, 2, 3], questionIds: ["b1"] });
    expect(schema.parse(validPayload)).toMatchObject({ userMessage: "wrap-up text" });
  });

  it("rejects out-of-band qualityScore for verdict='correct'", () => {
    const schema = makeCloseTurnBaseSchema({ scopeTiers: [1, 2, 3], questionIds: ["b1"] });
    expect(() =>
      schema.parse({
        ...validPayload,
        gradings: [{ ...validPayload.gradings[0], verdict: "correct", qualityScore: 1 }],
      }),
    ).toThrow(/qualityScore/);
  });

  it("rejects conceptTier outside scopeTiers", () => {
    const schema = makeCloseTurnBaseSchema({ scopeTiers: [1, 2], questionIds: ["b1"] });
    expect(() =>
      schema.parse({
        ...validPayload,
        gradings: [{ ...validPayload.gradings[0], conceptTier: 5 }],
      }),
    ).toThrow(/conceptTier/);
  });

  it("rejects gradings that don't cover every questionId", () => {
    const schema = makeCloseTurnBaseSchema({
      scopeTiers: [1, 2, 3],
      questionIds: ["b1", "b2"],
    });
    expect(() => schema.parse(validPayload)).toThrow(/b2/);
  });

  it("rejects duplicate questionIds in gradings", () => {
    const schema = makeCloseTurnBaseSchema({ scopeTiers: [1, 2, 3], questionIds: ["b1"] });
    expect(() =>
      schema.parse({
        ...validPayload,
        gradings: [validPayload.gradings[0], validPayload.gradings[0]],
      }),
    ).toThrow(/duplicate/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/lib/prompts/closeTurn.test.ts`
Expected: FAIL — `makeCloseTurnBaseSchema` not exported.

- [ ] **Step 3: Implement `closeTurn.ts`**

```ts
// src/lib/prompts/closeTurn.ts
import { z } from "zod/v4";
import { qualityScoreSchema } from "@/lib/types/spaced-repetition";

/**
 * Verdict ↔ qualityScore alignment. Mirrors the v3 storage table in
 * `src/lib/types/jsonb.ts` — keep them in sync.
 */
const VERDICT_QUALITY_BANDS: Readonly<
  Record<"correct" | "partial" | "incorrect", readonly [number, number]>
> = {
  correct: [4, 5],
  partial: [2, 3],
  incorrect: [0, 1],
};

/** One grading item — shape shared by scoping-close and (future) wave-end. */
export const closeGradingItemSchema = z.object({
  questionId: z
    .string()
    .describe(
      "The id of the question you are grading. Copy verbatim from the question this evaluation refers to.",
    ),
  verdict: z
    .enum(["correct", "partial", "incorrect"])
    .describe(
      "Judge the learner's answer against the expected answer. Use 'correct' only when the answer captures the key idea; 'partial' when the learner shows some grasp but misses important pieces; 'incorrect' when the answer misses the point or is wrong.",
    ),
  qualityScore: qualityScoreSchema.describe(
    "Score the answer 0-5. 5 = fluent, fully correct. 4 = correct with minor gaps. 3 = mostly right, notable gap. 2 = partial grasp, important errors. 1 = wrong but related. 0 = no understanding. Keep this in band with your verdict (correct → 4-5, partial → 2-3, incorrect → 0-1).",
  ),
  conceptName: z
    .string()
    .min(1)
    .describe(
      "Name the single concept this question probes. Use the noun-phrase a learner would search for, e.g. 'Rust ownership', not 'the idea that values have owners'. Keep names consistent across questions that probe the same concept.",
    ),
  conceptTier: z
    .number()
    .int()
    .describe(
      "Place the concept at the level a learner needs to reach to grasp it confidently. Use the level numbers from the framework you produced earlier in this conversation. Don't drift outside the framework's level range.",
    ),
  rationale: z
    .string()
    .describe(
      "Two sentences. First sentence: name what the learner got right or wrong. Second sentence: what this tells you about where to start teaching them.",
    ),
});

/** Blueprint for the following lesson — shared by scoping-close and wave-end. */
export const blueprintSchema = z.object({
  topic: z
    .string()
    .min(1)
    .describe(
      "Name the focus of the first lesson in 3-7 words. This is the headline the learner sees when they enter the lesson.",
    ),
  outline: z
    .array(z.string().min(1))
    .min(1)
    .describe(
      "List the beats of the first lesson, one bullet per beat, 3-6 bullets. Order them in the sequence you'll teach them. Each beat is a phrase, not a sentence.",
    ),
  openingText: z
    .string()
    .min(1)
    .describe(
      "Write the first message the learner sees when they open lesson 1. 2-4 sentences. Greet them by what you've learned about them, name what you'll teach in this lesson, invite their first response. Conversational, warm, no markdown headers.",
    ),
});

export interface MakeCloseTurnBaseSchemaParams {
  readonly scopeTiers: readonly number[];
  readonly questionIds: readonly string[];
}

/**
 * Shared close-turn base. Returns a Zod object schema with the fields every
 * close-turn (scoping or wave-end) emits. Tier-band and id-coverage invariants
 * are runtime-closed over `scopeTiers` / `questionIds` so the refine messages
 * can name the specific values that triggered the violation.
 */
export function makeCloseTurnBaseSchema(params: MakeCloseTurnBaseSchemaParams) {
  const scope = new Set(params.scopeTiers);
  const idSet = new Set(params.questionIds);

  return z
    .object({
      userMessage: z
        .string()
        .min(1)
        .describe(
          "Write the message the learner sees as the closing of this planning conversation. Acknowledge a specific thing you've learned about them, then signal that their first lesson is ready. 2-3 sentences. Conversational.",
        ),
      gradings: z
        .array(closeGradingItemSchema)
        .describe(
          "Produce one grading entry per question the learner answered. Cover every question — don't drop any.",
        ),
      summary: z
        .string()
        .min(1)
        .describe(
          "Write a 2-3 sentence summary of where this learner is starting from in this subject, based on how they performed so far. This summary will grow as the course progresses; you're writing its current state.",
        ),
      nextUnitBlueprint: blueprintSchema.describe(
        "The plan for the first lesson. The learner will see `openingText` when they enter that lesson.",
      ),
    })
    .superRefine((val, ctx) => {
      // 1. Verdict/qualityScore band.
      val.gradings.forEach((g, idx) => {
        const [lo, hi] = VERDICT_QUALITY_BANDS[g.verdict];
        if (g.qualityScore < lo || g.qualityScore > hi) {
          ctx.addIssue({
            code: "custom",
            path: ["gradings", idx, "qualityScore"],
            message:
              `grading for ${g.questionId}: verdict='${g.verdict}' requires qualityScore in [${lo}, ${hi}], got ${g.qualityScore}. ` +
              "Map: correct → 4-5, partial → 2-3, incorrect → 0-1.",
          });
        }
        // 2. conceptTier in scope.
        if (!scope.has(g.conceptTier)) {
          ctx.addIssue({
            code: "custom",
            path: ["gradings", idx, "conceptTier"],
            message: `grading for ${g.questionId}: conceptTier ${g.conceptTier} is outside the framework's level range [${[...scope].join(", ")}].`,
          });
        }
      });
      // 3. Unique question ids.
      const ids = val.gradings.map((g) => g.questionId);
      const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
      if (dupes.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["gradings"],
          message: `duplicate questionIds in gradings: ${[...new Set(dupes)].join(", ")}`,
        });
      }
      // 4. Every question covered.
      const missing = [...idSet].filter((id) => !ids.includes(id));
      if (missing.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["gradings"],
          message: `gradings missing for question ids: ${missing.join(", ")}`,
        });
      }
      // 5. No stray ids.
      const stray = ids.filter((id) => !idSet.has(id));
      if (stray.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["gradings"],
          message: `gradings include unknown question ids: ${stray.join(", ")}`,
        });
      }
    });
}

export type CloseTurnBase = z.infer<ReturnType<typeof makeCloseTurnBaseSchema>>;
```

- [ ] **Step 4: Run tests to verify green**

Run: `bunx vitest run src/lib/prompts/closeTurn.test.ts`
Expected: PASS (all 5 cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/prompts/closeTurn.ts src/lib/prompts/closeTurn.test.ts
git commit -m "feat(prompts): shared close-turn base schema for scoping/wave-end close"
```

---

## Task 3: Scoping-only close-turn extensions (`scopingClose.ts`)

**Files:**

- Create: `src/lib/prompts/scopingClose.ts`
- Create: `src/lib/prompts/scopingClose.test.ts`
- Modify: `src/lib/prompts/scoping.ts` (extend the `stage` union)

- [ ] **Step 1: Extend the `stage` union in `scoping.ts`**

In `src/lib/prompts/scoping.ts`, update `RenderStageEnvelopeParams.stage`:

```ts
readonly stage:
  | "clarify"
  | "generate framework"
  | "generate baseline"
  | "close scoping";
```

Remove `"grade baseline"` — it has no remaining caller after submit-baseline lands. (If `grep -r '"grade baseline"' src/` shows any holdouts, fix them as part of this task; the legacy `gradeBaseline.ts` will be deleted in Task 9.)

- [ ] **Step 2: Write the failing test**

```ts
// src/lib/prompts/scopingClose.test.ts
import { describe, it, expect } from "vitest";
import { makeScopingCloseSchema, renderScopingCloseStage } from "./scopingClose";

const base = {
  userMessage: "wrap",
  gradings: [
    {
      questionId: "b1",
      verdict: "correct" as const,
      qualityScore: 5,
      conceptName: "ownership",
      conceptTier: 2,
      rationale: "Solid answer. Start lesson 1 with moves.",
    },
  ],
  summary: "starting summary",
  nextUnitBlueprint: {
    topic: "Ownership basics",
    outline: ["a", "b"],
    openingText: "Welcome.",
  },
};

describe("makeScopingCloseSchema", () => {
  it("accepts payload with immutableSummary and startingTier in scope", () => {
    const schema = makeScopingCloseSchema({ scopeTiers: [1, 2, 3], questionIds: ["b1"] });
    expect(
      schema.parse({ ...base, immutableSummary: "durable profile", startingTier: 2 }),
    ).toMatchObject({ startingTier: 2 });
  });

  it("rejects startingTier outside scopeTiers", () => {
    const schema = makeScopingCloseSchema({ scopeTiers: [1, 2], questionIds: ["b1"] });
    expect(() => schema.parse({ ...base, immutableSummary: "x", startingTier: 5 })).toThrow(
      /startingTier/,
    );
  });
});

describe("renderScopingCloseStage", () => {
  it("emits an XML envelope with the stage label and learner payload", () => {
    const out = renderScopingCloseStage({
      learnerInput: '{"items":[]}',
      responseSchema: undefined,
    });
    expect(out).toContain("<stage>close scoping</stage>");
    expect(out).toContain("<learner_input>");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bunx vitest run src/lib/prompts/scopingClose.test.ts`
Expected: FAIL — `makeScopingCloseSchema` and `renderScopingCloseStage` not exported.

- [ ] **Step 4: Implement `scopingClose.ts`**

```ts
// src/lib/prompts/scopingClose.ts
import { z } from "zod/v4";
import { makeCloseTurnBaseSchema, type MakeCloseTurnBaseSchemaParams } from "./closeTurn";
import { renderStageEnvelope } from "./scoping";

/**
 * Scoping-only extensions on the shared close-turn base. The model emits two
 * one-shot fields exclusive to scoping close:
 *   - `immutableSummary`: durable learner profile, written once.
 *   - `startingTier`: the level lesson 1 starts at.
 *
 * Both are clamped to the framework's `scopeTiers` via a superRefine layered
 * on top of the base schema's grading-tier refine. Refine failures route back
 * into `executeTurn`'s ValidationGateFailure retry as teacher-style messages.
 */
export function makeScopingCloseSchema(params: MakeCloseTurnBaseSchemaParams) {
  const scope = new Set(params.scopeTiers);
  const base = makeCloseTurnBaseSchema(params);

  return base.and(
    z
      .object({
        immutableSummary: z
          .string()
          .min(1)
          .describe(
            "Capture the durable facts about this learner that should ground every future lesson: their background, what they're trying to achieve, what they already know, what motivates them. 3-5 sentences. Write what you'd want to be reminded of at the start of every lesson you teach them.",
          ),
        startingTier: z
          .number()
          .int()
          .describe(
            "Choose the framework level at which lesson 1 should begin teaching. Base it on the learner's performance: where did they show competence, where did they show gaps? Pick the lowest level at which they need real teaching. Stay inside the framework's level range.",
          ),
      })
      .superRefine((val, ctx) => {
        if (!scope.has(val.startingTier)) {
          ctx.addIssue({
            code: "custom",
            path: ["startingTier"],
            message: `startingTier ${val.startingTier} is outside the framework's level range [${[...scope].join(", ")}]. Choose one of the levels in that range.`,
          });
        }
      }),
  );
}

export type ScopingCloseTurn = z.infer<ReturnType<typeof makeScopingCloseSchema>>;

/**
 * Stage envelope for the close-scoping turn. The learner-input payload carries
 * the per-question answers and mechanical MC results so the model can read
 * what was submitted without re-asking. Cache-prefix stability is preserved —
 * only the stage label, the escaped input, and the schema JSON change per turn.
 */
export interface RenderScopingCloseStageParams {
  /** Already-serialised JSON of `{ items: [...] }` for the close turn. */
  readonly learnerInput: string;
  /** Optional inline JSON-schema string for non-strict-mode models. */
  readonly responseSchema?: string;
}

export function renderScopingCloseStage(params: RenderScopingCloseStageParams): string {
  return renderStageEnvelope({
    stage: "close scoping",
    learnerInput: params.learnerInput,
    responseSchema: params.responseSchema,
  });
}
```

**Note on `.and()`:** Zod v4 supports schema intersection via `.and()`. If a later type-check reveals limitations with refinements on intersections, fall back to inlining the base fields directly in `makeScopingCloseSchema` rather than intersecting. Surface this as a PR-description note if it happens.

- [ ] **Step 5: Run tests**

Run: `bunx vitest run src/lib/prompts/scopingClose.test.ts src/lib/prompts/closeTurn.test.ts`
Expected: PASS for both.

- [ ] **Step 6: Commit**

```bash
git add src/lib/prompts/scopingClose.ts src/lib/prompts/scopingClose.test.ts src/lib/prompts/scoping.ts
git commit -m "feat(prompts): scoping-close schema and stage envelope"
```

---

## Task 4: Move internal MC-grading helpers to `submitBaseline.internal.ts`

**Files:**

- Create: `src/lib/course/submitBaseline.internal.ts`
- Modify (later delete): `src/lib/course/gradeBaseline.internal.ts`

- [ ] **Step 1: Copy contents**

Copy `src/lib/course/gradeBaseline.internal.ts` to `src/lib/course/submitBaseline.internal.ts` verbatim. Keep `gradeBaseline.internal.ts` for now — `gradeBaseline.ts` still imports from it. Deletion happens in Task 9 once nothing imports from `gradeBaseline.*`.

- [ ] **Step 2: Adjust the `BaselineAnswer` import**

`submitBaseline.internal.ts` imports `BaselineAnswer` from `./gradeBaseline`. Move the `BaselineAnswer` type to `submitBaseline.ts` (Task 6 will define it there) and update the internal-file import to `./submitBaseline`. For now (so the build stays green during the transition), leave the import as `./gradeBaseline` and revisit when Task 6 lands.

Actually — simpler: define `BaselineAnswer` directly in `submitBaseline.internal.ts` and have both `gradeBaseline.ts` and the future `submitBaseline.ts` import it from there. This collapses the type-circularity.

```ts
// At the top of submitBaseline.internal.ts, REPLACE the import:
import type { McOptionKey } from "@/lib/prompts/questionnaire";

export type BaselineAnswer =
  | { readonly id: string; readonly kind: "mc"; readonly selected: McOptionKey }
  | {
      readonly id: string;
      readonly kind: "freetext";
      readonly text: string;
      readonly fromEscape: boolean;
    };
```

And in `gradeBaseline.ts`, change:

```ts
import { splitOne, ZERO_USAGE } from "./gradeBaseline.internal";
// Original `export type BaselineAnswer = …` line — REMOVE.
// Add:
export type { BaselineAnswer } from "./submitBaseline.internal";
```

This keeps `gradeBaseline.ts` compiling against the moved type without circular imports. The re-export will be deleted alongside `gradeBaseline.ts` in Task 9.

- [ ] **Step 3: Update `gradeMc` and `toEvaluationItem` to carry `conceptTier` through**

The existing `gradeMc` returns a `GradingEntry` matching the (now widened) `baselineGradingSchema`, which requires `conceptTier`. Update:

```ts
export function gradeMc(question: StoredQuestion, selected: McOptionKey): GradingEntry {
  if (question.type !== "multiple_choice") {
    throw new Error(`gradeMc called with free_text question ${question.id}`);
  }
  if (question.conceptName === undefined) {
    throw new Error(`gradeMc: baseline question ${question.id} missing required conceptName`);
  }
  if (question.tier === undefined) {
    throw new Error(`gradeMc: baseline question ${question.id} missing required tier`);
  }
  const isCorrect = selected === question.correct;
  const qualityScore = isCorrect ? MC_CORRECT_QUALITY : MC_INCORRECT_QUALITY;
  const verdict: GradingEntry["verdict"] =
    qualityScore >= PROGRESSION.passingQualityScore ? "correct" : "incorrect";
  return {
    questionId: question.id,
    conceptName: question.conceptName,
    conceptTier: question.tier,
    verdict,
    qualityScore,
    rationale: isCorrect
      ? "Selected the correct option."
      : `Selected ${selected}; correct option was ${question.correct}.`,
  };
}
```

The existing tests on `gradeBaseline.internal.test.ts` (if any) will now fail for missing `conceptTier`. Update them in this step.

- [ ] **Step 4: Run tests**

Run: `bunx vitest run src/lib/course/`
Expected: PASS. `gradeBaseline.ts` still references the v4 `gradeBaselineSchema` from `baselineGrading.ts` for its own LLM call — leave that alone for now; it gets deleted in Task 9.

- [ ] **Step 5: Commit**

```bash
git add src/lib/course/submitBaseline.internal.ts src/lib/course/gradeBaseline.ts
git commit -m "refactor(course): extract MC-grading helpers to submitBaseline.internal"
```

---

## Task 5: Pure `mergeAndComputeXp` function

**Files:**

- Create: `src/lib/course/submitBaseline.merge.ts`
- Create: `src/lib/course/submitBaseline.merge.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/course/submitBaseline.merge.test.ts
import { describe, it, expect } from "vitest";
import { mergeAndComputeXp } from "./submitBaseline.merge";
import { BASELINE } from "@/lib/config/tuning";
import { calculateXP } from "@/lib/scoring/calculateXP";

const llmGrading = (id: string, conceptName: string, conceptTier: number) => ({
  questionId: id,
  conceptName,
  conceptTier,
  verdict: "correct" as const,
  qualityScore: 5,
  rationale: "good",
});

const mcGrading = (id: string, conceptName: string, conceptTier: number) => ({
  questionId: id,
  conceptName,
  conceptTier,
  verdict: "correct" as const,
  qualityScore: BASELINE.mcCorrectQuality,
  rationale: "Selected the correct option.",
});

const baselineQuestions = [
  { id: "b1", conceptName: "ownership", tier: 2 },
  { id: "b2", conceptName: "borrows", tier: 3 },
] as const;

describe("mergeAndComputeXp", () => {
  it("merges LLM and mechanical gradings in canonical question order", () => {
    const merged = mergeAndComputeXp({
      parsed: {
        gradings: [llmGrading("b2", "borrows", 3)],
        startingTier: 2,
      },
      mechanicalGradings: [mcGrading("b1", "ownership", 2)],
      baselineQuestionIds: ["b1", "b2"],
      scopeTiers: [1, 2, 3],
    });
    expect(merged.gradings.map((g) => g.questionId)).toEqual(["b1", "b2"]);
  });

  it("computes totalXp as the sum of calculateXP(startingTier, qualityScore)", () => {
    const merged = mergeAndComputeXp({
      parsed: {
        gradings: [llmGrading("b2", "borrows", 3)],
        startingTier: 2,
      },
      mechanicalGradings: [mcGrading("b1", "ownership", 2)],
      baselineQuestionIds: ["b1", "b2"],
      scopeTiers: [1, 2, 3],
    });
    const expected = calculateXP(2, BASELINE.mcCorrectQuality) + calculateXP(2, 5);
    expect(merged.totalXp).toBe(expected);
  });

  it("throws on startingTier outside scopeTiers (defence-in-depth)", () => {
    expect(() =>
      mergeAndComputeXp({
        parsed: { gradings: [], startingTier: 99 },
        mechanicalGradings: [],
        baselineQuestionIds: [],
        scopeTiers: [1, 2, 3],
      }),
    ).toThrow(/startingTier/);
  });

  it("throws on conceptTier outside scopeTiers", () => {
    expect(() =>
      mergeAndComputeXp({
        parsed: {
          gradings: [llmGrading("b1", "x", 99)],
          startingTier: 2,
        },
        mechanicalGradings: [],
        baselineQuestionIds: ["b1"],
        scopeTiers: [1, 2, 3],
      }),
    ).toThrow(/conceptTier/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/lib/course/submitBaseline.merge.test.ts`
Expected: FAIL — `mergeAndComputeXp` not exported.

- [ ] **Step 3: Implement `submitBaseline.merge.ts`**

```ts
// src/lib/course/submitBaseline.merge.ts
import type { z } from "zod";
import { baselineGradingSchema } from "@/lib/types/jsonb";
import { calculateXP } from "@/lib/scoring/calculateXP";

export type StoredGrading = z.infer<typeof baselineGradingSchema>;

export interface MergeAndComputeXpParams {
  readonly parsed: {
    readonly gradings: readonly StoredGrading[];
    readonly startingTier: number;
  };
  readonly mechanicalGradings: readonly StoredGrading[];
  /** The canonical order — same as `baseline.questions.map(q => q.id)`. */
  readonly baselineQuestionIds: readonly string[];
  readonly scopeTiers: readonly number[];
}

export interface MergeAndComputeXpResult {
  readonly gradings: readonly StoredGrading[];
  readonly totalXp: number;
}

/**
 * Defence-in-depth merge: the LLM schema's superRefine already enforces
 * tier-in-scope, but a second assertion here makes the orchestration
 * fail loud if a future schema regression slips through.
 *
 * Out-of-scope tier values throw — they indicate a bug in the validation
 * path, not a recoverable model error.
 */
export function mergeAndComputeXp(params: MergeAndComputeXpParams): MergeAndComputeXpResult {
  const scope = new Set(params.scopeTiers);

  if (!scope.has(params.parsed.startingTier)) {
    throw new Error(
      `mergeAndComputeXp: startingTier ${params.parsed.startingTier} outside scopeTiers [${[...scope].join(", ")}]`,
    );
  }

  const byId: Record<string, StoredGrading> = {};
  for (const g of params.mechanicalGradings) byId[g.questionId] = g;
  for (const g of params.parsed.gradings) byId[g.questionId] = g;

  const merged = params.baselineQuestionIds.map((qid) => {
    const g = byId[qid];
    if (!g) throw new Error(`mergeAndComputeXp: no grading for questionId ${qid}`);
    if (!scope.has(g.conceptTier)) {
      throw new Error(
        `mergeAndComputeXp: grading for ${qid} has conceptTier ${g.conceptTier} outside scopeTiers`,
      );
    }
    return g;
  });

  const totalXp = merged.reduce(
    (sum, g) => sum + calculateXP(params.parsed.startingTier, g.qualityScore),
    0,
  );

  return { gradings: merged, totalXp };
}
```

- [ ] **Step 4: Verify `calculateXP` import path**

Run: `grep -rn "export.*calculateXP" src/lib/scoring/`
Expected: shows the export. If the path differs, adjust the import.

- [ ] **Step 5: Run test to verify green**

Run: `bunx vitest run src/lib/course/submitBaseline.merge.test.ts`
Expected: PASS (all 4 cases).

- [ ] **Step 6: Commit**

```bash
git add src/lib/course/submitBaseline.merge.ts src/lib/course/submitBaseline.merge.test.ts
git commit -m "feat(course): pure mergeAndComputeXp with defence-in-depth tier assertions"
```

---

## Task 6: Persistence body (`submitBaseline.persist.ts`)

**Files:**

- Create: `src/lib/course/submitBaseline.persist.ts`
- Create: `src/lib/course/submitBaseline.persist.test.ts`

This is an integration test against real Postgres via the testcontainers harness in `src/db/testing/`.

- [ ] **Step 1: Inspect the existing testcontainers harness**

Run: `ls src/db/testing/` and read its CLAUDE.md (if any). Use the same setup helpers as `src/db/queries/courses.integration.test.ts` (e.g. `createTestDb`, fixture builders).

- [ ] **Step 2: Write the failing test**

```ts
// src/lib/course/submitBaseline.persist.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { persistScopingClose } from "./submitBaseline.persist";
import {
  withTestDb, // adjust to match the actual helper exposed by src/db/testing
} from "@/db/testing/withTestDb";
import {
  createCourse,
  getCourseById,
  updateCourseScopingState,
} from "@/db/queries/courses";
import { getConceptsByCourse } from "@/db/queries/concepts";
import { getOpenWaveByCourse } from "@/db/queries/waves";
import { getMessagesForWave } from "@/db/queries/contextMessages";

describe("persistScopingClose (integration)", () => {
  withTestDb();

  it("widens baseline JSONB, upserts concept, creates Wave 1 with openingText, flips status to active", async () => {
    // Arrange: course in scoping with a framework + baseline questions persisted.
    const userId = await /* test-user setup */;
    const course = await createCourse({ userId, topic: "Rust" });
    await updateCourseScopingState(course.id, {
      framework: {
        userMessage: "fw",
        tiers: [{ number: 1, name: "x", description: "y", exampleConcepts: [] }],
        estimatedStartingTier: 1,
        baselineScopeTiers: [1, 2],
      },
      baseline: {
        userMessage: "b",
        questions: [
          {
            id: "b1",
            type: "free_text",
            prompt: "Q",
            freetextRubric: "rubric",
            conceptName: "ownership",
            tier: 2,
          },
        ],
        responses: [{ questionId: "b1", freetext: "ans" }],
        gradings: [],
      },
    });

    // Act: persist the close payload.
    await persistScopingClose({
      courseId: course.id,
      merged: {
        gradings: [
          {
            questionId: "b1",
            conceptName: "ownership",
            conceptTier: 2,
            verdict: "correct",
            qualityScore: 5,
            rationale: "good",
          },
        ],
        totalXp: 50,
      },
      parsed: {
        userMessage: "closing chat msg",
        immutableSummary: "durable profile",
        summary: "evolving",
        startingTier: 2,
        nextUnitBlueprint: {
          topic: "Ownership basics",
          outline: ["a", "b"],
          openingText: "Welcome to lesson 1.",
        },
      },
    });

    // Assert.
    const after = await getCourseById(course.id);
    expect(after.status).toBe("active");
    expect(after.startingTier).toBe(2);
    expect(after.currentTier).toBe(2);
    expect(after.totalXp).toBe(50);
    expect(after.baseline).toMatchObject({
      immutableSummary: "durable profile",
      summarySeed: "evolving",
      startingTier: 2,
    });

    const concepts = await getConceptsByCourse(course.id);
    expect(concepts).toHaveLength(1);
    expect(concepts[0]).toMatchObject({
      name: "ownership",
      tier: 2,
      lastReviewedAt: null,
      nextReviewAt: null,
    });

    const wave1 = await getOpenWaveByCourse(course.id);
    expect(wave1).not.toBeNull();
    expect(wave1!.waveNumber).toBe(1);
    expect(wave1!.seedSource).toMatchObject({
      kind: "scoping_handoff",
      blueprint: { topic: "Ownership basics", openingText: "Welcome to lesson 1." },
    });

    const wave1Messages = await getMessagesForWave(wave1!.id);
    expect(wave1Messages).toHaveLength(1);
    expect(wave1Messages[0]).toMatchObject({
      role: "assistant",
      content: "Welcome to lesson 1.",
      turnIndex: 0,
      seq: 0,
    });
  });

  it("rolls back the whole transaction if the Wave insert fails", async () => {
    // Force a duplicate-wave failure: pre-create an open Wave 1.
    // After persistScopingClose throws, assert course.status is still 'scoping',
    // no concepts exist, no extra wave rows exist.
    // Implementation: open a Wave 1 manually before calling persistScopingClose,
    // then catch the unique-violation error and verify state.
    // …
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `bunx vitest run src/lib/course/submitBaseline.persist.test.ts`
Expected: FAIL — `persistScopingClose` not exported.

- [ ] **Step 4: Implement `submitBaseline.persist.ts`**

```ts
// src/lib/course/submitBaseline.persist.ts
import { db } from "@/db/client";
import { sql } from "drizzle-orm";
import { setCourseStartingState, incrementCourseXp } from "@/db/queries/courses";
import { upsertConcept } from "@/db/queries/concepts";
import { openWave } from "@/db/queries/waves";
import { appendMessage } from "@/db/queries/contextMessages";
import { baselineClosedJsonbSchema, type FrameworkJsonb } from "@/lib/types/jsonb";
import type { ScopingCloseTurn } from "@/lib/prompts/scopingClose";
import type { MergeAndComputeXpResult } from "./submitBaseline.merge";

export interface PersistScopingCloseParams {
  readonly courseId: string;
  readonly parsed: ScopingCloseTurn;
  readonly merged: MergeAndComputeXpResult;
}

/**
 * Single transaction that closes scoping. Order matters: JSONB widen first
 * (preserves the baseline question history); concepts before Wave 1 so
 * `getDueConceptsByCourse` queries against a coherent set; Wave 1 + opening
 * message before status flip so a partial failure doesn't leave an active
 * course without its first lesson; status flip last so an in-flight failure
 * keeps the course retryable.
 *
 * Rollback: a thrown error inside `db.transaction` rolls everything back.
 * Course stays in 'scoping' and the next `submitBaseline` call will re-run
 * the LLM turn (status-gated idempotency at the orchestration layer).
 */
export async function persistScopingClose(params: PersistScopingCloseParams): Promise<{
  readonly wave1Id: string;
}> {
  const { courseId, parsed, merged } = params;

  return db.transaction(async (tx) => {
    // 1. Fetch current course to read baseline questions + framework snapshot.
    const [courseRow] = await tx.execute<{
      baseline: unknown;
      framework: unknown;
    }>(sql`SELECT baseline, framework FROM courses WHERE id = ${courseId}`);
    if (!courseRow?.baseline || !courseRow?.framework) {
      throw new Error(`persistScopingClose: course ${courseId} missing baseline or framework`);
    }
    const existingBaseline = courseRow.baseline as {
      userMessage: string;
      questions: readonly unknown[];
      responses: readonly unknown[];
    };
    const framework = courseRow.framework as FrameworkJsonb;

    // 2. Widen baseline JSONB. Parse before persist (defence-in-depth).
    const widened = baselineClosedJsonbSchema.parse({
      userMessage: existingBaseline.userMessage,
      questions: existingBaseline.questions,
      responses: existingBaseline.responses,
      gradings: merged.gradings,
      immutableSummary: parsed.immutableSummary,
      summarySeed: parsed.summary,
      startingTier: parsed.startingTier,
    });
    await tx.execute(sql`
      UPDATE courses
      SET baseline = ${JSON.stringify(widened)}::jsonb,
          updated_at = NOW()
      WHERE id = ${courseId}
    `);

    // 3. Upsert one concept per distinct conceptName. Default SM-2 fields
    //    (lastReviewedAt = nextReviewAt = NULL) — Pattern B.
    // NOTE: `upsertConcept` uses the top-level `db` singleton, not the `tx`
    // handle. For MVP this is acceptable because submitBaseline is single-user
    // serialised; if we ever need true transactional concept upserts, refactor
    // queries to accept an optional tx. Document in PR.
    const seen = new Set<string>();
    for (const g of merged.gradings) {
      const key = g.conceptName.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      await upsertConcept({
        courseId,
        name: g.conceptName,
        tier: g.conceptTier,
      });
    }

    // 4. Open Wave 1 with seed_source.scoping_handoff carrying the blueprint.
    const wave1 = await openWave({
      courseId,
      waveNumber: 1,
      tier: parsed.startingTier,
      frameworkSnapshot: framework,
      customInstructionsSnapshot: null,
      dueConceptsSnapshot: [],
      seedSource: {
        kind: "scoping_handoff",
        blueprint: parsed.nextUnitBlueprint,
      },
      turnBudget: 10, // WAVE_TURN_COUNT — pull from tuning if exported.
    });

    // 5. Insert one context_messages row for Wave 1 with the assistant
    //    openingText so the learner sees a primed first message.
    await appendMessage({
      parent: { kind: "wave", id: wave1.id },
      turnIndex: 0,
      seq: 0,
      kind: "assistant_response",
      role: "assistant",
      content: parsed.nextUnitBlueprint.openingText,
    });

    // 6. Flip course status; sets summary + starting_tier + current_tier.
    await setCourseStartingState(courseId, {
      initialSummary: parsed.summary,
      startingTier: parsed.startingTier,
      currentTier: parsed.startingTier,
    });

    // 7. Bump total_xp atomically.
    if (merged.totalXp > 0) {
      await incrementCourseXp(courseId, merged.totalXp);
    }

    return { wave1Id: wave1.id };
  });
}
```

**Verify `WAVE_TURN_COUNT` source:** check `src/lib/config/tuning.ts` for the constant. If it lives there, import it instead of hardcoding `10`.

- [ ] **Step 5: Verify `db.transaction` is exposed**

Run: `grep -n "export.*db\|transaction" src/db/client.ts`. If `db.transaction` is the Drizzle method, the snippet above is correct. If a different pattern is used (e.g. an explicit `withTx` helper), adapt.

- [ ] **Step 6: Run integration tests**

Run: `bunx vitest run src/lib/course/submitBaseline.persist.test.ts`
Expected: PASS for happy-path; rollback case may need iteration.

- [ ] **Step 7: Commit**

```bash
git add src/lib/course/submitBaseline.persist.ts src/lib/course/submitBaseline.persist.test.ts
git commit -m "feat(course): transactional persist for scoping close"
```

---

## Task 7: Orchestration (`submitBaseline.ts`)

**Files:**

- Create: `src/lib/course/submitBaseline.ts`
- Create: `src/lib/course/submitBaseline.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/course/submitBaseline.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { submitBaseline } from "./submitBaseline";
import * as executeTurnModule from "@/lib/turn/executeTurn";
import { withTestDb } from "@/db/testing/withTestDb";
import { createCourse, updateCourseScopingState, getCourseById } from "@/db/queries/courses";

describe("submitBaseline (integration)", () => {
  withTestDb();
  beforeEach(() => vi.restoreAllMocks());

  it("runs the close turn, persists everything, returns { userMessage, wave1Id }", async () => {
    const userId = /* test user setup */;
    const course = await createCourse({ userId, topic: "Rust" });
    // Seed framework + baseline questions; see persist.test.ts for fixture shape.
    await updateCourseScopingState(course.id, {
      framework: /* … */,
      baseline: /* … with one free_text question b1 */,
    });

    const spy = vi.spyOn(executeTurnModule, "executeTurn").mockResolvedValue({
      parsed: {
        userMessage: "wrap-up",
        gradings: [
          {
            questionId: "b1",
            conceptName: "ownership",
            conceptTier: 2,
            verdict: "correct",
            qualityScore: 5,
            rationale: "ok",
          },
        ],
        summary: "evolving",
        nextUnitBlueprint: { topic: "T", outline: ["a"], openingText: "hi" },
        immutableSummary: "durable",
        startingTier: 2,
      },
      usage: /* ZERO_USAGE-equivalent */,
    });

    const result = await submitBaseline({
      courseId: course.id,
      userId,
      answers: [{ id: "b1", kind: "freetext", text: "my answer", fromEscape: false }],
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(result.userMessage).toBe("wrap-up");
    expect(result.wave1Id).toBeDefined();

    const after = await getCourseById(course.id);
    expect(after.status).toBe("active");
  });

  it("is idempotent: second call on 'active' course returns same payload, no LLM call", async () => {
    // After the first call's status = 'active', call again with a fresh spy
    // and assert the spy was never called.
  });

  it("throws PRECONDITION_FAILED when answers don't cover every question", async () => {
    // Submit empty answers; expect a tRPC error.
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/lib/course/submitBaseline.test.ts`
Expected: FAIL — `submitBaseline` not exported.

- [ ] **Step 3: Implement `submitBaseline.ts`**

```ts
// src/lib/course/submitBaseline.ts
import { TRPCError } from "@trpc/server";
import { executeTurn } from "@/lib/turn/executeTurn";
import { buildRetryDirective } from "@/lib/turn/retryDirective";
import { getCourseById } from "@/db/queries/courses";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import { getOpenWaveByCourse } from "@/db/queries/waves";
import { makeScopingCloseSchema, renderScopingCloseStage } from "@/lib/prompts/scopingClose";
import { toSchemaJsonString } from "@/lib/llm/toCerebrasJsonSchema";
import { getModelCapabilities } from "@/lib/llm/modelCapabilities";
import { splitOne, type BaselineAnswer } from "./submitBaseline.internal";
import { mergeAndComputeXp } from "./submitBaseline.merge";
import { persistScopingClose } from "./submitBaseline.persist";
import type { BaselineClosedJsonb, FrameworkJsonb } from "@/lib/types/jsonb";

export type { BaselineAnswer } from "./submitBaseline.internal";

export interface SubmitBaselineParams {
  readonly courseId: string;
  readonly userId: string;
  readonly answers: readonly BaselineAnswer[];
}

export interface SubmitBaselineResult {
  readonly userMessage: string;
  readonly wave1Id: string;
}

/**
 * Closing turn of scoping. Drives one append-only LLM call against the
 * existing scoping Context, validates against `makeScopingCloseSchema`, and
 * persists everything atomically. After this resolves, `course.status === 'active'`
 * and Wave 1 is open with its assistant `openingText` already in
 * `context_messages` — no further LLM call needed to open Wave 1.
 */
export async function submitBaseline(params: SubmitBaselineParams): Promise<SubmitBaselineResult> {
  const course = await getCourseById(params.courseId, params.userId);

  // Idempotency: an already-active course returns the persisted payload.
  if (course.status === "active") {
    return buildCachedPayload(course.id, course.baseline);
  }

  if (course.status !== "scoping") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `submitBaseline: course ${course.id} is in status '${course.status}'`,
    });
  }
  if (course.framework === null || course.baseline === null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `submitBaseline: course ${course.id} requires framework and baseline`,
    });
  }

  const baseline = course.baseline;
  if ("startingTier" in baseline) {
    // Shouldn't happen — closed baseline should mean status === 'active'.
    throw new Error(
      `submitBaseline: course ${course.id} has closed baseline but status='${course.status}'`,
    );
  }

  const framework = course.framework as FrameworkJsonb;
  const scopeTiers = framework.baselineScopeTiers;
  const questionIds = baseline.questions.map((q) => q.id);

  // Validate answer coverage.
  const answerIds = new Set(params.answers.map((a) => a.id));
  const missing = questionIds.filter((qid) => !answerIds.has(qid));
  if (missing.length > 0) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `submitBaseline: missing answers for questions ${missing.join(", ")}`,
    });
  }

  // Mechanical MC grading.
  const answerById = Object.fromEntries(params.answers.map((a) => [a.id, a] as const));
  const splits = baseline.questions.map((q) => splitOne(q, answerById[q.id]!));
  const mechanicalGradings = splits.flatMap((s) => (s.kind === "mechanical" ? [s.grading] : []));

  // Build schema closed over runtime constraints.
  const schema = makeScopingCloseSchema({ scopeTiers, questionIds });
  const modelName = process.env.LLM_MODEL ?? "(default)";
  const capabilities = getModelCapabilities(modelName);
  const schemaJson = toSchemaJsonString(schema, { name: "scoping_close" });

  // Open scoping pass (idempotent — re-opens the existing one if present).
  const pass = await ensureOpenScopingPass(course.id);

  // Render the close-turn envelope with the full submitted answer set
  // (including mechanical MC results so the model can see what it doesn't
  // need to re-grade).
  const learnerInput = JSON.stringify({
    answers: params.answers,
    mechanicalGradings,
  });

  const { parsed } = await executeTurn({
    parent: { kind: "scoping", id: pass.id },
    seed: { kind: "scoping", topic: course.topic },
    userMessageContent: renderScopingCloseStage({
      learnerInput,
      responseSchema: capabilities.honorsStrictMode ? undefined : schemaJson,
    }),
    responseSchema: schema,
    responseSchemaName: "scoping_close",
    retryDirective: (err) => buildRetryDirective(err, schemaJson),
    label: "scoping-close",
    successSummary: (p) => `gradings=${p.gradings.length} startingTier=${p.startingTier}`,
  });

  // Defence-in-depth merge + XP.
  const merged = mergeAndComputeXp({
    parsed: { gradings: parsed.gradings, startingTier: parsed.startingTier },
    mechanicalGradings,
    baselineQuestionIds: questionIds,
    scopeTiers,
  });

  // Atomic persist.
  const { wave1Id } = await persistScopingClose({
    courseId: course.id,
    parsed,
    merged,
  });

  return { userMessage: parsed.userMessage, wave1Id };
}

/**
 * Build the cached payload for an already-active course. Idempotent retry path.
 */
async function buildCachedPayload(
  courseId: string,
  baseline:
    | BaselineClosedJsonb
    | {
        /* questions-only — unreachable on 'active' */
      }
    | null,
): Promise<SubmitBaselineResult> {
  if (baseline === null || !("startingTier" in baseline)) {
    throw new Error(`submitBaseline: 'active' course ${courseId} missing closed baseline JSONB`);
  }
  const wave1 = await getOpenWaveByCourse(courseId);
  if (!wave1) {
    throw new Error(`submitBaseline: 'active' course ${courseId} has no open Wave 1`);
  }
  // The closing userMessage is `baseline.userMessage` ONLY if the storage
  // schema is consistent. The widened baselineClosedJsonbSchema preserves
  // the model's closing userMessage in `baseline.userMessage` (overwritten
  // by submitBaseline). If a future change separates them, update here.
  return { userMessage: baseline.userMessage, wave1Id: wave1.id };
}
```

**Note on cached `userMessage`:** the spec preserves the closing `userMessage` by overwriting `baseline.userMessage` during persist. This is intentional — `userMessage` is per-turn framing, and the close turn is the last scoping turn, so its message is the canonical one to replay. If a UI test wants to show both the baseline-presentation message and the closing message, that's a future change requiring a JSONB shape update.

- [ ] **Step 4: Run tests**

Run: `bunx vitest run src/lib/course/submitBaseline.test.ts`
Expected: PASS (all 3 cases).

- [ ] **Step 5: Commit**

```bash
git add src/lib/course/submitBaseline.ts src/lib/course/submitBaseline.test.ts
git commit -m "feat(course): submitBaseline orchestration"
```

---

## Task 8: Mount the router procedure

**Files:**

- Modify: `src/server/routers/course.ts`
- Modify: `src/server/routers/course.integration.test.ts`

- [ ] **Step 1: Write a failing end-to-end test**

In `course.integration.test.ts`, add a case that:

1. Calls `clarify` → `generateFramework` → `generateBaseline` (mocking `executeTurn` for each).
2. Calls `submitBaseline` with answers covering every baseline question.
3. Asserts the return shape `{ userMessage, wave1Id }` and that `getCourseById` shows `status === 'active'`.

```ts
it("completes the full scoping flow via submitBaseline", async () => {
  // … set up mocks for each executeTurn call in sequence …
  const result = await caller.course.submitBaseline({
    courseId,
    answers: [{ id: "b1", kind: "freetext", text: "ans", fromEscape: false }],
  });
  expect(result.wave1Id).toBeDefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bunx vitest run src/server/routers/course.integration.test.ts`
Expected: FAIL — `course.submitBaseline` not defined on the router.

- [ ] **Step 3: Mount the procedure**

In `src/server/routers/course.ts`, add:

```ts
import { submitBaseline } from "@/lib/course/submitBaseline";

// Inside the router({...}) object, add:
  /** Close scoping: grade the baseline, prime Wave 1, flip status to active. */
  submitBaseline: protectedProcedure
    .input(
      z.object({
        courseId: z.string().uuid(),
        answers: z.array(
          z.discriminatedUnion("kind", [
            z.object({
              id: z.string().min(1),
              kind: z.literal("mc"),
              selected: z.enum(["A", "B", "C", "D"]),
            }),
            z.object({
              id: z.string().min(1),
              kind: z.literal("freetext"),
              text: z.string().min(1),
              fromEscape: z.boolean(),
            }),
          ]),
        ).min(1),
      }),
    )
    .mutation(({ ctx, input }) =>
      submitBaseline({
        userId: ctx.userId,
        courseId: input.courseId,
        answers: input.answers,
      }),
    ),
```

- [ ] **Step 4: Run tests**

Run: `bunx vitest run src/server/routers/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/server/routers/course.ts src/server/routers/course.integration.test.ts
git commit -m "feat(router): mount course.submitBaseline mutation"
```

---

## Task 9: Delete dead code

After all tests are green and the router is mounted, remove the superseded files.

- [ ] **Step 1: Confirm nothing imports from the files being deleted**

Run:

```bash
grep -rn "gradeBaseline\b\|baselineGrading\|determineStartingTier" src/ --include="*.ts" --include="*.tsx"
```

Expected output: only the files themselves and their tests. If any other file references them, update that file first (most likely a leftover router import or barrel re-export).

- [ ] **Step 2: Delete the files**

```bash
git rm src/lib/prompts/baselineGrading.ts
git rm src/lib/prompts/baselineGrading.test.ts 2>/dev/null || true
git rm src/lib/course/gradeBaseline.ts
git rm src/lib/course/gradeBaseline.test.ts
git rm src/lib/course/gradeBaseline.internal.ts
git rm src/lib/course/determineStartingTier.ts
git rm src/lib/course/determineStartingTier.test.ts
```

- [ ] **Step 3: Re-confirm green**

Run: `just check`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git commit -m "chore: remove gradeBaseline, baselineGrading, determineStartingTier (superseded by submitBaseline)"
```

---

## Task 10: Update CLAUDE.md files

**Files:**

- Modify: `src/lib/course/CLAUDE.md`
- Modify: `src/lib/prompts/CLAUDE.md`

- [ ] **Step 1: Update `src/lib/course/CLAUDE.md`**

Replace the line about `gradeBaseline` with a line describing submitBaseline:

```markdown
- `submitBaseline` is the scoping-close step: mechanical MC grading first, then one append-only `executeTurn` call against `makeScopingCloseSchema` (extends the shared `makeCloseTurnBaseSchema`), then `persistScopingClose` writes the widened JSONB, upserts concepts (default SM-2 — Pattern B, untaught), opens Wave 1 with `seedSource.scoping_handoff.blueprint`, inserts the assistant `openingText` row, flips status to `active`, and bumps `totalXp` — all in one transaction.
```

- [ ] **Step 2: Update `src/lib/prompts/CLAUDE.md`**

Append a paragraph about the close-turn shared base:

```markdown
- `closeTurn.ts` exports the shared `makeCloseTurnBaseSchema` used by scoping-close and (future) wave-end. Scoping extends it via `scopingClose.ts` with `immutableSummary` + `startingTier`. Wire descriptions use learner-facing vocab (`lesson`, `level`) and directive voice — no developer-meta phrases.
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/course/CLAUDE.md src/lib/prompts/CLAUDE.md
git commit -m "docs: update CLAUDE.md for submitBaseline and shared close-turn base"
```

---

## Task 11: Opt-in live smoke

**Files:**

- Create: `scripts/smoke/scoping-close.ts`

- [ ] **Step 1: Implement the smoke driver**

Mirror an existing smoke script in `scripts/smoke/`. The driver should:

1. Create a course via direct query (skip tRPC auth).
2. Run `clarify` → `generateFramework` → `generateBaseline` against live Cerebras with `CEREBRAS_LIVE=1`.
3. Submit canned answers via `submitBaseline`.
4. Assert: parseable JSON; schema satisfied; `userMessage` and `openingText` non-empty; `startingTier` in `scopeTiers`; gradings cover every question.

Use the existing `just smoke` wiring (`op run` is already injected per `project_just_smoke_op_injected` memory — do not double-wrap).

- [ ] **Step 2: Run the smoke once**

Run: `just smoke scripts/smoke/scoping-close.ts`
Expected: PASS, with the per-turn banner showing the `scoping-close` label and a green ✓ summary.

If it fails on `llama3.1-8b`, treat as a prompt issue (per `feedback_weak_model_means_weak_prompt`): refine the directive `.describe()` text on the failing field, commit, re-run.

- [ ] **Step 3: Commit (only the script)**

```bash
git add scripts/smoke/scoping-close.ts
git commit -m "test(smoke): live scoping-close driver"
```

---

## Task 12: Self-review against the spec

Look at the spec with fresh eyes and check the plan's output against it. Inline checklist:

- [ ] §1 Goal — `submitBaseline` exists; runs one LLM turn; persists everything; flips status to active.
- [ ] §2 Non-goals — confirm nothing in this PR touches Wave teaching, SM-2 review writes, or `determineStartingTier`.
- [ ] §3.1 Append-only — submitBaseline uses `ensureOpenScopingPass` and reuses the same Context; no new system prompt.
- [ ] §3.2 Shared close-turn schema — `closeTurn.ts` exists, exports `makeCloseTurnBaseSchema`, `closeGradingItemSchema`, `blueprintSchema`.
- [ ] §3.3 Wire vocab — `lesson` / `level` appear in field descriptions; `wave` / `tier` do not.
- [ ] §3.4 Emit shape — exactly the fields listed; no `nextStage`, no XP.
- [ ] §3.5 Data model — JSONB widened, no migrations, `seedSource.scoping_handoff` carries blueprint.
- [ ] §3.6 Wave 1 row — created in the same transaction; openingText persisted to `context_messages`.
- [ ] §3.7 Pattern B — concepts get default SM-2 fields (`lastReviewedAt`/`nextReviewAt`/`lastQualityScore` all NULL); assessments deferred (D1).
- [ ] §3.8 XP — `mergeAndComputeXp` uses `calculateXP(startingTier, qualityScore)`; LLM doesn't emit XP.
- [ ] §3.9 Descriptions — present, directive-voice, learner-facing vocab.
- [ ] §4 Lib step — three files (`submitBaseline.ts`, `submitBaseline.persist.ts`, `submitBaseline.internal.ts`) plus `submitBaseline.merge.ts` (D3).
- [ ] §5 Router — `course.submitBaseline` returns `{ userMessage, wave1Id }`.
- [ ] §6 Error handling — preconditions, refine retries, idempotency, rollback all covered.
- [ ] §7 Testing — unit tests for `mergeAndComputeXp`, integration tests for persist and orchestration, smoke for live.
- [ ] §8 Cleanup — deletions complete.
- [ ] §9 Acceptance — `just check` green, `just smoke` green, PR from `feat/submit-baseline`.

If you find a gap, raise it before opening the PR.

- [ ] **Step 1: Run final `just check`**

Run: `just check`
Expected: PASS.

- [ ] **Step 2: Open PR**

Run:

```bash
git push -u origin feat/submit-baseline
gh pr create --title "feat: submitBaseline scoping-close turn" --body "$(cat <<'EOF'
## Summary

- Implements `course.submitBaseline` per `docs/superpowers/specs/2026-05-14-submit-baseline-design.md`.
- One append-only LLM turn closes scoping: grades baseline, emits `startingTier`, durable + cumulative summaries, Wave 1 blueprint.
- Atomic persist: widened baseline JSONB, concept upserts (Pattern B — default SM-2), Wave 1 row + `openingText`, status flip to `active`, XP bump.
- Shared `closeTurn.ts` base schema for future Wave-end reuse.

## Decision points landed (see plan)
- D1: Baseline assessment-table writes **deferred** to TODO; gradings live in JSONB for MVP.
- D2: Concept upserts omit description on baseline.
- D3: `mergeAndComputeXp` in its own sibling file.
- D4: `conceptTier` immutable post-first-sight via existing `ON CONFLICT DO NOTHING`.

## Test plan

- [x] Unit tests for `mergeAndComputeXp`, close-turn refines, scoping-close refines.
- [x] Integration tests for `persistScopingClose` (happy path + rollback) and orchestration (happy path + idempotency + precondition failures).
- [x] End-to-end router test for full scoping flow.
- [x] `just smoke` against live Cerebras llama3.1-8b.
- [x] `just check` green.
EOF
)"
```

---

## Notes for the implementing agent

- **Subagent dispatch:** if executing via `superpowers:subagent-driven-development`, use Opus 4.7 (`opus`) for all implementer and reviewer subagents on this plan. Implementers use red→green TDD; controller verifies green locally (per `feedback_subagent_tdd_and_local_verify`), never defers to CI.
- **Branch, not worktree:** check the impl branch out directly in the main repo (per `feedback_subagent_branches_not_worktrees`); avoid worktree permission friction.
- **Don't echo secrets:** if Cerebras keys are referenced for smoke, use `op read` piped into env or `op run` — never echo the value (per `feedback_secrets_never_in_chat`).
- **Simplification audit at each task:** before adding a new file, ask whether an existing file could absorb it. The plan's three-file split for `submitBaseline.{ts,persist.ts,internal.ts,merge.ts}` is justified by the 200-LOC ceiling, but collapse anything that's actually small enough.
