# Scoping Routers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the three scoping tRPC procedures (`course.clarify`, `course.generateFramework`, `course.generateBaseline`) over a shared `executeTurn` primitive that persists every turn through `context_messages` and includes a self-correction retry loop.

**Architecture:** "Load conversation from DB → render via `renderContext` → call `generateChat` → parse → either persist `assistant_response` and JSONB projection, or persist `failed_assistant_response` + `harness_retry_directive` and loop." Three lib steps, one shared turn primitive, one router. Cache-stable prefix preserved by filtering retry exhaust out of successful turns.

**Tech Stack:** Next.js 16.2, tRPC v11, Drizzle ORM, Zod v4, Vitest, testcontainers Postgres. Uses **bun** (not npm). Pre-commit hooks NEVER bypassed (`--no-verify` is forbidden — see KARPATHY.md, AGENTS.md).

**Reference spec:** `docs/superpowers/specs/2026-05-11-scoping-routers-design.md` — read in full before starting; this plan implements it task-by-task.

---

## Discipline (read before every task)

1. **Simplification bias.** The spec is direction, not contract. Before writing each new file or abstraction, ask: can this collapse into an existing primitive? Can two helpers be one? Can an indirection be inlined? Raise it as a comment in the PR description, then either simplify or document why not. The user has flagged the project trends toward over-engineering; active collapse is welcome.
2. **TDD.** Every task is red → green → commit. Run the failing test before implementation. Verify it fails for the right reason (not a typo).
3. **Test heavily.** The render filter and retry loop are the highest-stakes pieces. Adversarial cases (multi-failure turns, turns where only response is a failure, cache-prefix stability across rendered-then-rerendered scenarios) must all be covered.
4. **Never bypass git hooks.** No `--no-verify`, no `HUSKY=0`, no skipping pre-commit. Fix the underlying issue.
5. **200-LOC ceiling per file.** If a file approaches it, split it before exceeding.
6. **Append to TODO.md, never delete.** Defer-don't-delete unrelated cleanup.
7. **Commit after each task.** Conventional Commits (`feat:`, `refactor:`, `test:`, `chore:`).

---

## File structure (what gets created / modified)

**Create:**

- `src/lib/turn/executeTurn.ts` — shared turn lifecycle primitive.
- `src/lib/turn/executeTurn.test.ts` — unit tests (mocked LLM + DB).
- `src/lib/turn/CLAUDE.md` — directory docs for the new primitive.
- `src/lib/course/parsers.ts` — per-stage parsers (clarify / framework / baseline) + `ValidationGateFailure` factory messages.
- `src/lib/course/parsers.test.ts` — parser unit tests.
- `src/server/routers/course.ts` — three router procedures (one-liners).
- `src/server/routers/course.integration.test.ts` — testcontainers integration tests.
- `src/db/migrations/0004_add_retry_kinds.sql` — drizzle-kit-generated migration.

**Modify:**

- `src/lib/config/tuning.ts` — add `SCOPING` constants block.
- `src/db/schema/contextMessages.ts` — extend `kind` CHECK and TS types.
- `src/db/queries/contextMessages.ts` — add `appendMessages` (plural); extend `AppendMessageParams.kind` union.
- `src/db/queries/contextMessages.integration.test.ts` — cover the plural query and new kinds.
- `src/db/queries/courses.ts` — accept optional `userId` to scope ownership check on `getCourseById`.
- `src/db/queries/courses.integration.test.ts` — cover the scoped lookup.
- `src/db/queries/scopingPasses.ts` — add `ensureOpenScopingPass` helper.
- `src/db/queries/scopingPasses.integration.test.ts` — cover ensure helper.
- `src/lib/llm/renderContext.ts` — per-turn bucketing filter pre-pass.
- `src/lib/llm/renderContext.test.ts` — extend with filter + cache-stability cases.
- `src/lib/course/clarifyTopic.ts` → **rename** to `src/lib/course/clarify.ts`; rewrite contents.
- `src/lib/course/clarifyTopic.test.ts` → **rename** to `src/lib/course/clarify.test.ts`; rewrite.
- `src/lib/course/generateFramework.ts` — rewrite.
- `src/lib/course/generateFramework.test.ts` — rewrite.
- `src/lib/course/generateBaseline.ts` — rewrite (move invariant checks into the parser).
- `src/lib/course/generateBaseline.test.ts` — rewrite.
- `src/lib/types/jsonb.ts` — align `clarificationJsonbSchema`, `frameworkJsonbSchema`, `baselineJsonbSchema` with the prompt-schema outputs OR write translators. See Task 9 decision point.
- `src/server/trpc.ts` — add `protectedProcedure` reading `x-dev-user-id`.
- `src/server/routers/index.ts` — register `course` router.
- `src/lib/prompts/clarification.ts` — remove `buildClarificationPrompt`; keep system-prompt text constant and Zod schema.
- `src/lib/prompts/framework.ts` — remove `buildFrameworkPrompt`, `buildClarificationAssistantMessage`, `buildFrameworkTurnUserContent`; keep `FRAMEWORK_TURN_INSTRUCTIONS` and `frameworkSchema`.
- `src/lib/prompts/baseline.ts` — remove `buildBaselinePrompt`, `buildFrameworkAssistantMessage`, `buildBaselineTurnUserContent`; keep `BASELINE_TURN_INSTRUCTIONS`, `MC_OPTION_KEYS`, `baselineSchema`.
- `src/lib/prompts/index.ts` — prune barrel.
- `src/lib/prompts/clarification.test.ts`, `framework.test.ts`, `baseline.test.ts` — drop tests for removed exports.
- `src/lib/course/CLAUDE.md` — rewrite to reflect new pattern.
- `src/lib/prompts/CLAUDE.md` — clarify scoping prompts now own system text and instruction blocks only.
- `src/lib/llm/CLAUDE.md` — extend Render & parse contract with the filter rule.
- `src/server/routers/CLAUDE.md` — add the wire-shape principle.
- `docs/TODO.md` — append entries (see Task 14).

**Delete:**

- Nothing wholesale. All deletions are localised edits inside files we modify.

**Out-of-scope (do NOT touch):**

- `src/lib/prompts/baselineEvaluation.ts`
- `src/lib/course/gradeBaseline.ts`, `gradeBaseline.internal.ts`, `determineStartingTier.ts` (and their tests)
- `src/lib/llm/parseAssistantResponse.ts` — teaching-specific, untouched this spec
- Wave / teaching files
- Auth (real Supabase Auth + RLS is a separate spec)

---

## Decision points the implementer will hit

These are flagged here so the agent surfaces them rather than silently committing one direction.

### D1. JSONB shape alignment

`courses.{clarification, framework, baseline}` JSONB schemas live in `src/lib/types/jsonb.ts`. Existing shapes:

- `clarificationJsonbSchema`: `{ questions: discriminatedUnion[...], answers: [...] }` — far richer than what the new clarify step produces (`{ questions: string[] }`).
- `frameworkJsonbSchema`: snake_case (`scope_summary`, `estimated_starting_tier`, `baseline_scope_tiers`, `example_concepts`). Prompt-schema `frameworkSchema` is camelCase.
- `baselineJsonbSchema`: `{ questions, answers, gradings }`. Prompt-schema `baselineSchema` is just `{ questions }`.

The two paths:

- **(A) Realign `jsonb.ts` to match prompt-schema outputs** (smaller surface; one source of truth). Affects `renderContext.test.ts` fixtures and `WaveSeedInputs.framework` consumers. Confirm with `just check` after editing.
- **(B) Keep `jsonb.ts` as is; add per-stage `toJsonb(parsed)` translators** in lib steps. Slightly more code, no blast radius on existing tests.

**Recommended:** start with **(A)** for the minimal-complexity bias the user has flagged; if `just check` shows the change has too large a footprint (e.g. wave seed code starts breaking), fall back to **(B)**. Document the choice in the PR description.

### D2. `getCourseById` user-scoping

Current signature is `getCourseById(id)` — no ownership check. The spec calls `getCourseById(input.courseId, ctx.userId)`. Two options:

- Extend `getCourseById` to take optional `userId` and throw `NotFoundError` when set + mismatch (info-leak safe).
- Do the check in the lib step after the unscoped fetch.

Pick the extension — it's the same effective code, but centralised. Add a test.

### D3. Per-turn user message structure

Spec table fixes `userMessageContent`:

- clarify: sanitised topic = `<user_message>Rust</user_message>` (from existing `sanitiseUserInput`).
- generateFramework: `<answers>${JSON.stringify(sanitisedAnswers)}</answers>` — each answer passed through a body-only sanitiser. **DO NOT wrap each answer in `<user_message>` tags** — that would nest tags; only the outer envelope should be tagged. If `sanitiseUserInput` is the only sanitiser available, add a sibling `sanitiseUserInputBody` (returns the escaped body without the `<user_message>` wrap) under `src/lib/security/`.
- generateBaseline: literal `"<request>generate baseline</request>"`.

Confirm `sanitiseUserInput` returns `<user_message>...</user_message>` (it does, per `src/lib/security/sanitiseUserInput.ts`); pick the right helper for each stage.

---

## Task 0: Branch + baseline check (preflight)

**Files:** none.

- [ ] **Step 1: Confirm branch.** This plan implements on a feature branch. Confirm `git status` is clean and the branch name follows convention (e.g. `feat/scoping-routers`). If on `main`, branch:

```bash
git checkout -b feat/scoping-routers
```

- [ ] **Step 2: Verify baseline green.** Before touching code, run the full check matrix.

```bash
just check
```

Expected: typecheck/lint/tests/build all pass against `main`. If any failure, stop and resolve before proceeding.

- [ ] **Step 3: Verify integration suite green.**

```bash
just test-int
```

Expected: all integration tests pass (testcontainers Postgres comes up cleanly).

---

## Task 1: Scoping tunables in `tuning.ts`

**Files:**

- Modify: `src/lib/config/tuning.ts`

We need three constants: max parse retries (the loop bound), max topic input length (Zod input cap), max clarify answers (Zod input cap; must align with `clarifyingQuestionsSchema.max = 4`).

- [ ] **Step 1: Add `SCOPING` block to `tuning.ts`.**

```ts
/**
 * Scoping flow tunables. Bounds for input validation and retry policy
 * during the clarify → framework → baseline pipeline.
 *
 * `maxParseRetries` is the number of *retry* attempts after the first
 * attempt fails — total attempts = maxParseRetries + 1. Default 2 → 3
 * total. Set deliberately low: with well-authored ValidationGateFailure
 * messages, recovery should land on attempt 2 or fail fast.
 *
 * `maxTopicLength` mirrors the upper bound a Postgres `text` column will
 * happily store; the practical reason for capping is to stop pathological
 * pastes from blowing out the system prompt prefix that becomes the cache key.
 *
 * `maxClarifyAnswers` must equal `clarifyingQuestionsSchema.max()` (4) so
 * a learner can answer every question the LLM emitted.
 */
export const SCOPING = {
  maxParseRetries: 2,
  maxTopicLength: 500,
  maxClarifyAnswers: 4,
} as const;
```

- [ ] **Step 2: Confirm `MAX_CLARIFY_ANSWERS` alignment.** Open `src/lib/prompts/clarification.ts` and verify `clarifyingQuestionsSchema` caps `questions.max(4)`. If different, update `SCOPING.maxClarifyAnswers` to match. This invariant is load-bearing — a mismatch lets a learner submit answers past the LLM's question count.

- [ ] **Step 3: Run typecheck.**

```bash
just typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add src/lib/config/tuning.ts
git commit -m "feat(config): add SCOPING tunables for parse retries and input caps"
```

---

## Task 2: Migration — extend `context_messages.kind` CHECK

**Files:**

- Modify: `src/db/schema/contextMessages.ts`
- Create: `src/db/migrations/0004_add_retry_kinds.sql` (drizzle-kit generated)
- Modify: `src/db/migrations/schema.integration.test.ts` (extend with new-kinds case)

Two new kind values: `failed_assistant_response` (model output that failed the parser; `role = 'assistant'`) and `harness_retry_directive` (the harness's error-as-instruction reply; `role = 'user'`).

- [ ] **Step 1: Write the failing schema integration test.**

Open `src/db/migrations/schema.integration.test.ts`. Find the existing `context_messages.kind` CHECK test (search "kind_check"). Append a new test that inserts a `failed_assistant_response` and a `harness_retry_directive` row, asserting both succeed; and inserts a `nonsense_kind` row, asserting failure. The test should reference existing fixtures.

Sketch (adapt to existing test file's helpers — do not invent imports):

```ts
it("context_messages.kind accepts failed_assistant_response and harness_retry_directive", async () => {
  await withTestDb(async (db) => {
    await seedFixtures(db);
    await db.insert(contextMessages).values({
      scopingPassId: SCOPING,
      turnIndex: 0,
      seq: 0,
      kind: "failed_assistant_response",
      role: "assistant",
      content: "<response>oops</response>",
    });
    await db.insert(contextMessages).values({
      scopingPassId: SCOPING,
      turnIndex: 0,
      seq: 1,
      kind: "harness_retry_directive",
      role: "user",
      content: "fix the missing tag",
    });
    const rows = await db
      .select()
      .from(contextMessages)
      .where(eq(contextMessages.scopingPassId, SCOPING));
    expect(rows).toHaveLength(2);
  });
});

it("context_messages.kind rejects unrecognised kinds", async () => {
  await withTestDb(async (db) => {
    await seedFixtures(db);
    await expect(
      db.insert(contextMessages).values({
        scopingPassId: SCOPING,
        turnIndex: 0,
        seq: 0,
        kind: "nonsense_kind",
        role: "user",
        content: "x",
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run the test; verify it fails.**

```bash
just test-int -- src/db/migrations/schema.integration.test.ts
```

Expected: FAIL on the insert with `failed_assistant_response` — the existing CHECK rejects it.

- [ ] **Step 3: Update the schema TS to extend the CHECK list.**

In `src/db/schema/contextMessages.ts`, update the `context_messages_kind_check` constraint:

```ts
check(
  "context_messages_kind_check",
  sql`${t.kind} IN (
    'user_message','card_answer','assistant_response',
    'harness_turn_counter','harness_review_block',
    'failed_assistant_response','harness_retry_directive'
  )`,
),
```

- [ ] **Step 4: Generate the migration.**

```bash
just db-generate add_retry_kinds
```

This produces `src/db/migrations/0004_add_retry_kinds.sql`. Open it and confirm:

- It drops the old CHECK and re-adds it with the seven-kind list, OR uses Postgres `ALTER TABLE ... DROP CONSTRAINT ... ADD CONSTRAINT ...`.
- No unrelated diff.

If the generated SQL looks wrong, fix the schema TS and regenerate. **Do NOT hand-edit migrations** — per `src/db/CLAUDE.md`.

- [ ] **Step 5: Re-run the integration test; verify it passes.**

```bash
just test-int -- src/db/migrations/schema.integration.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/db/schema/contextMessages.ts src/db/migrations/0004_add_retry_kinds.sql src/db/migrations/schema.integration.test.ts
git commit -m "feat(db): extend context_messages.kind with retry persistence values"
```

---

## Task 3: `appendMessages` plural + widen `AppendMessageParams.kind`

**Files:**

- Modify: `src/db/queries/contextMessages.ts`
- Modify: `src/db/queries/contextMessages.integration.test.ts`

We need a single-INSERT batch writer so a turn's rows land atomically. Postgres single-statement INSERT is atomic-by-default; no explicit transaction needed.

- [ ] **Step 1: Write failing integration tests.**

In `src/db/queries/contextMessages.integration.test.ts`, add two tests:

```ts
it("appendMessages inserts a batch atomically, preserving order", async () => {
  await withTestDb(async (db) => {
    await seedFixtures(db);
    await appendMessages([
      {
        parent: { kind: "scoping", id: SCOPING },
        turnIndex: 0,
        seq: 0,
        kind: "user_message",
        role: "user",
        content: "<user_message>Rust</user_message>",
      },
      {
        parent: { kind: "scoping", id: SCOPING },
        turnIndex: 0,
        seq: 1,
        kind: "failed_assistant_response",
        role: "assistant",
        content: "bad",
      },
      {
        parent: { kind: "scoping", id: SCOPING },
        turnIndex: 0,
        seq: 2,
        kind: "harness_retry_directive",
        role: "user",
        content: "fix this",
      },
      {
        parent: { kind: "scoping", id: SCOPING },
        turnIndex: 0,
        seq: 3,
        kind: "assistant_response",
        role: "assistant",
        content: '<response>ok</response><questions>["a","b"]</questions>',
      },
    ]);
    const rows = await getMessagesForScopingPass(SCOPING);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.kind)).toEqual([
      "user_message",
      "failed_assistant_response",
      "harness_retry_directive",
      "assistant_response",
    ]);
  });
});

it("appendMessages rolls back the whole batch if any row violates a constraint", async () => {
  await withTestDb(async (db) => {
    await seedFixtures(db);
    // seq collision against the same turn — partial unique index will reject.
    await appendMessage({
      parent: { kind: "scoping", id: SCOPING },
      turnIndex: 0,
      seq: 0,
      kind: "user_message",
      role: "user",
      content: "x",
    });
    await expect(
      appendMessages([
        {
          parent: { kind: "scoping", id: SCOPING },
          turnIndex: 0,
          seq: 1,
          kind: "assistant_response",
          role: "assistant",
          content: "y",
        },
        {
          parent: { kind: "scoping", id: SCOPING },
          turnIndex: 0,
          seq: 0,
          kind: "user_message",
          role: "user",
          content: "z",
        },
      ]),
    ).rejects.toThrow();
    // Only the original row should remain — no partial insert from the batch.
    const rows = await getMessagesForScopingPass(SCOPING);
    expect(rows).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests; verify they fail.**

```bash
just test-int -- src/db/queries/contextMessages.integration.test.ts
```

Expected: FAIL — `appendMessages` is not exported.

- [ ] **Step 3: Implement `appendMessages` and widen the kind union.**

In `src/db/queries/contextMessages.ts`:

```ts
// Update the kind union on AppendMessageParams to include the two new values.
readonly kind:
  | "user_message"
  | "card_answer"
  | "assistant_response"
  | "harness_turn_counter"
  | "harness_review_block"
  | "failed_assistant_response"
  | "harness_retry_directive";
```

Add the plural query below `appendMessage`:

```ts
/**
 * Atomically append a batch of context messages.
 *
 * Implementation: one multi-VALUES INSERT — Postgres rejects any row that
 * violates a constraint and rolls back the whole statement. No explicit
 * transaction wrapper required; the single-statement guarantee is the
 * atomicity boundary.
 *
 * Use this when a turn produces multiple rows (e.g. user_message +
 * assistant_response, or the full retry trail: user_message +
 * failed_assistant_response + harness_retry_directive + assistant_response).
 */
export async function appendMessages(
  params: readonly AppendMessageParams[],
): Promise<readonly ContextMessage[]> {
  // Spec §3.7 invariant #3: empty batch is a caller bug, not a no-op.
  // Failing loud here prevents executeTurn from silently committing nothing
  // on a degenerate run.
  if (params.length === 0) throw new Error("appendMessages: empty batch");

  const rows = await db
    .insert(contextMessages)
    .values(
      params.map((p) => ({
        waveId: p.parent.kind === "wave" ? p.parent.id : null,
        scopingPassId: p.parent.kind === "scoping" ? p.parent.id : null,
        turnIndex: p.turnIndex,
        seq: p.seq,
        kind: p.kind,
        role: p.role,
        content: p.content,
      })),
    )
    .returning();
  if (rows.length !== params.length) {
    throw new Error(`appendMessages: expected ${params.length} rows returned, got ${rows.length}`);
  }
  return rows;
}
```

- [ ] **Step 4: Re-run integration tests; verify they pass.**

```bash
just test-int -- src/db/queries/contextMessages.integration.test.ts
```

Expected: PASS (both new tests + all existing tests).

- [ ] **Step 5: Commit.**

```bash
git add src/db/queries/contextMessages.ts src/db/queries/contextMessages.integration.test.ts
git commit -m "feat(db): add appendMessages plural query for atomic turn writes"
```

---

## Task 4: User-scoped `getCourseById` + `ensureOpenScopingPass`

**Files:**

- Modify: `src/db/queries/courses.ts`
- Modify: `src/db/queries/courses.integration.test.ts`
- Modify: `src/db/queries/scopingPasses.ts`
- Modify: `src/db/queries/scopingPasses.integration.test.ts`

`getCourseById` is currently unscoped. The router needs ownership-checked lookups (info-leak-safe: wrong owner → `NotFoundError`, not `FORBIDDEN`). And we need a helper that returns the open scoping pass, creating one only if none exists.

- [ ] **Step 1: Write the failing `getCourseById` test.**

In `src/db/queries/courses.integration.test.ts`, append:

```ts
it("getCourseById with a userId scopes ownership: wrong owner → NotFoundError", async () => {
  await withTestDb(async (db) => {
    const ownerId = "11111111-1111-1111-1111-111111111111";
    const intruderId = "22222222-2222-2222-2222-222222222222";
    await db.insert(userProfiles).values({ id: ownerId, displayName: "owner" });
    await db.insert(userProfiles).values({ id: intruderId, displayName: "intruder" });
    const course = await createCourse({ userId: ownerId, topic: "Rust" });

    await expect(getCourseById(course.id, intruderId)).rejects.toBeInstanceOf(NotFoundError);
    // Owner can still read.
    const ok = await getCourseById(course.id, ownerId);
    expect(ok.id).toBe(course.id);
    // Backward-compat: no userId → unscoped read still works.
    const legacy = await getCourseById(course.id);
    expect(legacy.id).toBe(course.id);
  });
});
```

- [ ] **Step 2: Run; verify it fails.**

```bash
just test-int -- src/db/queries/courses.integration.test.ts
```

Expected: FAIL — signature only takes one arg.

- [ ] **Step 3: Extend `getCourseById`.**

In `src/db/queries/courses.ts`:

```ts
/**
 * Fetch a course by primary key; throws `NotFoundError` if absent.
 *
 * When `userId` is supplied, scopes ownership: a row owned by a different
 * user is reported as `NotFoundError` (not `Forbidden`) — info-leak-safe,
 * indistinguishable to a caller from "id does not exist".
 */
export async function getCourseById(id: string, userId?: string): Promise<Course> {
  const [row] = await db.select().from(courses).where(eq(courses.id, id));
  if (!row) throw new NotFoundError("course", id);
  if (userId !== undefined && row.userId !== userId) {
    throw new NotFoundError("course", id);
  }
  return courseRowGuard(row);
}
```

- [ ] **Step 4: Re-run; verify PASS.**

```bash
just test-int -- src/db/queries/courses.integration.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write the failing `ensureOpenScopingPass` test.**

In `src/db/queries/scopingPasses.integration.test.ts`, append:

```ts
it("ensureOpenScopingPass returns the existing open pass on second call", async () => {
  await withTestDb(async (db) => {
    const userId = "33333333-3333-3333-3333-333333333333";
    await db.insert(userProfiles).values({ id: userId, displayName: "u" });
    const [course] = await db.insert(courses).values({ userId, topic: "x" }).returning();
    const first = await ensureOpenScopingPass(course!.id);
    const second = await ensureOpenScopingPass(course!.id);
    expect(second.id).toBe(first.id);
    expect(second.status).toBe("open");
  });
});

it("ensureOpenScopingPass opens a new pass when none exists", async () => {
  await withTestDb(async (db) => {
    const userId = "44444444-4444-4444-4444-444444444444";
    await db.insert(userProfiles).values({ id: userId, displayName: "u" });
    const [course] = await db.insert(courses).values({ userId, topic: "x" }).returning();
    const pass = await ensureOpenScopingPass(course!.id);
    expect(pass.courseId).toBe(course!.id);
    expect(pass.status).toBe("open");
  });
});
```

- [ ] **Step 6: Run; verify failure.**

```bash
just test-int -- src/db/queries/scopingPasses.integration.test.ts
```

Expected: FAIL — `ensureOpenScopingPass` not exported.

- [ ] **Step 7: Implement `ensureOpenScopingPass`.**

In `src/db/queries/scopingPasses.ts`:

```ts
/**
 * Return the open scoping pass for `courseId`, opening one if absent.
 *
 * Idempotent under the single-writer invariant: a re-entrant call returns
 * the same row. The DB UNIQUE constraint on `course_id` is the backstop
 * if two writers ever raced.
 */
export async function ensureOpenScopingPass(courseId: string): Promise<ScopingPass> {
  const existing = await getOpenScopingPassByCourse(courseId);
  if (existing) return existing;
  return openScopingPass(courseId);
}
```

- [ ] **Step 8: Re-run; verify PASS.**

```bash
just test-int -- src/db/queries/scopingPasses.integration.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit.**

```bash
git add src/db/queries/courses.ts src/db/queries/courses.integration.test.ts src/db/queries/scopingPasses.ts src/db/queries/scopingPasses.integration.test.ts
git commit -m "feat(db): user-scope getCourseById and add ensureOpenScopingPass helper"
```

---

## Task 5: `renderContext` per-turn bucketing filter

**Files:**

- Modify: `src/lib/llm/renderContext.ts`
- Modify: `src/lib/llm/renderContext.test.ts`

The filter rule (spec §4.3): group rows by `turn_index`. If a group contains any `assistant_response`, drop all `failed_assistant_response` + `harness_retry_directive` rows in that group. Terminal-exhaust groups (no `assistant_response`) keep everything.

- [ ] **Step 1: Write the failing tests.**

In `src/lib/llm/renderContext.test.ts`, append four cases:

```ts
it("drops failed_assistant_response + harness_retry_directive when their turn ended in assistant_response", () => {
  const messages: readonly ContextMessage[] = [
    mkRow({ turnIndex: 0, seq: 0, content: "u" }),
    mkRow({
      turnIndex: 0,
      seq: 1,
      kind: "failed_assistant_response",
      role: "assistant",
      content: "bad",
    }),
    mkRow({
      turnIndex: 0,
      seq: 2,
      kind: "harness_retry_directive",
      role: "user",
      content: "directive",
    }),
    mkRow({
      turnIndex: 0,
      seq: 3,
      kind: "assistant_response",
      role: "assistant",
      content: "good",
    }),
  ];
  const r = renderContext(SEED, messages);
  // After filter: [user, assistant]. After same-role coalesce: still [user, assistant].
  expect(r.messages).toHaveLength(2);
  expect(r.messages[0]?.role).toBe("user");
  expect(r.messages[0]?.content).toBe("u");
  expect(r.messages[1]?.role).toBe("assistant");
  expect(r.messages[1]?.content).toBe("good");
});

it("keeps every row in a terminal-exhaust turn (no assistant_response)", () => {
  const messages: readonly ContextMessage[] = [
    mkRow({ turnIndex: 0, seq: 0, content: "u" }),
    mkRow({
      turnIndex: 0,
      seq: 1,
      kind: "failed_assistant_response",
      role: "assistant",
      content: "fail-1",
    }),
    mkRow({
      turnIndex: 0,
      seq: 2,
      kind: "harness_retry_directive",
      role: "user",
      content: "directive-1",
    }),
    mkRow({
      turnIndex: 0,
      seq: 3,
      kind: "failed_assistant_response",
      role: "assistant",
      content: "fail-2",
    }),
  ];
  const r = renderContext(SEED, messages);
  // Roles: user, assistant, user, assistant — alternation preserved, no coalesce collapses.
  expect(r.messages).toHaveLength(4);
  expect(r.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
});

it("filter is per-turn: a recovered turn's filter does not affect a terminal-exhaust turn before it", () => {
  const messages: readonly ContextMessage[] = [
    // Turn 0: terminal exhaust (no assistant_response) — must be retained verbatim.
    mkRow({ turnIndex: 0, seq: 0, content: "u0" }),
    mkRow({
      turnIndex: 0,
      seq: 1,
      kind: "failed_assistant_response",
      role: "assistant",
      content: "f0",
    }),
    mkRow({
      turnIndex: 0,
      seq: 2,
      kind: "harness_retry_directive",
      role: "user",
      content: "d0",
    }),
    // Turn 1: retry-then-success — filtered.
    mkRow({ turnIndex: 1, seq: 0, content: "u1" }),
    mkRow({
      turnIndex: 1,
      seq: 1,
      kind: "failed_assistant_response",
      role: "assistant",
      content: "f1",
    }),
    mkRow({
      turnIndex: 1,
      seq: 2,
      kind: "harness_retry_directive",
      role: "user",
      content: "d1",
    }),
    mkRow({
      turnIndex: 1,
      seq: 3,
      kind: "assistant_response",
      role: "assistant",
      content: "ok",
    }),
  ];
  const r = renderContext(SEED, messages);
  // Turn 0 fully retained: u0, f0, d0 (coalesced into runs by role).
  // Turn 1 filtered: u1, ok.
  // After filter, in row order: u0(user), f0(asst), d0(user), u1(user), ok(asst).
  // Coalesce: [u0, d0+u1 coalesced into a single user message, ok].
  // The exact coalesce shape is asserted below.
  expect(r.messages.map((m) => m.role)).toEqual(["user", "assistant", "user", "assistant"]);
  expect(r.messages[0]?.content).toBe("u0");
  expect(r.messages[1]?.content).toBe("f0");
  expect(r.messages[2]?.content).toBe("d0\nu1");
  expect(r.messages[3]?.content).toBe("ok");
});

it("cache-prefix stability: appending a turn after a recovered retry leaves prior turns byte-identical", () => {
  // Turn 0 had a retry-then-success. The rendered output for turn 0 must be
  // unchanged when turn 1 lands on top.
  const turn0Only: readonly ContextMessage[] = [
    mkRow({ turnIndex: 0, seq: 0, content: "u0" }),
    mkRow({
      turnIndex: 0,
      seq: 1,
      kind: "failed_assistant_response",
      role: "assistant",
      content: "f0",
    }),
    mkRow({
      turnIndex: 0,
      seq: 2,
      kind: "harness_retry_directive",
      role: "user",
      content: "d0",
    }),
    mkRow({
      turnIndex: 0,
      seq: 3,
      kind: "assistant_response",
      role: "assistant",
      content: "ok0",
    }),
  ];
  const turn0AndTurn1: readonly ContextMessage[] = [
    ...turn0Only,
    mkRow({ turnIndex: 1, seq: 0, content: "u1" }),
    mkRow({
      turnIndex: 1,
      seq: 1,
      kind: "assistant_response",
      role: "assistant",
      content: "ok1",
    }),
  ];
  const a = renderContext(SEED, turn0Only);
  const b = renderContext(SEED, turn0AndTurn1);
  // System prompt stable.
  expect(b.system).toBe(a.system);
  // First two messages of b == both messages of a — byte-identical prefix.
  expect(b.messages[0]).toEqual(a.messages[0]);
  expect(b.messages[1]).toEqual(a.messages[1]);
});
```

- [ ] **Step 2: Run; verify failures.**

```bash
bun test src/lib/llm/renderContext.test.ts
```

Expected: FAIL on the new tests (filter not implemented).

- [ ] **Step 3: Implement the filter pre-pass.**

In `src/lib/llm/renderContext.ts`, between the system-prompt line and the existing `reduce`:

```ts
export function renderContext(
  seed: SeedInputs,
  messages: readonly ContextMessage[],
): RenderedContext {
  const system = seed.kind === "wave" ? renderTeachingSystem(seed) : renderScopingSystem(seed);

  // Per-turn bucketing filter (spec §4.3):
  //   group rows by turn_index; if a group contains assistant_response,
  //   drop failed_assistant_response + harness_retry_directive within
  //   that group. Terminal-exhaust groups keep everything.
  //
  // The reduce-into-Map preserves first-seen ordering of turn_index keys
  // (which is the natural insertion order since rows are pre-sorted by
  // (turn_index, seq) at the query layer).
  const groups = messages.reduce<ReadonlyMap<number, readonly ContextMessage[]>>((acc, row) => {
    const list = acc.get(row.turnIndex) ?? [];
    return new Map(acc).set(row.turnIndex, [...list, row]);
  }, new Map());

  const filtered: readonly ContextMessage[] = Array.from(groups.values()).flatMap((group) => {
    const hasSuccess = group.some((r) => r.kind === "assistant_response");
    if (!hasSuccess) return group;
    return group.filter(
      (r) => r.kind !== "failed_assistant_response" && r.kind !== "harness_retry_directive",
    );
  });

  // Same-role coalescing fold (unchanged from prior version).
  const out = filtered.reduce<readonly LlmRenderedMessage[]>((acc, row) => {
    if (row.role === "system") return acc;
    const last = acc[acc.length - 1];
    if (last && last.role === row.role) {
      return [...acc.slice(0, -1), { role: last.role, content: `${last.content}\n${row.content}` }];
    }
    return [...acc, { role: row.role as LlmRenderedMessage["role"], content: row.content }];
  }, []);

  return { system, messages: out };
}
```

Also update the top-of-file TSDoc to describe the filter rule alongside the same-role coalescing. Specifically, add a paragraph:

```
 * Per-turn retry filter — IMPORTANT: rows are grouped by `turn_index`
 * before coalescing. Within each group: if any row is `assistant_response`,
 * `failed_assistant_response` + `harness_retry_directive` rows in that
 * group are dropped (they were intermediate retry exhaust; the LLM doesn't
 * need to see them once the turn recovered). Terminal-exhaust groups
 * (no `assistant_response`) keep every row so the model can see the
 * failure context on re-attempt. This filter preserves cache-prefix
 * stability across successful turns: a recovered turn always renders to
 * the same bytes as a non-retry turn would have.
```

- [ ] **Step 4: Re-run; verify all tests pass.**

```bash
bun test src/lib/llm/renderContext.test.ts
```

Expected: PASS — both new tests and all existing tests.

- [ ] **Step 5: Run full check.**

```bash
just check
```

Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git add src/lib/llm/renderContext.ts src/lib/llm/renderContext.test.ts
git commit -m "feat(llm): filter retry exhaust from successful turns in renderContext"
```

---

## Task 6: `protectedProcedure` dev-stub auth

**Files:**

- Modify: `src/server/trpc.ts`

Reads `x-dev-user-id` header; throws `UNAUTHORIZED` if absent; injects `ctx.userId`.

- [ ] **Step 1: Extend `createTRPCContext` and add `protectedProcedure`.**

```ts
import { initTRPC, TRPCError } from "@trpc/server";
import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";

/**
 * Build the tRPC request context. Dev-stub auth: reads `x-dev-user-id`
 * from the incoming headers and exposes it as `userId` (possibly undefined).
 * Real Supabase Auth lands in a follow-up spec; the seam stays in this
 * function so the swap is local.
 */
export const createTRPCContext = async (opts: FetchCreateContextFnOptions) => {
  // headers.get is the Web Fetch API surface — lowercase keys; tRPC-fetch
  // gives us a `Headers` object directly.
  const devUserId = opts.req.headers.get("x-dev-user-id") ?? undefined;
  return { userId: devUserId };
};

const t = initTRPC.context<typeof createTRPCContext>().create();

export const router = t.router;
export const publicProcedure = t.procedure;

/**
 * Authenticated procedure. Requires `x-dev-user-id` to be set on the
 * request. Once real auth lands, the body of this middleware swaps to
 * Supabase session resolution; call sites stay unchanged.
 */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "missing x-dev-user-id header" });
  }
  return next({ ctx: { ...ctx, userId: ctx.userId } });
});
```

- [ ] **Step 2: Confirm the existing `createTRPCContext` callers compile.**

Search for callers:

```bash
grep -rn "createTRPCContext" src/ 2>/dev/null
```

If any existing call site doesn't pass `FetchCreateContextFnOptions`, that means the tRPC fetch adapter isn't wired yet — in that case, scale the change back: keep `createTRPCContext` with a no-arg signature plus a parallel `createTRPCContextFromHeaders(headers: Headers)` for the route handler to call, and have the route handler do the wiring. Pick whichever requires the smaller diff.

- [ ] **Step 3: Run typecheck.**

```bash
just typecheck
```

Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add src/server/trpc.ts
git commit -m "feat(trpc): add protectedProcedure with x-dev-user-id dev-stub auth"
```

---

## Task 7: Per-stage parsers + `ValidationGateFailure`

**Files:**

- Create: `src/lib/course/parsers.ts`
- Create: `src/lib/course/parsers.test.ts`

Each parser: `(raw: string) => Parsed`, throws `ValidationGateFailure` on any failure mode with a message written for the LLM to read as a retry directive. **The error message IS the retry directive** (spec §3.7 invariant #4).

Reuse `ValidationGateFailure` from `src/lib/llm/parseAssistantResponse.ts` (already exists; export remains there).

- [ ] **Step 1: Write failing parser tests.**

In `src/lib/course/parsers.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { ValidationGateFailure } from "@/lib/llm/parseAssistantResponse";
import { parseClarifyResponse, parseFrameworkResponse, parseBaselineResponse } from "./parsers";

describe("parseClarifyResponse", () => {
  it("returns questions when <questions> contains a valid JSON array", () => {
    const raw = `<response>asking some questions</response><questions>["Beginner?","Goal?"]</questions>`;
    const r = parseClarifyResponse(raw);
    expect(r.questions).toEqual(["Beginner?", "Goal?"]);
    expect(r.raw).toBe(raw);
  });

  it("throws when <questions> tag is missing", () => {
    const raw = `<response>oops</response>`;
    expect(() => parseClarifyResponse(raw)).toThrow(ValidationGateFailure);
    try {
      parseClarifyResponse(raw);
    } catch (e) {
      const err = e as ValidationGateFailure;
      // Error message must read like a retry directive (load-bearing).
      expect(err.message).toMatch(/<questions>/);
      expect(err.message).toMatch(/required/i);
    }
  });

  it("throws when <questions> JSON is malformed", () => {
    const raw = `<response>x</response><questions>[not json}</questions>`;
    expect(() => parseClarifyResponse(raw)).toThrow(ValidationGateFailure);
  });

  it("throws when <questions> array is empty", () => {
    const raw = `<response>x</response><questions>[]</questions>`;
    expect(() => parseClarifyResponse(raw)).toThrow(ValidationGateFailure);
  });

  it("throws when <questions> contains a non-string entry", () => {
    const raw = `<response>x</response><questions>["a",42]</questions>`;
    expect(() => parseClarifyResponse(raw)).toThrow(ValidationGateFailure);
  });
});

describe("parseFrameworkResponse", () => {
  const valid = {
    tiers: [
      { number: 1, name: "Basics", description: "d", exampleConcepts: ["e1", "e2", "e3", "e4"] },
      { number: 2, name: "Inter", description: "d", exampleConcepts: ["e1", "e2", "e3", "e4"] },
      { number: 3, name: "Adv", description: "d", exampleConcepts: ["e1", "e2", "e3", "e4"] },
    ],
    estimatedStartingTier: 2,
    baselineScopeTiers: [1, 2, 3],
  };

  it("returns framework on valid payload", () => {
    const raw = `<response>here</response><framework>${JSON.stringify(valid)}</framework>`;
    const r = parseFrameworkResponse(raw);
    expect(r.framework.tiers).toHaveLength(3);
  });

  it("throws when <framework> tag missing", () => {
    expect(() => parseFrameworkResponse(`<response>x</response>`)).toThrow(ValidationGateFailure);
  });

  it("throws with a directive that names the broken constraint", () => {
    const broken = { ...valid, tiers: valid.tiers.slice(0, 2) }; // < minTiers
    const raw = `<response>x</response><framework>${JSON.stringify(broken)}</framework>`;
    try {
      parseFrameworkResponse(raw);
      throw new Error("expected throw");
    } catch (e) {
      const err = e as ValidationGateFailure;
      expect(err).toBeInstanceOf(ValidationGateFailure);
      // Directive should mention tiers / minimum so the LLM can self-correct.
      expect(err.message.toLowerCase()).toMatch(/tier/);
    }
  });
});

describe("parseBaselineResponse", () => {
  it("throws when <baseline> tag missing", () => {
    expect(() => parseBaselineResponse(`<response>x</response>`, { scopeTiers: [1, 2] })).toThrow(
      ValidationGateFailure,
    );
  });

  it("throws when a question's tier is outside scope", () => {
    const payload = {
      questions: [
        // Tier 9 is outside scope [1, 2].
        {
          id: "b1",
          tier: 9,
          conceptName: "x",
          type: "free_text",
          question: "?",
          freetextRubric: "r",
        },
        // Pad to meet schema min/max question counts; for this test we accept the
        // throw on the out-of-scope check, so the schema may also reject — either
        // throw is fine, both throw ValidationGateFailure.
      ],
    };
    const raw = `<response>x</response><baseline>${JSON.stringify(payload)}</baseline>`;
    expect(() => parseBaselineResponse(raw, { scopeTiers: [1, 2] })).toThrow(ValidationGateFailure);
  });
});
```

- [ ] **Step 2: Run; verify failures.**

```bash
bun test src/lib/course/parsers.test.ts
```

Expected: FAIL (file does not exist).

- [ ] **Step 3: Implement `parsers.ts`.**

```ts
import { z } from "zod/v4";
import { extractTag } from "@/lib/llm/extractTag";
import { ValidationGateFailure } from "@/lib/llm/parseAssistantResponse";
import {
  baselineSchema,
  frameworkSchema,
  type BaselineAssessment,
  type Framework,
} from "@/lib/prompts";

/**
 * Per-stage parsers for scoping turns (spec §3.3).
 *
 * Each parser inspects the raw LLM output and either returns the validated
 * payload or throws `ValidationGateFailure` with a message authored to be
 * piped back to the model verbatim as the retry directive. The error
 * message is load-bearing — phrase it the way a teacher would, naming the
 * specific tag and the specific constraint.
 */

export interface ParsedClarifyResponse {
  readonly questions: readonly string[];
  readonly raw: string;
}
export interface ParsedFrameworkResponse {
  readonly framework: Framework;
  readonly raw: string;
}
export interface ParsedBaselineResponse {
  readonly baseline: BaselineAssessment;
  readonly raw: string;
}

const clarifyQuestionsSchema = z.array(z.string().min(1).max(300)).min(2).max(4);

export function parseClarifyResponse(raw: string): ParsedClarifyResponse {
  const tag = extractTag(raw, "questions");
  if (tag === null) {
    throw new ValidationGateFailure(
      "missing_response",
      `Your response was missing the required <questions>[...]</questions> tag. ` +
        `Reply with the full clarifying-questions payload inside <questions>...</questions> ` +
        `containing a JSON array of 2 to 4 short question strings. Keep the rest of your ` +
        `<response>...</response> prose.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(tag);
  } catch {
    throw new ValidationGateFailure(
      "missing_response",
      `The contents of <questions> were not valid JSON. Reply with a corrected ` +
        `<questions>[...]</questions> payload — a JSON array of 2 to 4 short question strings.`,
    );
  }
  const safe = clarifyQuestionsSchema.safeParse(parsed);
  if (!safe.success) {
    throw new ValidationGateFailure(
      "missing_response",
      `Your <questions> payload failed validation: ${safe.error.message}. ` +
        `Reply with a corrected <questions>[...]</questions> array of 2 to 4 non-empty strings.`,
    );
  }
  return { questions: safe.data, raw };
}

export function parseFrameworkResponse(raw: string): ParsedFrameworkResponse {
  const tag = extractTag(raw, "framework");
  if (tag === null) {
    throw new ValidationGateFailure(
      "missing_response",
      `Your response was missing the required <framework>{...}</framework> tag. ` +
        `Reply with the full framework JSON inside <framework>...</framework>. The rest of ` +
        `your <response>...</response> prose is fine.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(tag);
  } catch {
    throw new ValidationGateFailure(
      "missing_response",
      `The contents of <framework> were not valid JSON. Reply with a corrected ` +
        `<framework>{...}</framework> payload matching the schema you were given.`,
    );
  }
  const safe = frameworkSchema.safeParse(parsed);
  if (!safe.success) {
    throw new ValidationGateFailure(
      "missing_response",
      `Your <framework> payload failed validation: ${safe.error.message}. ` +
        `Re-emit a corrected <framework>{...}</framework> payload that satisfies every ` +
        `constraint named above. Pay particular attention to the tiers field if it appears ` +
        `in the error.`,
    );
  }
  return { framework: safe.data, raw };
}

export interface ParseBaselineOptions {
  readonly scopeTiers: readonly number[];
}

export function parseBaselineResponse(
  raw: string,
  opts: ParseBaselineOptions,
): ParsedBaselineResponse {
  const tag = extractTag(raw, "baseline");
  if (tag === null) {
    throw new ValidationGateFailure(
      "missing_response",
      `Your response was missing the required <baseline>{...}</baseline> tag. ` +
        `Reply with the full baseline-assessment JSON inside <baseline>...</baseline>.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(tag);
  } catch {
    throw new ValidationGateFailure(
      "missing_response",
      `The contents of <baseline> were not valid JSON. Reply with a corrected ` +
        `<baseline>{...}</baseline> payload matching the schema you were given.`,
    );
  }
  const safe = baselineSchema.safeParse(parsed);
  if (!safe.success) {
    throw new ValidationGateFailure(
      "missing_response",
      `Your <baseline> payload failed schema validation: ${safe.error.message}. ` +
        `Re-emit a corrected <baseline>{...}</baseline>.`,
    );
  }
  // Orchestrator-level invariants (moved out of the prior lib step).
  const outOfScope = safe.data.questions.filter((q) => !opts.scopeTiers.includes(q.tier));
  if (outOfScope.length > 0) {
    const ids = outOfScope.map((q) => `${q.id}(tier=${q.tier})`).join(", ");
    throw new ValidationGateFailure(
      "missing_response",
      `Your baseline questions reference tiers outside the requested scope [${opts.scopeTiers.join(", ")}]. ` +
        `Offending questions: ${ids}. Every question's tier must be one of the scope numbers. ` +
        `Re-emit <baseline>{...}</baseline> with all questions inside the scope.`,
    );
  }
  // Functional duplicate scan (matches old generateBaseline.ts style).
  const ids = safe.data.questions.map((q) => q.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dupes.length > 0) {
    throw new ValidationGateFailure(
      "missing_response",
      `Your baseline questions have duplicate ids: ${dupes.join(", ")}. ` +
        `Every question id must be unique (e.g. b1, b2, b3, ...). ` +
        `Re-emit <baseline>{...}</baseline> with unique ids.`,
    );
  }
  return { baseline: safe.data, raw };
}
```

- [ ] **Step 4: Re-run; verify PASS.**

```bash
bun test src/lib/course/parsers.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/course/parsers.ts src/lib/course/parsers.test.ts
git commit -m "feat(course): add per-stage parsers throwing retry-directive errors"
```

---

## Task 8: `executeTurn` primitive

**Files:**

- Create: `src/lib/turn/executeTurn.ts`
- Create: `src/lib/turn/executeTurn.test.ts`
- Create: `src/lib/turn/CLAUDE.md`

The shared per-turn loop. The signature from the spec:

```ts
executeTurn<T>({
  parent: ContextParent,
  seed: SeedInputs,
  userMessageContent: string,
  parser: (raw: string) => T,
  retryDirective?: (err: ValidationGateFailure, attempt: number) => string,
}): Promise<{ parsed: T; usage: LlmUsage }>
```

**Simplification note.** The spec lists `retryDirective` as a parameter, but the parsers already produce model-readable error messages (Task 7). The simplest design lets `executeTurn` pass `err.detail` (or `err.message`) straight through. Make `retryDirective` optional with a default of `(err) => err.detail`. The user has flagged simplification as a priority — collapse this indirection unless you find a reason to differentiate.

- [ ] **Step 1: Write failing tests.**

In `src/lib/turn/executeTurn.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ValidationGateFailure } from "@/lib/llm/parseAssistantResponse";
import { executeTurn } from "./executeTurn";

// Wire mocks for the dependencies executeTurn touches. Test isolates the
// loop logic — DB and LLM calls are replaced with controllable spies.
vi.mock("@/lib/llm/generate", () => ({
  generateChat: vi.fn(),
}));
vi.mock("@/db/queries/contextMessages", () => ({
  appendMessages: vi.fn(),
  getMessagesForWave: vi.fn(),
  getMessagesForScopingPass: vi.fn(),
  getNextTurnIndex: vi.fn(),
}));

import { generateChat } from "@/lib/llm/generate";
import {
  appendMessages,
  getMessagesForScopingPass,
  getNextTurnIndex,
} from "@/db/queries/contextMessages";

const SCOPING_ID = "00000000-0000-0000-0000-000000000601";
const SEED = { kind: "scoping" as const, topic: "Rust" };
const FAKE_USAGE = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

beforeEach(() => {
  vi.mocked(generateChat).mockReset();
  vi.mocked(appendMessages).mockReset();
  vi.mocked(getMessagesForScopingPass).mockReset();
  vi.mocked(getNextTurnIndex).mockReset();
  vi.mocked(getMessagesForScopingPass).mockResolvedValue([]);
  vi.mocked(getNextTurnIndex).mockResolvedValue(0);
  vi.mocked(appendMessages).mockResolvedValue([]);
});

describe("executeTurn", () => {
  it("happy path: parser succeeds on first attempt, writes user + assistant rows", async () => {
    vi.mocked(generateChat).mockResolvedValueOnce({ text: "OK_RAW", usage: FAKE_USAGE });
    const parser = vi.fn((raw: string) => ({ value: raw }));
    const result = await executeTurn({
      parent: { kind: "scoping", id: SCOPING_ID },
      seed: SEED,
      userMessageContent: "hello",
      parser,
    });
    expect(result.parsed).toEqual({ value: "OK_RAW" });
    expect(result.usage).toEqual(FAKE_USAGE);
    expect(parser).toHaveBeenCalledOnce();
    // Two-row batch: user_message@seq=0, assistant_response@seq=1.
    expect(appendMessages).toHaveBeenCalledOnce();
    const batch = vi.mocked(appendMessages).mock.calls[0]![0];
    expect(batch).toHaveLength(2);
    expect(batch[0]!.kind).toBe("user_message");
    expect(batch[1]!.kind).toBe("assistant_response");
  });

  it("retry-then-success: persists failed + directive + success rows in one batch", async () => {
    vi.mocked(generateChat)
      .mockResolvedValueOnce({ text: "BAD_RAW", usage: FAKE_USAGE })
      .mockResolvedValueOnce({ text: "GOOD_RAW", usage: FAKE_USAGE });
    const parser = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new ValidationGateFailure("missing_response", "fix the thing");
      })
      .mockImplementationOnce((raw: string) => ({ value: raw }));
    const r = await executeTurn({
      parent: { kind: "scoping", id: SCOPING_ID },
      seed: SEED,
      userMessageContent: "hi",
      parser,
    });
    expect(r.parsed).toEqual({ value: "GOOD_RAW" });
    expect(parser).toHaveBeenCalledTimes(2);
    const batch = vi.mocked(appendMessages).mock.calls[0]![0];
    // Expected sequence: user@0, failed@1, directive@2, success@3.
    expect(batch.map((b) => b.kind)).toEqual([
      "user_message",
      "failed_assistant_response",
      "harness_retry_directive",
      "assistant_response",
    ]);
    // Directive row content should contain the parser's error detail.
    expect(batch[2]!.content).toContain("fix the thing");
  });

  it("terminal exhaust: persists failure trail and throws ValidationGateFailure", async () => {
    vi.mocked(generateChat).mockResolvedValue({ text: "BAD_RAW", usage: FAKE_USAGE });
    const parser = vi.fn().mockImplementation(() => {
      throw new ValidationGateFailure("missing_response", "still broken");
    });
    await expect(
      executeTurn({
        parent: { kind: "scoping", id: SCOPING_ID },
        seed: SEED,
        userMessageContent: "hi",
        parser,
      }),
    ).rejects.toBeInstanceOf(ValidationGateFailure);
    // With MAX_PARSE_RETRIES=2, expect 3 total attempts; persisted batch:
    // user@0, failed@1, directive@2, failed@3, directive@4, failed@5
    const batch = vi.mocked(appendMessages).mock.calls[0]![0];
    expect(batch.map((b) => b.kind)).toEqual([
      "user_message",
      "failed_assistant_response",
      "harness_retry_directive",
      "failed_assistant_response",
      "harness_retry_directive",
      "failed_assistant_response",
    ]);
  });

  it("transport error mid-loop: propagates without persisting", async () => {
    vi.mocked(generateChat).mockRejectedValueOnce(new Error("LLM 503"));
    const parser = vi.fn();
    await expect(
      executeTurn({
        parent: { kind: "scoping", id: SCOPING_ID },
        seed: SEED,
        userMessageContent: "hi",
        parser,
      }),
    ).rejects.toThrow("LLM 503");
    expect(appendMessages).not.toHaveBeenCalled();
    expect(parser).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run; verify failures.**

```bash
bun test src/lib/turn/executeTurn.test.ts
```

Expected: FAIL — file does not exist.

- [ ] **Step 3: Implement `executeTurn`.**

```ts
import {
  appendMessages,
  getMessagesForScopingPass,
  getMessagesForWave,
  getNextTurnIndex,
  type AppendMessageParams,
  type ContextParent,
} from "@/db/queries/contextMessages";
import { generateChat } from "@/lib/llm/generate";
import { ValidationGateFailure } from "@/lib/llm/parseAssistantResponse";
import { renderContext } from "@/lib/llm/renderContext";
import { SCOPING } from "@/lib/config/tuning";
import type { LlmUsage } from "@/lib/types/llm";
import type { SeedInputs } from "@/lib/types/context";

/**
 * Stage-agnostic per-turn lifecycle (spec §3.3).
 *
 * Loads prior context, sends user message + retries, persists one atomic
 * row batch per turn. Parser throws `ValidationGateFailure` on parse-fail;
 * the loop turns that into a `harness_retry_directive` row and retries.
 *
 * `retryDirective` defaults to `err.detail` since per-stage parsers in
 * `src/lib/course/parsers.ts` already author model-readable error
 * messages. Callers can override if they want different directive
 * content per attempt index (rarely needed in practice).
 *
 * Transport errors propagate untouched — nothing is persisted (the batch
 * never commits). A user retry creates a fresh `turn_index`.
 */
export interface ExecuteTurnParams<T> {
  readonly parent: ContextParent;
  readonly seed: SeedInputs;
  readonly userMessageContent: string;
  readonly parser: (raw: string) => T;
  readonly retryDirective?: (err: ValidationGateFailure, attempt: number) => string;
}

export interface ExecuteTurnResult<T> {
  readonly parsed: T;
  readonly usage: LlmUsage;
}

export async function executeTurn<T>(params: ExecuteTurnParams<T>): Promise<ExecuteTurnResult<T>> {
  const turnIndex = await getNextTurnIndex(params.parent);
  const priorRows =
    params.parent.kind === "wave"
      ? await getMessagesForWave(params.parent.id)
      : await getMessagesForScopingPass(params.parent.id);

  // In-memory rows for *this* turn. Built up as the loop produces them.
  // Persisted at the end (success or exhaust) as one atomic batch.
  const userRow: AppendMessageParams = {
    parent: params.parent,
    turnIndex,
    seq: 0,
    kind: "user_message",
    role: "user",
    content: params.userMessageContent,
  };
  // Start with the user row; each retry appends failed+directive; success
  // appends the assistant_response and we commit.
  let batch: readonly AppendMessageParams[] = [userRow];

  // Synthetic ContextMessage rows for rendering — turn this batch into the
  // shape renderContext expects. We don't need real ids/timestamps since
  // renderContext only reads `kind`, `role`, `turnIndex`, `content`.
  // Use a tiny adapter; fields outside what's used are filled with placeholders.
  const totalAttempts = SCOPING.maxParseRetries + 1;
  const directiveFn = params.retryDirective ?? ((err) => err.detail);

  // Each attempt: render → call LLM → parse → branch.
  // Use a recursive helper to avoid mutable loop state under
  // eslint-plugin-functional. Tail-position recursion bounded by
  // SCOPING.maxParseRetries + 1 — at most 3 stack frames in MVP.
  return attempt(0);

  async function attempt(i: number): Promise<ExecuteTurnResult<T>> {
    const renderable = synthesiseRows([...priorRows], batch);
    const rendered = renderContext(params.seed, renderable);
    const result = await generateChat([
      { role: "system", content: rendered.system },
      ...rendered.messages,
    ]);
    try {
      const parsed = params.parser(result.text);
      const successRow: AppendMessageParams = {
        parent: params.parent,
        turnIndex,
        seq: batch.length,
        kind: "assistant_response",
        role: "assistant",
        content: result.text,
      };
      const finalBatch = [...batch, successRow];
      await appendMessages(finalBatch);
      return { parsed, usage: result.usage };
    } catch (err) {
      if (!(err instanceof ValidationGateFailure)) throw err;
      const failedRow: AppendMessageParams = {
        parent: params.parent,
        turnIndex,
        seq: batch.length,
        kind: "failed_assistant_response",
        role: "assistant",
        content: result.text,
      };
      if (i + 1 >= totalAttempts) {
        // Terminal exhaust: persist failure (without directive — caller's
        // re-submit will produce the next user_message which provides
        // recovery context to the model).
        const finalBatch = [...batch, failedRow];
        await appendMessages(finalBatch);
        throw err;
      }
      const directiveRow: AppendMessageParams = {
        parent: params.parent,
        turnIndex,
        seq: batch.length + 1,
        kind: "harness_retry_directive",
        role: "user",
        content: directiveFn(err, i + 1),
      };
      batch = [...batch, failedRow, directiveRow];
      return attempt(i + 1);
    }
  }
}

/**
 * Build a renderable row list from prior DB rows + the in-memory batch
 * we're growing this turn. `renderContext` only needs `turnIndex`, `seq`,
 * `kind`, `role`, `content` — the rest of `ContextMessage` is filled with
 * inert placeholders so the type checks.
 *
 * Note: we deliberately include both prior rows and the in-memory batch
 * so the LLM sees the failed attempts within *this* turn during retries.
 * The per-turn filter in renderContext will drop them only if/when the
 * turn ends in `assistant_response` — which it won't until the loop exits.
 */
function synthesiseRows(
  prior: readonly { turnIndex: number; seq: number; kind: string; role: string; content: string }[],
  batch: readonly AppendMessageParams[],
): readonly Parameters<typeof renderContext>[1][number][] {
  // Cast: prior rows are already ContextMessage; batch rows synthesised below.
  const batchAsRows = batch.map(
    (b, i) =>
      ({
        id: `synthetic-${i}`,
        waveId: b.parent.kind === "wave" ? b.parent.id : null,
        scopingPassId: b.parent.kind === "scoping" ? b.parent.id : null,
        turnIndex: b.turnIndex,
        seq: b.seq,
        kind: b.kind,
        role: b.role,
        content: b.content,
        createdAt: new Date(0),
      }) as Parameters<typeof renderContext>[1][number],
  );
  return [...prior, ...batchAsRows];
}

// Failed terminal exhaust intentionally drops the trailing directive (no
// recovery context — the user's re-submit creates a fresh turn). See spec
// §5.1 "Terminal exhaust path".
```

**Note on `attempt(i)` recursion under `eslint-plugin-functional`.** If the lint complains about the inner-function closure, prefer rewriting with `Array.from({ length: totalAttempts })` + an `await reduce` chain over an explicit loop, or inline a small functional iteration helper. Whichever satisfies lint with the smallest diff.

- [ ] **Step 4: Re-run; verify PASS.**

```bash
bun test src/lib/turn/executeTurn.test.ts
```

Expected: PASS.

- [ ] **Step 5: Create `src/lib/turn/CLAUDE.md`.**

```markdown
# src/lib/turn

Stage-agnostic per-turn primitives.

`executeTurn` is the only thing in here. It owns: load prior rows → render
context → call the LLM → parse with the caller's parser → persist one
atomic batch (`user_message + assistant_response`, with optional
`failed_assistant_response + harness_retry_directive` retry exhaust
between).

- Used by scoping (`src/lib/course/`) today; teaching (`src/lib/wave/`) later.
- Parsers live in the caller (per-stage). Each parser throws
  `ValidationGateFailure` with a model-readable message — that message
  becomes the retry directive verbatim.
- Transport errors (timeouts, 5xx) propagate untouched; no rows are
  persisted on transport failure.

Do not put per-stage logic here. If a turn-shape needs stage-specific
behaviour, that belongs in the caller's lib step, not behind a flag here.
```

- [ ] **Step 6: Run full check.**

```bash
just check
```

Expected: PASS.

- [ ] **Step 7: Commit.**

```bash
git add src/lib/turn/
git commit -m "feat(turn): add executeTurn primitive for shared turn lifecycle"
```

---

## Task 9: Decide JSONB shape (D1)

**Files:**

- Possibly modify: `src/lib/types/jsonb.ts`
- Possibly modify: `src/lib/llm/renderContext.test.ts` (fixtures)
- Possibly modify: `src/db/queries/courses.ts` (course row guard)

Pick one of D1's options:

- [ ] **Step 1: Inspect blast radius of option (A) — realign to prompt-schema outputs.**

```bash
grep -rn "clarificationJsonbSchema\|frameworkJsonbSchema\|baselineJsonbSchema\|ClarificationJsonb\|FrameworkJsonb\|BaselineJsonb" src/ 2>/dev/null
```

Count callers. Any wave/seed/test fixture references are blast.

- [ ] **Step 2: Pick a path and commit to it. Document choice.**

If (A): realign each schema to mirror the prompt-side schemas (camelCase, simpler shapes). Update all fixtures that break. Confirm `just check` clean.

If (B): keep `jsonb.ts` shapes; add per-stage `toJsonbProjection(parsed)` helpers in `src/lib/course/` to convert prompt-schema outputs into the existing JSONB shapes when writing.

- [ ] **Step 3: Run full check.**

```bash
just check && just test-int
```

Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add -A
git commit -m "refactor(jsonb): <(A) align JSONB schemas with prompt-schema outputs | (B) add toJsonbProjection helpers>"
```

---

## Task 10: Rewrite `clarify` lib step

**Files:**

- **Rename:** `src/lib/course/clarifyTopic.ts` → `src/lib/course/clarify.ts`
- **Rename:** `src/lib/course/clarifyTopic.test.ts` → `src/lib/course/clarify.test.ts`

- [ ] **Step 1: Rename the files (preserving git history).**

```bash
git mv src/lib/course/clarifyTopic.ts src/lib/course/clarify.ts
git mv src/lib/course/clarifyTopic.test.ts src/lib/course/clarify.test.ts
```

- [ ] **Step 2: Rewrite the test (red).**

Overwrite `src/lib/course/clarify.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { clarify } from "./clarify";

vi.mock("@/lib/turn/executeTurn", () => ({ executeTurn: vi.fn() }));
vi.mock("@/db/queries/courses", async () => {
  const actual =
    await vi.importActual<typeof import("@/db/queries/courses")>("@/db/queries/courses");
  return {
    ...actual,
    createCourse: vi.fn(),
    getCourseById: vi.fn(),
    updateCourseScopingState: vi.fn(),
  };
});
vi.mock("@/db/queries/scopingPasses", () => ({
  ensureOpenScopingPass: vi.fn(),
}));

import { executeTurn } from "@/lib/turn/executeTurn";
import { createCourse, getCourseById, updateCourseScopingState } from "@/db/queries/courses";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";

const USER = "11111111-1111-1111-1111-111111111111";
const COURSE = { id: "c1", userId: USER, topic: "Rust", clarification: null } as never;

beforeEach(() => {
  vi.mocked(executeTurn).mockReset();
  vi.mocked(createCourse).mockReset();
  vi.mocked(getCourseById).mockReset();
  vi.mocked(updateCourseScopingState).mockReset();
  vi.mocked(ensureOpenScopingPass).mockReset();
});

describe("clarify", () => {
  it("creates a course, opens a scoping pass, runs executeTurn, persists projection, returns nextStage", async () => {
    vi.mocked(createCourse).mockResolvedValue(COURSE);
    vi.mocked(ensureOpenScopingPass).mockResolvedValue({ id: "p1" } as never);
    vi.mocked(executeTurn).mockResolvedValue({
      parsed: {
        questions: ["Q1", "Q2"],
        raw: '<response>x</response><questions>["Q1","Q2"]</questions>',
      },
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    });
    vi.mocked(updateCourseScopingState).mockResolvedValue(COURSE);

    const out = await clarify({ userId: USER, topic: "Rust" });
    expect(out.courseId).toBe(COURSE.id);
    expect(out.questions).toEqual(["Q1", "Q2"]);
    expect(out.nextStage).toBe("framework");
    expect(updateCourseScopingState).toHaveBeenCalledWith(
      COURSE.id,
      expect.objectContaining({ clarification: expect.anything() }),
    );
  });

  it("is idempotent: returns cached projection when clarification is already populated", async () => {
    // Existing course already has clarification — must NOT call executeTurn.
    const existingId = "existing";
    const existing = {
      ...COURSE,
      id: existingId,
      clarification: { questions: ["A", "B"] },
    } as never;
    vi.mocked(createCourse).mockResolvedValue(existing);
    const out = await clarify({ userId: USER, topic: "Rust" });
    expect(out.questions).toEqual(["A", "B"]);
    expect(executeTurn).not.toHaveBeenCalled();
  });
});
```

**Note on idempotency design.** Spec §3.4 idempotency reads "if JSONB populated, return cached projection." For `clarify`, the JSONB sits on `courses.clarification`. But `clarify` _creates_ the course — meaning idempotency only matters on re-creation paths (e.g., the client re-submits the same topic). For MVP, the client UX prevents this; the cached-projection branch is defense-in-depth. If you choose a simpler design (always create a fresh course), keep the idempotency check anyway for the post-create row — it costs nothing.

- [ ] **Step 3: Run; verify failure.**

```bash
bun test src/lib/course/clarify.test.ts
```

Expected: FAIL — `clarify` doesn't export the right shape yet.

- [ ] **Step 4: Rewrite `src/lib/course/clarify.ts`.**

```ts
import { sanitiseUserInput } from "@/lib/security/sanitiseUserInput";
import { executeTurn } from "@/lib/turn/executeTurn";
import { createCourse, getCourseById, updateCourseScopingState } from "@/db/queries/courses";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import { parseClarifyResponse } from "./parsers";

export interface ClarifyParams {
  readonly userId: string;
  readonly topic: string;
}

export interface ClarifyResult {
  readonly courseId: string;
  readonly questions: readonly string[];
  readonly nextStage: "framework";
}

/**
 * Drive the clarify turn of new-course onboarding.
 *
 * Pattern (spec §3.4):
 *   create course (or fetch idempotent)
 *   → open scoping pass
 *   → executeTurn(seed = scoping, user msg = sanitised topic, parser = clarify)
 *   → persist parsed questions to courses.clarification
 *   → return { courseId, questions, nextStage: "framework" }
 */
export async function clarify(params: ClarifyParams): Promise<ClarifyResult> {
  const course = await createCourse({ userId: params.userId, topic: params.topic });

  // Idempotency: if a re-creation path produced a course that already has
  // clarification stored, surface it without re-prompting the LLM.
  // (createCourse returns a fresh row in normal flow; this branch is a
  // belt-and-braces guard against future replays.)
  if (course.clarification !== null) {
    const cached = course.clarification as { questions: readonly string[] };
    return {
      courseId: course.id,
      questions: cached.questions,
      nextStage: "framework",
    };
  }

  const pass = await ensureOpenScopingPass(course.id);
  const { parsed } = await executeTurn({
    parent: { kind: "scoping", id: pass.id },
    seed: { kind: "scoping", topic: params.topic },
    userMessageContent: sanitiseUserInput(params.topic),
    parser: parseClarifyResponse,
  });

  // Persist projection. Shape depends on Task 9's choice (D1):
  //   (A) realigned: { questions: string[] }
  //   (B) translator: { questions: [...discriminatedUnion], answers: [] }
  // Use the helper that lives alongside parsers if (B); otherwise raw shape.
  await updateCourseScopingState(course.id, {
    clarification: { questions: parsed.questions },
  });

  return {
    courseId: course.id,
    questions: parsed.questions,
    nextStage: "framework",
  };
}
```

- [ ] **Step 5: Re-run; verify PASS.**

```bash
bun test src/lib/course/clarify.test.ts
```

Expected: PASS.

- [ ] **Step 6: Search and patch broken imports.**

```bash
grep -rn "clarifyTopic\|ClarifyTopicParams\|ClarifyTopicResult" src/ 2>/dev/null
```

Update every hit to the new name. There should be very few (only the router will reference, and we haven't built it yet — but check anyway).

- [ ] **Step 7: Run full check.**

```bash
just check
```

Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add -A
git commit -m "refactor(course): rewrite clarify over executeTurn primitive"
```

---

## Task 11: Rewrite `generateFramework` lib step

**Files:**

- Modify: `src/lib/course/generateFramework.ts`
- Modify: `src/lib/course/generateFramework.test.ts`

- [ ] **Step 1: Rewrite the test (red).**

Mirror the shape of clarify's test. Mocks: `executeTurn`, `getCourseById`, `ensureOpenScopingPass`, `updateCourseScopingState`. Cases: happy path returns `{ framework, nextStage: "baseline" }`; idempotency when `course.framework` is non-null; preconditions (`status !== 'scoping'` → throws `TRPCError('PRECONDITION_FAILED')`; clarification missing → throws `PRECONDITION_FAILED`).

```ts
// (Full test omitted for brevity — follow the clarify.test.ts shape.)
// Required cases:
// 1. happy path
// 2. idempotency: framework already populated
// 3. precondition: status !== 'scoping' throws
// 4. precondition: clarification null throws
// 5. answer sanitisation: each answer passes through sanitiser
```

Write all five tests with concrete fixtures.

- [ ] **Step 2: Run; verify failure.**

```bash
bun test src/lib/course/generateFramework.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Rewrite `generateFramework.ts`.**

```ts
import { TRPCError } from "@trpc/server";
import { sanitiseUserInput } from "@/lib/security/sanitiseUserInput";
import { executeTurn } from "@/lib/turn/executeTurn";
import { getCourseById, updateCourseScopingState } from "@/db/queries/courses";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import { parseFrameworkResponse } from "./parsers";
import { SCOPING } from "@/lib/config/tuning";
import type { Framework } from "@/lib/prompts";

export interface GenerateFrameworkParams {
  readonly userId: string;
  readonly courseId: string;
  readonly answers: readonly string[];
}

export interface GenerateFrameworkResult {
  readonly framework: Framework;
  readonly nextStage: "baseline";
}

export async function generateFramework(
  params: GenerateFrameworkParams,
): Promise<GenerateFrameworkResult> {
  if (params.answers.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "answers cannot be empty" });
  }
  if (params.answers.length > SCOPING.maxClarifyAnswers) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `at most ${SCOPING.maxClarifyAnswers} answers allowed`,
    });
  }

  const course = await getCourseById(params.courseId, params.userId);
  if (course.status !== "scoping") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "course is not in scoping" });
  }
  if (course.clarification === null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "clarify must complete before generateFramework",
    });
  }

  // Idempotency: cached projection wins.
  if (course.framework !== null) {
    return { framework: course.framework as Framework, nextStage: "baseline" };
  }

  const pass = await ensureOpenScopingPass(course.id);

  // Sanitise each answer for inclusion in the <answers> envelope. We use
  // the existing sanitiseUserInput but extract the inner body since each
  // answer becomes an array entry, not a top-level user_message tag.
  // See D3 (Task 0). If sanitiseUserInputBody doesn't exist yet, add it
  // under src/lib/security/.
  const sanitised = params.answers.map(sanitiseAnswerBody);
  const userContent = `<answers>${JSON.stringify(sanitised)}</answers>`;

  const { parsed } = await executeTurn({
    parent: { kind: "scoping", id: pass.id },
    seed: { kind: "scoping", topic: course.topic },
    userMessageContent: userContent,
    parser: parseFrameworkResponse,
  });

  await updateCourseScopingState(course.id, { framework: parsed.framework });

  return { framework: parsed.framework, nextStage: "baseline" };
}

// Inline import of the body-only sanitiser. If no such helper exists,
// either (a) add it to src/lib/security/, or (b) do a minimal inline:
// `text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")`
// matching escapeXmlText's behaviour. Pick whichever matches existing
// conventions — check `src/lib/security/escapeXmlText.ts`.
import { escapeXmlText } from "@/lib/security/escapeXmlText";
function sanitiseAnswerBody(answer: string): string {
  // Use existing escapeXmlText if it produces tag-safe output; otherwise
  // call sanitiseUserInput and strip the <user_message> wrapper. Confirm
  // the choice while implementing.
  return escapeXmlText(answer);
}
```

**Sanitisation note.** `sanitiseUserInput` returns `<user_message>...</user_message>` (wrapping). Inside an `<answers>` array of JSON strings, we need just the escaped body — `escapeXmlText` is the right tool. If you find a reason to add a `sanitiseUserInputBody` helper instead, do that (and add a unit test); but only if necessary.

- [ ] **Step 4: Re-run; verify PASS.**

```bash
bun test src/lib/course/generateFramework.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run full check.**

```bash
just check
```

- [ ] **Step 6: Commit.**

```bash
git add src/lib/course/generateFramework.ts src/lib/course/generateFramework.test.ts
git commit -m "refactor(course): rewrite generateFramework over executeTurn primitive"
```

---

## Task 12: Rewrite `generateBaseline` lib step

**Files:**

- Modify: `src/lib/course/generateBaseline.ts`
- Modify: `src/lib/course/generateBaseline.test.ts`

The old `generateBaseline.ts` did orchestrator-level invariant checks (out-of-scope tiers, duplicate IDs). Those now live in `parseBaselineResponse` (Task 7) and throw `ValidationGateFailure` for retry-loop recovery. The lib step shrinks dramatically.

- [ ] **Step 1: Rewrite the test (red).**

Five cases:

1. Happy path — returns `{ baseline, nextStage: "answering" }`.
2. Idempotency on populated `course.baseline`.
3. Precondition `status !== 'scoping'` throws.
4. Precondition `clarification` or `framework` null throws.
5. The lib step passes the correct `scopeTiers` from `course.framework` into `parseBaselineResponse`.

```ts
// (Test code follows clarify.test.ts shape; case 5 verifies the parser
// is wrapped with `(raw) => parseBaselineResponse(raw, { scopeTiers })`.)
```

- [ ] **Step 2: Run; verify failure.**

- [ ] **Step 3: Rewrite `generateBaseline.ts`.**

```ts
import { TRPCError } from "@trpc/server";
import { executeTurn } from "@/lib/turn/executeTurn";
import { getCourseById, updateCourseScopingState } from "@/db/queries/courses";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import { parseBaselineResponse } from "./parsers";
import type { BaselineAssessment, Framework } from "@/lib/prompts";

export interface GenerateBaselineParams {
  readonly userId: string;
  readonly courseId: string;
}

export interface GenerateBaselineResult {
  readonly baseline: BaselineAssessment;
  readonly nextStage: "answering";
}

export async function generateBaseline(
  params: GenerateBaselineParams,
): Promise<GenerateBaselineResult> {
  const course = await getCourseById(params.courseId, params.userId);
  if (course.status !== "scoping") {
    throw new TRPCError({ code: "PRECONDITION_FAILED", message: "course is not in scoping" });
  }
  if (course.clarification === null || course.framework === null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: "framework must complete before generateBaseline",
    });
  }

  if (course.baseline !== null) {
    return { baseline: course.baseline as BaselineAssessment, nextStage: "answering" };
  }

  const framework = course.framework as Framework;
  const pass = await ensureOpenScopingPass(course.id);

  const { parsed } = await executeTurn({
    parent: { kind: "scoping", id: pass.id },
    seed: { kind: "scoping", topic: course.topic },
    userMessageContent: "<request>generate baseline</request>",
    parser: (raw) => parseBaselineResponse(raw, { scopeTiers: framework.baselineScopeTiers }),
  });

  await updateCourseScopingState(course.id, { baseline: parsed.baseline });

  return { baseline: parsed.baseline, nextStage: "answering" };
}
```

- [ ] **Step 4: Re-run; PASS.**

- [ ] **Step 5: `just check`.**

- [ ] **Step 6: Commit.**

```bash
git add src/lib/course/generateBaseline.ts src/lib/course/generateBaseline.test.ts
git commit -m "refactor(course): rewrite generateBaseline over executeTurn primitive"
```

---

## Task 13: `course` router + register in app router

**Files:**

- Create: `src/server/routers/course.ts`
- Modify: `src/server/routers/index.ts`

Routers are one-line wrappers per `src/server/routers/CLAUDE.md`. Zod-validate input, call the lib step, return the lib step's return value.

- [ ] **Step 1: Implement the router.**

```ts
import { z } from "zod/v4";
import { router, protectedProcedure } from "../trpc";
import { clarify } from "@/lib/course/clarify";
import { generateFramework } from "@/lib/course/generateFramework";
import { generateBaseline } from "@/lib/course/generateBaseline";
import { SCOPING } from "@/lib/config/tuning";

/**
 * Scoping flow (spec §3.2).
 *
 * Three procedures called in sequence by the client; each return value's
 * `nextStage` field tells the client which procedure to call next. The
 * server never sends raw LLM output — every payload is typed.
 */
export const courseRouter = router({
  clarify: protectedProcedure
    .input(z.object({ topic: z.string().min(1).max(SCOPING.maxTopicLength) }))
    .mutation(({ ctx, input }) => clarify({ userId: ctx.userId, topic: input.topic })),

  generateFramework: protectedProcedure
    .input(
      z.object({
        courseId: z.string().uuid(),
        answers: z.array(z.string().min(1)).min(1).max(SCOPING.maxClarifyAnswers),
      }),
    )
    .mutation(({ ctx, input }) =>
      generateFramework({ userId: ctx.userId, courseId: input.courseId, answers: input.answers }),
    ),

  generateBaseline: protectedProcedure
    .input(z.object({ courseId: z.string().uuid() }))
    .mutation(({ ctx, input }) =>
      generateBaseline({ userId: ctx.userId, courseId: input.courseId }),
    ),
});
```

- [ ] **Step 2: Register in `src/server/routers/index.ts`.**

```ts
import { router } from "../trpc";
import { healthRouter } from "./health";
import { courseRouter } from "./course";

export const appRouter = router({
  health: healthRouter,
  course: courseRouter,
});

export type AppRouter = typeof appRouter;
```

- [ ] **Step 3: Run typecheck + tests.**

```bash
just check
```

Expected: PASS.

- [ ] **Step 4: Commit.**

```bash
git add src/server/routers/course.ts src/server/routers/index.ts
git commit -m "feat(routers): wire course router with three scoping procedures"
```

---

## Task 14: Router integration tests

**Files:**

- Create: `src/server/routers/course.integration.test.ts`

Full happy-path + retry-then-success + terminal-exhaust + idempotency, per spec §6.2. testcontainers Postgres + mocked `generateChat`.

- [ ] **Step 1: Write the integration tests.**

Sketch (adapt to existing testcontainer harness patterns — see `withTestDb` in `src/db/testing/`):

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { withTestDb } from "@/db/testing/withTestDb";
import { appRouter } from "./index";
import { createTRPCContext } from "../trpc";
import { userProfiles } from "@/db/schema";
import { contextMessages } from "@/db/schema";
import { eq } from "drizzle-orm";

vi.mock("@/lib/llm/generate", () => ({ generateChat: vi.fn() }));
import { generateChat } from "@/lib/llm/generate";

const USER = "55555555-5555-5555-5555-555555555555";
const FAKE_USAGE = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function ctxFor(userId: string | undefined) {
  // Adapt to whatever createTRPCContext expects. For dev-stub:
  return { userId };
}

beforeEach(() => {
  vi.mocked(generateChat).mockReset();
});

describe("course router integration", () => {
  describe("clarify", () => {
    it("happy path: creates course + persists rows + projection + returns nextStage", async () => {
      await withTestDb(async (db) => {
        await db.insert(userProfiles).values({ id: USER, displayName: "u" });
        vi.mocked(generateChat).mockResolvedValueOnce({
          text: `<response>asking</response><questions>["A","B"]</questions>`,
          usage: FAKE_USAGE,
        });
        const caller = appRouter.createCaller(ctxFor(USER));
        const out = await caller.course.clarify({ topic: "Rust" });
        expect(out.questions).toEqual(["A", "B"]);
        expect(out.nextStage).toBe("framework");
        // Rows: user_message@0, assistant_response@1.
        const rows = await db.select().from(contextMessages);
        expect(rows).toHaveLength(2);
        expect(rows.map((r) => r.kind).sort()).toEqual(["assistant_response", "user_message"]);
      });
    });

    it("retry-then-success: persists failure trail + success row", async () => {
      await withTestDb(async (db) => {
        await db.insert(userProfiles).values({ id: USER, displayName: "u" });
        vi.mocked(generateChat)
          .mockResolvedValueOnce({
            text: `<response>oops</response>`, // no <questions> tag → fail
            usage: FAKE_USAGE,
          })
          .mockResolvedValueOnce({
            text: `<response>retry</response><questions>["A","B"]</questions>`,
            usage: FAKE_USAGE,
          });
        const caller = appRouter.createCaller(ctxFor(USER));
        const out = await caller.course.clarify({ topic: "Rust" });
        expect(out.questions).toEqual(["A", "B"]);
        const rows = await db.select().from(contextMessages);
        expect(rows.map((r) => r.kind)).toEqual([
          "user_message",
          "failed_assistant_response",
          "harness_retry_directive",
          "assistant_response",
        ]);
      });
    });

    it("terminal exhaust: persists full failure trail, throws", async () => {
      await withTestDb(async (db) => {
        await db.insert(userProfiles).values({ id: USER, displayName: "u" });
        vi.mocked(generateChat).mockResolvedValue({
          text: `<response>still bad</response>`,
          usage: FAKE_USAGE,
        });
        const caller = appRouter.createCaller(ctxFor(USER));
        await expect(caller.course.clarify({ topic: "Rust" })).rejects.toThrow();
        const rows = await db.select().from(contextMessages);
        // user, failed, directive, failed, directive, failed = 6 rows
        expect(rows).toHaveLength(6);
      });
    });

    it("UNAUTHORIZED when no userId in context", async () => {
      await withTestDb(async () => {
        const caller = appRouter.createCaller(ctxFor(undefined));
        await expect(caller.course.clarify({ topic: "Rust" })).rejects.toMatchObject({
          code: "UNAUTHORIZED",
        });
      });
    });
  });

  describe("generateFramework", () => {
    it("happy path after clarify completes");
    it("idempotency: returns cached when framework JSONB is already populated");
    it("PRECONDITION_FAILED when clarification null");
    it("NOT_FOUND when courseId belongs to a different user");
    // Each test fleshed out with concrete fixtures matching the clarify pattern.
  });

  describe("generateBaseline", () => {
    it("happy path after framework completes");
    it("idempotency: returns cached baseline");
    it("PRECONDITION_FAILED when framework null");
    it("retry-then-success when first response misses <baseline> tag");
  });
});
```

Flesh out every test stub with concrete fixtures. Aim for 12-16 total assertions across the three procedures.

- [ ] **Step 2: Run.**

```bash
just test-int -- src/server/routers/course.integration.test.ts
```

Expected: PASS. If failures, fix the underlying code (not the test).

- [ ] **Step 3: Commit.**

```bash
git add src/server/routers/course.integration.test.ts
git commit -m "test(routers): integration tests for course scoping procedures"
```

---

## Task 15: Cleanup pass — prune prompt builders, update docs, TODO entries

**Files:**

- Modify: `src/lib/prompts/clarification.ts` — remove `buildClarificationPrompt`.
- Modify: `src/lib/prompts/framework.ts` — remove `buildFrameworkPrompt`, `buildClarificationAssistantMessage`, `buildFrameworkTurnUserContent`.
- Modify: `src/lib/prompts/baseline.ts` — remove `buildBaselinePrompt`, `buildFrameworkAssistantMessage`, `buildBaselineTurnUserContent`.
- Modify: `src/lib/prompts/index.ts` — prune the barrel.
- Modify: `src/lib/prompts/clarification.test.ts`, `framework.test.ts`, `baseline.test.ts` — drop tests for removed exports; keep schema/constant tests.
- Modify: `src/lib/course/CLAUDE.md`.
- Modify: `src/lib/prompts/CLAUDE.md`.
- Modify: `src/lib/llm/CLAUDE.md`.
- Modify: `src/server/routers/CLAUDE.md`.
- Modify: `docs/TODO.md`.

- [ ] **Step 1: Find every caller of the removed builders.**

```bash
grep -rn "buildClarificationPrompt\|buildFrameworkPrompt\|buildBaselinePrompt\|buildClarificationAssistantMessage\|buildFrameworkTurnUserContent\|buildFrameworkAssistantMessage\|buildBaselineTurnUserContent" src/ 2>/dev/null
```

The only remaining callers should be the prompt tests (which we'll drop test-by-test) and the prompts/index.ts barrel. Confirm.

- [ ] **Step 2: Delete the builder functions.**

In each `prompts/*.ts` file: remove the exported `build...` functions. Keep:

- `clarification.ts`: `CLARIFICATION_SYSTEM_PROMPT`, `clarifyingQuestionsSchema`, `ClarificationPromptParams` type (if still useful — drop if unused).
- `framework.ts`: `FRAMEWORK_TURN_INSTRUCTIONS`, `frameworkSchema`, `Framework`, `ClarificationExchange`.
- `baseline.ts`: `BASELINE_TURN_INSTRUCTIONS`, `MC_OPTION_KEYS`, `McOptionKey`, `baselineSchema`, `BaselineAssessment`, `BaselineQuestion`.

If `BASELINE_TURN_INSTRUCTIONS` / `FRAMEWORK_TURN_INSTRUCTIONS` aren't yet wired into the new flow, decide:

- (a) Add them into the system prompt rendered by `renderScopingSystem` so the LLM gets the per-stage rules upfront.
- (b) Inline them into the user-message content built by the lib step.

The spec §3.4 user-message column shows just `<answers>...</answers>` / `<request>generate baseline</request>`. That implies the model relies on the _system_ prompt for stage instructions. So path (a) is implied. Update `renderScopingSystem` in `src/lib/prompts/scoping.ts` to include the stage-specific instructions blocks. **Surface this decision** in the PR description — it's a notable detour from the spec's "system prompt is just the role block" framing. The instructions blocks are already cache-friendly (static, module-scope strings).

If this expansion makes scoping.ts grow past the 200-LOC ceiling, split it.

- [ ] **Step 3: Prune `src/lib/prompts/index.ts`.**

Remove every export the new flow doesn't use. Run typecheck after to catch dangling imports.

- [ ] **Step 4: Drop prompt-builder tests.**

In `clarification.test.ts`, `framework.test.ts`, `baseline.test.ts`: remove every test that referenced a deleted export. Keep schema/constant tests (e.g. `clarifyingQuestionsSchema` validation, `MC_OPTION_KEYS` length check).

- [ ] **Step 5: Update CLAUDE.md files.**

For each file, rewrite the affected paragraph(s). Do not blanket-rewrite. Concrete edits:

- `src/lib/course/CLAUDE.md`: Replace the "build messages → generateStructured" description with: "Each lib step: validate course state → run `executeTurn` with the stage-specific seed, user-message content, and parser → persist parsed projection to `courses.{column}` → return typed payload + nextStage. No prompt text, no DB access beyond the listed queries, no scoring logic."
- `src/lib/prompts/CLAUDE.md`: Add: "Scoping prompts: system prompt (one) + stage-instruction blocks (concatenated into the system prompt via `renderScopingSystem`) + per-stage Zod schemas. No `build*Prompt` functions — message arrays are assembled by `renderContext` from `context_messages` rows."
- `src/lib/llm/CLAUDE.md`: Under "Render & parse contract", insert the filter rule paragraph (same wording as Task 5 TSDoc).
- `src/server/routers/CLAUDE.md`: Append: "Every procedure returns a typed, hand-shaped payload. The server never forwards raw LLM output to the client — XML tags, embedded JSON, and answer keys are stripped server-side. The `nextStage` field tells the client which procedure to call next; the client maintains a stage-state and dispatches accordingly."

- [ ] **Step 6: Append to `docs/TODO.md`.**

Two new entries:

```markdown
- **`harness_retry_directive` kind — production naming review.** After a few weeks of production logs, revisit the kind name. If "retry directive" causes confusion in prompt-tuning sessions, rename to something like `harness_correction_request` or fold into a single `harness_message` kind with a subtype column.

- **`submitBaseline` `initialSummary` gap.** `setCourseStartingState` requires an `initialSummary` field, but the baseline evaluation schema (`baselineEvaluationSchema` in `src/lib/prompts/baselineEvaluation.ts`) has no summary field. Resolve in the `submitBaseline` spec — likely by adding `<course_summary>` to the evaluator's structured output.
```

- [ ] **Step 7: Final full check.**

```bash
just check && just test-int
```

Expected: PASS.

- [ ] **Step 8: Commit.**

```bash
git add -A
git commit -m "chore(scoping): clean up prompt builders, rewrite CLAUDE.md, log post-MVP TODOs"
```

---

## Task 16: Acceptance verification

**Files:** none (verification only).

- [ ] **Step 1: Full check matrix.**

```bash
just check && just test-int && just build
```

Expected: PASS.

- [ ] **Step 2: LOC ceiling audit.**

```bash
find src/ -name '*.ts' -not -name '*.test.ts' -not -name '*.integration.test.ts' | xargs wc -l | sort -rn | head -20
```

Any file over 200 LOC that isn't pre-existing → split before merging. Pre-existing offenders are documented in `docs/TODO.md`; check that no new file added in this plan crossed the line.

- [ ] **Step 3: Cleanup audit.**

```bash
grep -rn "buildClarificationPrompt\|buildFrameworkPrompt\|buildBaselinePrompt" src/ 2>/dev/null
grep -rn "clarifyTopic" src/ 2>/dev/null
grep -rn "generateStructured" src/lib/course/ 2>/dev/null
```

All three should return empty. If anything remains, fix it.

- [ ] **Step 4: Spec coverage walk.**

Re-read `docs/superpowers/specs/2026-05-11-scoping-routers-design.md` §8 acceptance criteria. Check each:

- [ ] All three router procedures pass integration tests against testcontainers Postgres with a mocked LLM. (Task 14)
- [ ] `just check` clean. (Task 16 step 1)
- [ ] Manual end-to-end smoke test against real Cerebras LLM — defer to user; flag in PR description as required prior to merge.
- [ ] No file exceeds 200 LOC unless explicitly justified. (Task 16 step 2)
- [ ] Every CLAUDE.md and TSDoc reference to deleted prompt builders is removed or rewritten. (Task 16 step 3)

- [ ] **Step 5: Open PR or hand back to user.**

Summarise in the PR description:

- The simplification opportunities you found (or didn't).
- The D1/D2/D3 decisions you took, and why.
- Any TODO additions or unresolved questions.
- Confirmation that pre-commit hooks were never bypassed.
- Reminder: manual Cerebras smoke test required before merge.

---

## Self-Review notes (writing-plans skill)

**Spec coverage:** every section of the design spec maps to at least one task above. §3.1 data stores → Tasks 2-4 + 9-12 (rows + JSONB). §3.2 procedures → Task 13. §3.3 executeTurn → Task 8. §3.4 per-procedure → Tasks 10-12. §3.5 auth → Task 6. §3.6 client UX → no server task (client work is separate). §3.7 invariants → enforced by Tasks 5 + 8 (filter + atomic batch + idempotency). §4 persistence → Tasks 2-5. §5 error handling → Tasks 7-8 (retry directive + transport propagation). §6 testing → Tasks 5, 8, 14. §7 cleanup → Task 15. §8 acceptance → Task 16.

**Type consistency check:** `ContextParent`, `AppendMessageParams`, `SeedInputs`, `ValidationGateFailure`, `Framework`, `BaselineAssessment`, `LlmUsage`, `ParsedClarifyResponse`/`ParsedFrameworkResponse`/`ParsedBaselineResponse`, `ExecuteTurnParams`/`ExecuteTurnResult`, `Clarify*Params`/`*Result` shapes — all consistent across tasks 2-12 (verified by walking the type names through each task's code samples).

**Placeholder scan:** no "TBD" or "fill in later" — every code sample is concrete. The integration-test stubs in Task 14 list specific case titles to flesh out; the implementer writes the bodies following the clarify pattern shown in full. The two decision points (D1, D2) are explicit — implementer picks A or B and documents.

---

Plan complete and saved to `docs/superpowers/plans/2026-05-11-scoping-routers.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task; review between tasks; fast iteration. Per user instruction: use **Opus 4.7** for subagents on this plan.

**2. Inline Execution** — Execute tasks in this session using executing-plans; batch with checkpoints.

Which approach?
