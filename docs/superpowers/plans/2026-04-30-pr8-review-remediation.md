# PR #8 Review Remediation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Resolve the 28 actionable review findings on PR #8 (data-model schema implementation) — Codex P1 sanitization issues, CodeRabbit Major/Minor schema-CHECK and atomicity gaps, JSONB validation tightening, plus a small batch of doc/config nits — without touching out-of-scope code.

**Architecture:** Seven sequenced commit-batches. Each batch is independently `just check`-clean and pushable. Order is: (A) sanitization (Codex P1, smallest blast-radius) → (B) DB CHECK constraints (one new migration, locks invariants before query layer leans on them) → (C) query-layer atomicity (idempotency + NotFoundError correctness) → (D) JSONB validation tightening (re-validate on read AND parse-before-write at every trust boundary) → (E) renderContext docstring + alternation test (acknowledge path) → (F) test specificity + connection teardown → (G) docs + config + TODOs. Three open architectural questions (renderContext coalescing, file splits, getNextTurnIndex race) are baked in as documented acknowledgements per the recommendations from triage — see "Open questions baked in" below.

**Tech Stack:** TypeScript strict, Drizzle 0.45 (Postgres), Zod, Vitest + testcontainers, AI SDK v5. Bun (not npm). Migrations via `just db-generate <name>` + `just db-migrate`.

---

## Open questions baked in

These were the three "Acknowledge" items from triage. Recommended answers are baked into the relevant phases below. If the user overrides any during execution, the affected phase is the only one that needs revisiting — phases are independent commits.

1. **renderContext same-role coalescing across turns** → Phase E. Acknowledge as harness-loop invariant (alternation), document in TSDoc, lock with one regression test that constructs a synthetic non-alternating sequence and asserts the prefix-stable contract still holds _given the alternation precondition_. Do **not** weaken the coalescing — it is an explicit cache-prefix decision.
2. **Out-of-spec large files (`courses.ts` 298 LOC, two integration test files >200 LOC)** → Phase G. TODO entry only (deferred to a follow-up PR). The 200-LOC guideline is aspirational; splitting `courses.ts` mid-review-PR doubles the diff for marginal value.
3. **`getNextTurnIndex` read-then-insert race** → Phase G. TODO entry only. Single-user-per-Wave harness loop guarantees no concurrent writers; the race is theoretical for MVP. Document as a known-acceptable assumption with a clear precondition.

---

## File structure

**New files**

| Path                                          | Responsibility                                                                                                                                                                                                                          |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/security/escapeXmlText.ts`           | Pure helper: HTML-encode `&`, `<`, `>` without wrapping (the encode-only half of `sanitiseUserInput`). For non-user-supplied but model-influenced text inserted into XML scaffolding (course topic, framework JSON, blueprint outline). |
| `src/lib/security/escapeXmlText.test.ts`      | Unit tests for the new helper — encode order, empty string, ampersand-first invariant.                                                                                                                                                  |
| `src/db/migrations/0001_invariant_checks.sql` | Generated migration adding CHECK constraints across `scoping_passes`, `context_messages`, `waves`, `assessments`, `concepts`. Hand-edit only the filename if Drizzle picks a different one.                                             |

**Modified files**

| Path                                                   | Reason                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/security/sanitiseUserInput.ts`                | Refactor to delegate the encode step to the new `escapeXmlText` helper; behaviour unchanged.                                                                                                                                                                                                                                                                        |
| `src/lib/prompts/teaching.ts`                          | Apply `escapeXmlText` to `courseTopic`, `topicScope`, `customInstructions`, `courseSummary`, framework JSON, due-concept names, blueprint outline.                                                                                                                                                                                                                  |
| `src/lib/prompts/scoping.ts`                           | Apply `escapeXmlText` to `inputs.topic` (line 27).                                                                                                                                                                                                                                                                                                                  |
| `src/lib/prompts/teaching.test.ts` / `scoping.test.ts` | Add regression tests asserting `<topic>X</topic>` injection cannot escape its envelope.                                                                                                                                                                                                                                                                             |
| `src/db/schema/scopingPasses.ts`                       | Add CHECK: `(status='closed') = (closed_at IS NOT NULL)`.                                                                                                                                                                                                                                                                                                           |
| `src/db/schema/contextMessages.ts`                     | Add CHECKs: `turn_index >= 0`, `seq >= 0`.                                                                                                                                                                                                                                                                                                                          |
| `src/db/schema/waves.ts`                               | Add CHECKs: `wave_number > 0`, `tier > 0`, `turn_budget > 0`, status↔closed_at consistency.                                                                                                                                                                                                                                                                         |
| `src/db/schema/assessments.ts`                         | Add CHECKs: `turn_index >= 0`, `quality_score BETWEEN 0 AND 5`, `xp_awarded >= 0`.                                                                                                                                                                                                                                                                                  |
| `src/db/schema/concepts.ts`                            | Add CHECKs: SM-2 invariants (`tier > 0`, `interval_days >= 0`, `repetition_count >= 0`, `easiness_factor >= 1.3`, `last_quality_score BETWEEN 0 AND 5 OR NULL`, `times_correct >= 0`, `times_incorrect >= 0`).                                                                                                                                                      |
| `src/db/queries/scopingPasses.ts`                      | `closeScopingPass`: `closed_at = COALESCE(closed_at, NOW())` + `WHERE status='open'`; throw `NotFoundError` when no row matched.                                                                                                                                                                                                                                    |
| `src/db/queries/waves.ts`                              | `closeWave`: scope UPDATE to `status='open'`; throw `NotFoundError` when no row matched. Validate `params.blueprintEmitted` against `blueprintEmittedSchema` _before_ the UPDATE.                                                                                                                                                                                   |
| `src/db/queries/courses.ts`                            | `setCourseStartingState`: `WHERE status='scoping'`, `NotFoundError` on no-match. `archiveCourse`: detect 0-row UPDATEs, throw `NotFoundError`. `updateCourseScopingState`: parse `clarification`/`framework`/`baseline` with their JSONB schemas before write. `incrementCourseXp`/`updateCourseTier`/`updateCourseSummary`: detect 0-row UPDATE → `NotFoundError`. |
| `src/db/queries/userProfiles.ts`                       | `incrementUserXp`: detect 0-row UPDATE → `NotFoundError`.                                                                                                                                                                                                                                                                                                           |
| `src/db/queries/concepts.ts`                           | `upsertConcept`: replace no-op `DO UPDATE SET name = EXCLUDED.name` with `ON CONFLICT … DO NOTHING` semantics (use a separate read-back when the insert is skipped). `incrementCorrect`/`incrementIncorrect`/`updateConceptSm2` row-guards already throw via `getConceptById`; verify the UPDATE returned rows or fall through to NotFoundError.                    |
| `src/db/queries/assessments.ts`                        | `recordAssessment`: assert `params.conceptId` belongs to the same course as `params.waveId` (single SELECT); also validate `turnIndex` is monotonic non-decreasing per Wave (a single SELECT MAX).                                                                                                                                                                  |
| `src/db/queries/contextMessages.ts`                    | TSDoc note on `getNextTurnIndex` race precondition (Phase G — actually a docstring, not a query change).                                                                                                                                                                                                                                                            |
| `src/lib/types/jsonb.ts`                               | `clarificationQuestionSchema` → discriminated union on `type` (single_select requires `options`; free_text forbids them).                                                                                                                                                                                                                                           |
| `src/lib/llm/tagVocabulary.ts`                         | `assessmentQuestionSchema` (multiple_choice branch) → exactly 4 keys in `options`, `correct` must be one of them.                                                                                                                                                                                                                                                   |
| `src/lib/llm/renderContext.ts`                         | TSDoc additions only — document alternation precondition.                                                                                                                                                                                                                                                                                                           |
| `src/lib/llm/renderContext.test.ts`                    | New test: synthetic non-alternating sequence, assert documented behaviour.                                                                                                                                                                                                                                                                                          |
| `src/db/seed.ts`                                       | Wrap body in `try/finally` that calls the connection teardown helper.                                                                                                                                                                                                                                                                                               |
| `src/db/testing/setup.ts` (or equivalent)              | Same `try/finally` teardown idiom in fixtures.                                                                                                                                                                                                                                                                                                                      |
| `src/db/testing/withTestDb.ts` (or equivalent)         | Add a drift guard: after applying generated migrations the harness asserts schema-introspection matches the Drizzle-inferred shape.                                                                                                                                                                                                                                 |
| `src/db/migrations/schema.integration.test.ts`         | Tighten the 3 assertion sites flagged (specific column-name / constraint-name checks rather than `length > 0`).                                                                                                                                                                                                                                                     |
| `docs/PRD.md`                                          | Line 353: `<card_answers>` → `<card_answer>` (singular).                                                                                                                                                                                                                                                                                                            |
| `docs/ux-simulation-rust-ownership.md`                 | Add `<curriculum_note>` placeholder reference (matches PRD §6.5).                                                                                                                                                                                                                                                                                                   |
| `package.json`                                         | Add `passWithNoTests: false` (or equivalent) to vitest invocation; ensure CI cannot silently green-pass on empty test discovery.                                                                                                                                                                                                                                    |
| `drizzle.config.ts`                                    | Set `strict: true` (fail-fast on schema drift).                                                                                                                                                                                                                                                                                                                     |
| `vitest.unit.config.ts`                                | Narrow the integration-test exclusion glob (current pattern is too broad).                                                                                                                                                                                                                                                                                          |
| `src/db/client.ts`                                     | TSDoc additions (no behaviour change).                                                                                                                                                                                                                                                                                                                              |
| `docs/TODO.md`                                         | Three new entries: (1) `getNextTurnIndex` race, (2) `courses.ts` + integration-test file splits, (3) optional `closed_at >= opened_at` invariant.                                                                                                                                                                                                                   |

---

## Verification cadence

`just check` (= lint + typecheck + vitest unit + build) runs at the end of every phase before the commit. Integration tests (`just test-integration` if present, otherwise the targeted vitest run) run at the end of Phase B and Phase F because those are the only phases that touch DB shape or fixture lifecycle. Never push without green `just check`.

---

## Task 1: Phase A — Sanitization at the prompt boundary (Codex P1)

**Files:**

- Create: `src/lib/security/escapeXmlText.ts`
- Create: `src/lib/security/escapeXmlText.test.ts`
- Modify: `src/lib/security/sanitiseUserInput.ts` (delegate encode step)
- Modify: `src/lib/prompts/teaching.ts` (lines 26-47 area — wrap interpolations)
- Modify: `src/lib/prompts/scoping.ts:27` (wrap `inputs.topic`)
- Modify: `src/lib/prompts/teaching.test.ts` (regression test)
- Modify: `src/lib/prompts/scoping.test.ts` (regression test)

### Step 1: Write the failing test for `escapeXmlText`

- [ ] Create `src/lib/security/escapeXmlText.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { escapeXmlText } from "./escapeXmlText";

describe("escapeXmlText", () => {
  // Encoding `&` last would let `<` → `&lt;` get re-encoded to `&amp;lt;` and a
  // single decode pass would resurrect `<`. Encoding `&` first is the only
  // order that survives a single decode pass cleanly.
  it("encodes ampersand first to prevent double-decode resurrection", () => {
    expect(escapeXmlText("a & <b> c")).toBe("a &amp; &lt;b&gt; c");
  });

  it("returns empty string unchanged", () => {
    expect(escapeXmlText("")).toBe("");
  });

  it("does not wrap output (caller controls envelope)", () => {
    expect(escapeXmlText("plain")).toBe("plain");
  });

  it("encodes every angle bracket and ampersand, nothing else", () => {
    expect(escapeXmlText("'\"unicode→arrow")).toBe("'\"unicode→arrow");
  });
});
```

### Step 2: Run test to verify it fails

Run: `bunx vitest run src/lib/security/escapeXmlText.test.ts`
Expected: FAIL — module not found.

### Step 3: Implement `escapeXmlText`

- [ ] Create `src/lib/security/escapeXmlText.ts`:

```ts
/**
 * HTML-encode `&`, `<`, `>` in untrusted-but-non-user-message text destined
 * for inclusion in an XML envelope. Pure; does NOT wrap (caller supplies the
 * tag). Use `sanitiseUserInput` for user-typed text — that helper additionally
 * wraps in `<user_message>…</user_message>` so the system prompt can mark
 * the contents as data, not directives.
 *
 * This helper is for prompt-internal text whose tag is fixed by the prompt
 * author (course topic, framework JSON, blueprint outline) — wrapping with
 * `<user_message>` would corrupt the schema the model expects.
 *
 * Ampersand FIRST — encoding `<` to `&lt;` then `&` to `&amp;` would
 * re-encode the just-emitted `&` and a later decode pass could resurrect a
 * raw bracket. The order in the body of this function is load-bearing.
 */
export function escapeXmlText(raw: string): string {
  return raw.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
```

### Step 4: Run test to verify it passes

Run: `bunx vitest run src/lib/security/escapeXmlText.test.ts`
Expected: PASS — 4/4.

### Step 5: Refactor `sanitiseUserInput` to delegate

- [ ] Edit `src/lib/security/sanitiseUserInput.ts`:

```ts
import { escapeXmlText } from "./escapeXmlText";

/**
 * Sanitise user-supplied text before it enters an LLM prompt.
 *
 * Two-step defence:
 *   1. HTML-encode `&`, `<`, `>` via `escapeXmlText` so no tag boundaries
 *      survive in the payload.
 *   2. Wrap the encoded payload in `<user_message>…</user_message>` so the
 *      system prompt can instruct the model to treat contents as data.
 *
 * This is the sole choke point for untrusted USER text entering a prompt.
 * For non-user text that still needs XML escaping (course topic, framework
 * JSON, etc.) use `escapeXmlText` directly without the wrapper.
 */
export function sanitiseUserInput(raw: string): string {
  return `<user_message>${escapeXmlText(raw)}</user_message>`;
}
```

### Step 6: Verify existing `sanitiseUserInput` tests still pass

Run: `bunx vitest run src/lib/security/`
Expected: ALL PASS (existing snapshots unchanged — same byte output).

### Step 7: Apply `escapeXmlText` in `teaching.ts`

- [ ] Read `src/lib/prompts/teaching.ts` end-to-end first; then wrap each LLM-influenced text interpolation. Identify every `${inputs.X}` (or computed-from-inputs string) inside a `\`<...>${X}</...>\``template and route through`escapeXmlText`. The interpolations to wrap (per triage):
  - `courseTopic` (the topic string)
  - `topicScope` (scope summary)
  - `customInstructions` (optional learner-supplied instructions — these MAY be raw user text; if so, route through `sanitiseUserInput` instead and adjust the surrounding tag)
  - `courseSummary` (model-emitted prose)
  - Framework JSON serialization (use `escapeXmlText(JSON.stringify(framework))` — JSON itself contains no `<`/`>` but field values can)
  - Each due-concept `name` (already arrives via Zod-validated snapshot, but defence-in-depth)
  - Each blueprint outline string

- [ ] Pattern to apply (example for `courseTopic`):

```ts
import { escapeXmlText } from "@/lib/security/escapeXmlText";
// ...
const topicLine = `<course_topic>${escapeXmlText(inputs.courseTopic)}</course_topic>`;
```

If a value flows from raw user input (custom instructions specifically), use `sanitiseUserInput` and adjust the surrounding tag to be the wrapper. If a value flows from prior-LLM output that the harness has already Zod-validated, `escapeXmlText` is sufficient.

### Step 8: Apply `escapeXmlText` in `scoping.ts:27`

- [ ] Edit `src/lib/prompts/scoping.ts`:

Find:

```ts
<scoping_topic>${inputs.topic}</scoping_topic>
```

Replace with:

```ts
<scoping_topic>${escapeXmlText(inputs.topic)}</scoping_topic>
```

Add `import { escapeXmlText } from "@/lib/security/escapeXmlText";` to the top.

### Step 9: Add regression tests for both prompts

- [ ] In `src/lib/prompts/teaching.test.ts` (and `scoping.test.ts` mirror):

```ts
it("escapes XML metacharacters in injected fields so injected tags cannot break the envelope", () => {
  const out = renderTeachingSystem({
    /* …minimum valid fixture… */
    courseTopic: "</course_topic><evil>",
  } as never);
  // The closing-tag string survives only as encoded text — never as a real tag.
  expect(out).not.toContain("</course_topic><evil>");
  expect(out).toContain("&lt;/course_topic&gt;&lt;evil&gt;");
});
```

For `scoping.test.ts`, the analogous test passes `topic: "</scoping_topic><evil>"`.

### Step 10: Run full check

Run: `just check`
Expected: ALL GREEN.

### Step 11: Commit Phase A

```bash
git add src/lib/security/escapeXmlText.ts src/lib/security/escapeXmlText.test.ts \
        src/lib/security/sanitiseUserInput.ts \
        src/lib/prompts/teaching.ts src/lib/prompts/teaching.test.ts \
        src/lib/prompts/scoping.ts src/lib/prompts/scoping.test.ts
git commit -m "$(cat <<'EOF'
fix: escape XML metacharacters in non-user prompt interpolations

Codex P1: course topic, framework JSON, blueprint outline, and other
LLM-influenced text were interpolated into XML scaffolding without
encoding `<` / `>` / `&`. A topic containing `</course_topic>` could
escape its envelope and inject sibling tags the parser would honour.

Adds escapeXmlText helper (encode-only, no wrapper) for non-user-message
text. sanitiseUserInput now delegates the encode step. Regression tests
assert injected closing tags survive only as encoded text.
EOF
)"
```

---

## Task 2: Phase B — Schema CHECK constraints (one new migration)

**Files:**

- Modify: `src/db/schema/scopingPasses.ts` (status↔closed_at)
- Modify: `src/db/schema/contextMessages.ts` (turn_index, seq)
- Modify: `src/db/schema/waves.ts` (wave_number, tier, turn_budget, status↔closed_at)
- Modify: `src/db/schema/assessments.ts` (turn_index, quality_score, xp_awarded)
- Modify: `src/db/schema/concepts.ts` (SM-2 invariants)
- Generate: `src/db/migrations/0001_<name>.sql` via `just db-generate invariant_checks`

### Step 1: Add CHECKs to `scopingPasses.ts`

- [ ] Edit `src/db/schema/scopingPasses.ts` (append in the `(t) => [...]` block alongside the existing `scoping_passes_status_check`):

```ts
check(
  "scoping_passes_closed_at_consistency",
  // closed_at MUST be set iff status='closed'. Catches partial closes from
  // any future writer that bypasses closeScopingPass().
  sql`(${t.status} = 'closed') = (${t.closedAt} IS NOT NULL)`,
),
```

### Step 2: Add CHECKs to `contextMessages.ts`

- [ ] In the `(t) => [...]` block:

```ts
check("context_messages_turn_index_nonneg", sql`${t.turnIndex} >= 0`),
check("context_messages_seq_nonneg", sql`${t.seq} >= 0`),
```

### Step 3: Add CHECKs to `waves.ts`

- [ ] In the `(t) => [...]` block:

```ts
check("waves_wave_number_positive", sql`${t.waveNumber} > 0`),
check("waves_tier_positive", sql`${t.tier} > 0`),
check("waves_turn_budget_positive", sql`${t.turnBudget} > 0`),
check(
  "waves_closed_at_consistency",
  sql`(${t.status} = 'closed') = (${t.closedAt} IS NOT NULL)`,
),
```

### Step 4: Add CHECKs to `assessments.ts`

- [ ] In the `(t) => [...]` block (append):

```ts
check("assessments_turn_index_nonneg", sql`${t.turnIndex} >= 0`),
check(
  "assessments_quality_score_range",
  sql`${t.qualityScore} >= 0 AND ${t.qualityScore} <= 5`,
),
check("assessments_xp_awarded_nonneg", sql`${t.xpAwarded} >= 0`),
```

### Step 5: Add CHECKs to `concepts.ts`

- [ ] In the `(t) => [...]` block (append):

```ts
check("concepts_tier_positive", sql`${t.tier} > 0`),
check("concepts_interval_days_nonneg", sql`${t.intervalDays} >= 0`),
check("concepts_repetition_count_nonneg", sql`${t.repetitionCount} >= 0`),
// SM-2 floor — Anki uses 1.3, all references converge on it.
check("concepts_easiness_factor_min", sql`${t.easinessFactor} >= 1.3`),
// last_quality_score is nullable (never-reviewed concepts have NULL).
check(
  "concepts_last_quality_score_range",
  sql`${t.lastQualityScore} IS NULL OR (${t.lastQualityScore} >= 0 AND ${t.lastQualityScore} <= 5)`,
),
check("concepts_times_correct_nonneg", sql`${t.timesCorrect} >= 0`),
check("concepts_times_incorrect_nonneg", sql`${t.timesIncorrect} >= 0`),
```

Add `check` to the `from "drizzle-orm/pg-core"` import if not already present.

### Step 6: Generate the migration

Run: `just db-generate invariant_checks`
Expected: a new file `src/db/migrations/0001_invariant_checks.sql` (Drizzle picks the suffix from the name) plus updates under `meta/`. Inspect the generated SQL — it should be ALTER TABLE … ADD CONSTRAINT statements only. No CREATE TABLE drift.

### Step 7: Apply the migration to the local DB

Run: `just db-migrate`
Expected: applies cleanly.

If application fails because existing seed/dev rows violate a CHECK (most likely `concepts.easiness_factor < 1.3` from a hand-seeded value), inspect via psql, fix the seed, regenerate. Do NOT lower the CHECK to fit bad seed data — fix the seed.

### Step 8: Run integration tests against the migrated DB

Run: `just test` (will spin up testcontainer and re-apply both migrations)
Expected: ALL GREEN. Existing fixtures should already satisfy these invariants because they're conservative.

### Step 9: Add a positive-failure test for one CHECK

- [ ] In `src/db/migrations/schema.integration.test.ts` (or the equivalent integration test file), add ONE assertion that proves the CHECKs are live:

```ts
it("rejects a wave with non-positive tier (CHECK enforces invariant)", async () => {
  await expect(
    db.insert(waves).values({
      courseId,
      waveNumber: 1,
      tier: 0, // violates waves_tier_positive
      frameworkSnapshot: {} as never,
      dueConceptsSnapshot: [] as never,
      seedSource: { kind: "scoping_handoff" } as never,
      turnBudget: 10,
    }),
  ).rejects.toThrow(/waves_tier_positive|check constraint/i);
});
```

One representative test is enough — we are not exhaustively testing Postgres's CHECK engine.

### Step 10: Commit Phase B

```bash
git add src/db/schema/ src/db/migrations/0001_invariant_checks.sql src/db/migrations/meta/ \
        src/db/migrations/schema.integration.test.ts
git commit -m "$(cat <<'EOF'
feat: add CHECK constraints encoding row-level invariants

CodeRabbit Major findings: column-level invariants (positive ordinals,
non-negative counters, SM-2 floors, status↔closed_at consistency) were
TS-only. A bug in the query layer or a future writer could persist
nonsense rows.

Adds CHECK constraints across scoping_passes, context_messages, waves,
assessments, concepts. New migration 0001_invariant_checks.sql.
Integration test asserts at least one CHECK is live.
EOF
)"
```

---

## Task 3: Phase C — Query-layer atomicity & idempotency

**Files:**

- Modify: `src/db/queries/scopingPasses.ts` (closeScopingPass)
- Modify: `src/db/queries/waves.ts` (closeWave)
- Modify: `src/db/queries/courses.ts` (setCourseStartingState, archiveCourse, updateCourseTier, updateCourseSummary, incrementCourseXp)
- Modify: `src/db/queries/userProfiles.ts` (incrementUserXp)
- Modify: existing query tests for the above

The pattern across all of these: raw `db.execute(sql\`UPDATE …\`)`returns a result object with a`rowCount`(or`count`) field on `pg`/`postgres-js`. Inspect what the underlying driver returns in this codebase (a 5-line probe: log the result of one execute in a test) and use that to detect 0-row UPDATEs. If the driver does not expose row count, fall back to a follow-up `SELECT … WHERE id = $1`and check existence — that is the same pattern`closeScopingPass` already uses for camelCase mapping.

### Step 1: Probe the driver row-count surface

Run: write one throwaway test that does `const r = await db.execute(sql\`UPDATE courses SET total_xp = total_xp WHERE id = 'nonexistent'\`); console.log(r);`and inspect output. Note the field name (likely`rowCount`for`pg`or`count`for`postgres-js`). DELETE the throwaway test after noting the field. This step takes 60 seconds and prevents 5 wrong assumptions later.

### Step 2: `closeScopingPass` — idempotent + scoped

- [ ] Edit `src/db/queries/scopingPasses.ts`. Replace the `UPDATE` SQL:

```ts
const result = await db.execute(
  sql`UPDATE scoping_passes
      SET status = 'closed',
          closed_at = COALESCE(closed_at, NOW())
      WHERE id = ${id}
        AND status = 'open'`,
);
// 0 rows can mean: (1) id unknown, (2) already closed.
// Distinguish by re-fetching: if the row exists at all, return it (idempotent).
const [row] = await db.select().from(scopingPasses).where(eq(scopingPasses.id, id));
if (!row) throw new NotFoundError("scoping_pass", id);
return row;
```

This makes `closeScopingPass(id)` idempotent: calling it twice on the same id returns the same `closed_at` both times. The original behaviour re-stamped `closed_at` on every call — flagged by CodeRabbit.

### Step 3: `closeWave` — idempotent + scoped + JSONB validated before write

- [ ] Edit `src/db/queries/waves.ts`:

```ts
import { blueprintEmittedSchema } from "@/lib/types/jsonb";
// …
export async function closeWave(id: string, params: CloseWaveParams): Promise<Wave> {
  // Validate JSONB BEFORE the write — never trust caller-supplied JSONB shape.
  const validatedBlueprint = blueprintEmittedSchema.parse(params.blueprintEmitted);
  await db.execute(sql`
    UPDATE waves
    SET status = 'closed',
        summary = ${params.summary},
        blueprint_emitted = ${JSON.stringify(validatedBlueprint)}::jsonb,
        closed_at = COALESCE(closed_at, NOW())
    WHERE id = ${id}
      AND status = 'open'
  `);
  // getWaveById already throws NotFoundError if the row does not exist;
  // it returns the latest row whether the UPDATE matched or it was a no-op.
  return getWaveById(id);
}
```

### Step 4: `setCourseStartingState` — scoped to scoping rows

- [ ] Edit `src/db/queries/courses.ts:193`:

```ts
const result = await db.execute(sql`
  UPDATE courses
  SET status = 'active',
      summary = ${patch.initialSummary},
      summary_updated_at = NOW(),
      starting_tier = ${patch.startingTier},
      current_tier = ${patch.currentTier},
      updated_at = NOW()
  WHERE id = ${id}
    AND status = 'scoping'
`);
// Re-fetch — getCourseById throws NotFoundError if the id is unknown.
// If the id existed but status was not 'scoping', the row is unchanged and we
// surface that as a domain-level error (the caller violated the lifecycle).
const row = await getCourseById(id);
if (row.status !== "active") {
  throw new Error(
    `setCourseStartingState: course ${id} was in status='${row.status}', expected 'scoping'`,
  );
}
return row;
```

### Step 5: `archiveCourse`, `updateCourseTier`, `updateCourseSummary`, `incrementCourseXp` — NotFoundError on 0-row

- [ ] For each of these in `courses.ts`, after the `db.execute(...)` add (using the rowCount field from Step 1; example assumes `rowCount`):

```ts
if ((result as { rowCount?: number }).rowCount === 0) {
  throw new NotFoundError("course", id);
}
```

`archiveCourse` previously had no return value and silently no-op'd on unknown id. The other three returned via `getCourseById(id)` which already throws — but the explicit zero-row check makes the failure mode explicit at the call site of the UPDATE rather than coupling to the read.

### Step 6: `incrementUserXp` — NotFoundError on 0-row

- [ ] Edit `src/db/queries/userProfiles.ts:55`:

```ts
const result = await db.execute(
  sql`UPDATE user_profiles SET total_xp = total_xp + ${amount} WHERE id = ${id}`,
);
if ((result as { rowCount?: number }).rowCount === 0) {
  throw new NotFoundError("user_profile", id);
}
```

### Step 7: Update affected unit/integration tests

- [ ] For each query function above, add (or tighten) tests that assert:
  - Idempotent close: calling `closeScopingPass`/`closeWave` twice returns the same `closed_at` both times (uses `expect(first.closedAt).toEqual(second.closedAt)`).
  - 0-row → NotFoundError: `await expect(archiveCourse("00000000-0000-0000-0000-000000000000")).rejects.toBeInstanceOf(NotFoundError);`
  - Status-scoped UPDATE: open a course in `archived` status, call `setCourseStartingState`, expect the lifecycle Error.

Each test is one line of arrange + one line of act + one expect. The point is not coverage, it's documenting the contract.

### Step 8: Run full check

Run: `just check && just test`
Expected: ALL GREEN.

### Step 9: Commit Phase C

```bash
git add src/db/queries/ # only the modified files
git commit -m "$(cat <<'EOF'
fix: make close/archive/increment queries idempotent and 404-aware

CodeRabbit Major: closeScopingPass re-stamped closed_at on every call;
archiveCourse/incrementUserXp silently no-op'd on unknown id. UPDATEs
that scope to a lifecycle status now COALESCE the timestamp and raise
NotFoundError when zero rows match.

closeWave additionally Zod-validates blueprintEmitted before the write
(parse-before-persist boundary).
EOF
)"
```

---

## Task 4: Phase D — JSONB validation tightening

**Files:**

- Modify: `src/lib/types/jsonb.ts` (clarificationQuestionSchema)
- Modify: `src/lib/llm/tagVocabulary.ts` (assessmentQuestionSchema MC branch)
- Modify: `src/db/queries/courses.ts` (updateCourseScopingState — parse before write)
- Modify: `src/db/queries/concepts.ts` (upsertConcept — DO NOTHING semantics)
- Modify: `src/db/queries/assessments.ts` (recordAssessment — cross-course check, monotonic turn_index)
- Add tests for each tightened schema

### Step 1: `clarificationQuestionSchema` → discriminated union

- [ ] Edit `src/lib/types/jsonb.ts:18-23`:

```ts
export const clarificationQuestionSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string(),
    text: z.string(),
    type: z.literal("single_select"),
    options: z.array(z.string()).min(2), // single_select needs ≥2 options
  }),
  z.object({
    id: z.string(),
    text: z.string(),
    type: z.literal("free_text"),
    // Explicitly NO options field — Zod's strictness is on the discriminator.
  }),
]);
```

### Step 2: `assessmentQuestionSchema` MC branch — exactly 4 options + correct ∈ keys

- [ ] Edit `src/lib/llm/tagVocabulary.ts:28-49`. Replace the multiple_choice branch:

```ts
z.object({
  question_id: z.string(),
  concept_name: z.string(),
  tier: z.number().int().min(1).max(5),
  type: z.literal("multiple_choice"),
  question: z.string(),
  // PRD §… mandates exactly 4 options (A/B/C/D). Tighter than free `record`.
  options: z.record(z.string(), z.string()).refine(
    (o) => Object.keys(o).length === 4,
    { message: "multiple_choice questions must have exactly 4 options" },
  ),
  correct: z.string(),
  freetextRubric: z.string().optional(),
  explanation: z.string().optional(),
}).refine(
  // The correct key must reference one of the listed options.
  (q) => q.correct in q.options,
  { message: "correct must reference one of the option keys", path: ["correct"] },
),
```

### Step 3: Tests for the tightened schemas

- [ ] In `src/lib/types/jsonb.test.ts` (create if absent):

```ts
import { clarificationQuestionSchema } from "./jsonb";

it("rejects free_text question with options", () => {
  expect(() =>
    clarificationQuestionSchema.parse({
      id: "q1",
      text: "?",
      type: "free_text",
      options: ["a", "b"], // free_text branch has no options
    }),
  ).toThrow();
});

it("requires options on single_select", () => {
  expect(() =>
    clarificationQuestionSchema.parse({ id: "q1", text: "?", type: "single_select" }),
  ).toThrow();
});
```

- [ ] In `src/lib/llm/tagVocabulary.test.ts` (or wherever schema tests live):

```ts
it("rejects MC question with 3 options", () => {
  expect(() =>
    assessmentQuestionSchema.parse({
      question_id: "q1",
      concept_name: "x",
      tier: 1,
      type: "multiple_choice",
      question: "?",
      options: { A: "a", B: "b", C: "c" },
      correct: "A",
    }),
  ).toThrow(/exactly 4 options/);
});

it("rejects MC question whose 'correct' is not a key", () => {
  expect(() =>
    assessmentQuestionSchema.parse({
      question_id: "q1",
      concept_name: "x",
      tier: 1,
      type: "multiple_choice",
      question: "?",
      options: { A: "a", B: "b", C: "c", D: "d" },
      correct: "Z",
    }),
  ).toThrow(/correct must reference/);
});
```

### Step 4: `updateCourseScopingState` — parse-before-write

- [ ] Edit `src/db/queries/courses.ts:148-182`. Before the `setClauses` array, validate any non-undefined patch field:

```ts
import {
  clarificationJsonbSchema,
  frameworkJsonbSchema,
  baselineJsonbSchema,
} from "@/lib/types/jsonb";
// …inside updateCourseScopingState:
if (patch.clarification !== undefined) {
  clarificationJsonbSchema.parse(patch.clarification);
}
if (patch.framework !== undefined) {
  frameworkJsonbSchema.parse(patch.framework);
}
if (patch.baseline !== undefined) {
  baselineJsonbSchema.parse(patch.baseline);
}
```

The query layer is the trust boundary. tRPC inputs may be Zod-validated upstream but defence-in-depth: anywhere JSONB hits the DB, validate first.

### Step 5: `upsertConcept` — DO NOTHING semantics

- [ ] Edit `src/db/queries/concepts.ts:144-175`. The current `DO UPDATE SET name = EXCLUDED.name` is a no-op write that still acquires a row-level lock unnecessarily. Replace with `DO NOTHING` and rely on the read-back to find the existing row:

```ts
export async function upsertConcept(params: UpsertConceptParams): Promise<Concept> {
  // DO NOTHING — no-op writes are wasted locks.
  await db.execute(sql`
    INSERT INTO concepts (course_id, name, description, tier)
    VALUES (
      ${params.courseId},
      ${params.name},
      ${params.description ?? null},
      ${params.tier}
    )
    ON CONFLICT (course_id, lower(name))
    DO NOTHING
  `);

  // Read-back works whether the INSERT happened or was skipped — case-insensitive
  // match mirrors the unique index target.
  const [row] = await db
    .select()
    .from(concepts)
    .where(
      and(
        eq(concepts.courseId, params.courseId),
        sql`lower(${concepts.name}) = lower(${params.name})`,
      ),
    );
  if (!row) throw new Error("upsertConcept: no row found after upsert");
  return row;
}
```

Note: existing TSDoc on `upsertConcept` mentions the `DO UPDATE SET name = EXCLUDED.name` workaround — update the comment to match the new code (DO NOTHING).

### Step 6: `recordAssessment` — cross-course check + monotonic turn_index

- [ ] Edit `src/db/queries/assessments.ts:58-62`:

```ts
import { max } from "drizzle-orm";
import { waves, concepts } from "@/db/schema";

export async function recordAssessment(params: RecordAssessmentParams): Promise<Assessment> {
  // Cross-course check: the concept must belong to the same course as the wave.
  // Single SELECT joins both rows; mismatch = caller bug, not a domain error.
  const [scopeCheck] = await db.execute<{ wave_course_id: string; concept_course_id: string }>(
    sql`SELECT
          (SELECT course_id FROM waves WHERE id = ${params.waveId})    AS wave_course_id,
          (SELECT course_id FROM concepts WHERE id = ${params.conceptId}) AS concept_course_id`,
  );
  if (!scopeCheck?.wave_course_id || !scopeCheck.concept_course_id) {
    throw new NotFoundError("wave_or_concept", `${params.waveId}/${params.conceptId}`);
  }
  if (scopeCheck.wave_course_id !== scopeCheck.concept_course_id) {
    throw new Error(
      `recordAssessment: wave ${params.waveId} and concept ${params.conceptId} belong to different courses`,
    );
  }

  // Monotonic turn_index per Wave: a new assessment must have turn_index >= the
  // current MAX(turn_index) for this wave. Prevents out-of-order writes that
  // would corrupt the assessment timeline.
  const [maxRow] = await db
    .select({ maxTurn: max(assessments.turnIndex) })
    .from(assessments)
    .where(eq(assessments.waveId, params.waveId));
  const currentMax = maxRow?.maxTurn ?? -1;
  if (params.turnIndex < currentMax) {
    throw new Error(
      `recordAssessment: turnIndex ${params.turnIndex} < current max ${currentMax} for wave ${params.waveId}`,
    );
  }

  const [row] = await db.insert(assessments).values(params).returning();
  if (!row) throw new Error("recordAssessment: insert returned no row");
  return row;
}
```

If `NotFoundError` is not exported from this file already, add the re-export:

```ts
export { NotFoundError } from "./errors";
```

### Step 7: Tests for the tightened query layer

- [ ] Add (in the appropriate `*.test.ts` integration test file):
  - One test that opens a wave for course A and a concept for course B, calls `recordAssessment` mixing them, expects throw.
  - One test that records two assessments for the same wave with `turnIndex: 5` then `turnIndex: 3`, expects the second to throw.
  - One test that calls `updateCourseScopingState` with a malformed `framework` JSONB (missing `tiers`), expects ZodError.
  - One test that calls `upsertConcept` twice with the same name (different case), expects the same row both times and exactly one row in `concepts`.

### Step 8: Run full check + integration

Run: `just check && just test`
Expected: ALL GREEN.

### Step 9: Commit Phase D

```bash
git add src/lib/types/jsonb.ts src/lib/types/jsonb.test.ts \
        src/lib/llm/tagVocabulary.ts src/lib/llm/tagVocabulary.test.ts \
        src/db/queries/courses.ts src/db/queries/concepts.ts src/db/queries/assessments.ts \
        # plus any test files touched
git commit -m "$(cat <<'EOF'
fix: tighten JSONB validation and cross-table invariants

CodeRabbit Major + Minor:
- clarificationQuestionSchema becomes a discriminated union so single_select
  cannot drop options and free_text cannot smuggle them.
- assessmentQuestionSchema MC branch enforces exactly 4 options and
  correct ∈ option keys (matches PRD).
- updateCourseScopingState parses every JSONB field before the UPDATE
  (parse-before-persist boundary).
- upsertConcept switches to DO NOTHING (no wasted lock on conflict).
- recordAssessment checks wave/concept belong to the same course and
  asserts monotonic turn_index per wave.
EOF
)"
```

---

## Task 5: Phase E — renderContext docstring + alternation regression

**Files:**

- Modify: `src/lib/llm/renderContext.ts` (TSDoc only)
- Modify: `src/lib/llm/renderContext.test.ts` (add alternation regression)

This is the **acknowledge** path for the renderContext coalescing concern. The current behaviour is correct under the harness's strict user/assistant alternation; we lock that contract in the docstring and one test.

### Step 1: Tighten the TSDoc

- [ ] Edit `src/lib/llm/renderContext.ts:6-19`:

```ts
/**
 * Pure renderer that turns structured seed inputs + an ordered list of
 * `context_messages` rows into the LLM API payload (spec §9.1).
 *
 * Determinism: same inputs → byte-identical output across calls.
 *
 * Cache-prefix invariant: appending a row at the end never changes the
 * rendered prefix for prior rows. Tests assert both invariants.
 *
 * Same-role coalescing — IMPORTANT PRECONDITION: this function concatenates
 * consecutive same-role rows into one LLM message (e.g. a `user_message`
 * row immediately followed by a `harness_turn_counter` row collapses into
 * one user-role API message). This is a deliberate cache-key optimisation
 * for OpenAI-compatible providers; flat over the row list.
 *
 * The cache-prefix invariant only holds when role transitions are stable
 * across appends: an append that introduces a NEW user row immediately
 * after the prior user row will *change* what the prior turn rendered to
 * (the two rows now coalesce). The harness loop guarantees strict
 * user↔assistant alternation per turn, so cross-turn coalescing cannot
 * occur in practice. If a future caller produces non-alternating sequences,
 * either they accept the coalescing (within-turn injection) or they must
 * insert a delimiter row.
 */
```

### Step 2: Add the alternation regression test

- [ ] In `src/lib/llm/renderContext.test.ts`:

```ts
it("documents within-turn coalescing of consecutive same-role rows", () => {
  // Two consecutive user-role rows in the same turn (e.g. user_message +
  // harness_turn_counter) collapse into one rendered user message. This is
  // the documented cache-key behaviour — locked here so refactors must
  // update both the test and the docstring together.
  const seed: SeedInputs = /* … minimum scoping seed … */;
  const rows: ContextMessage[] = [
    { role: "user", content: "<user_message>hi</user_message>", /* … */ } as ContextMessage,
    { role: "user", content: "<turns_remaining>9</turns_remaining>", /* … */ } as ContextMessage,
    { role: "assistant", content: "<response>Hello</response>", /* … */ } as ContextMessage,
  ];
  const out = renderContext(seed, rows);
  expect(out.messages).toHaveLength(2);
  expect(out.messages[0]!.role).toBe("user");
  expect(out.messages[0]!.content).toBe(
    "<user_message>hi</user_message>\n<turns_remaining>9</turns_remaining>",
  );
  expect(out.messages[1]!.role).toBe("assistant");
});
```

### Step 3: Run check

Run: `just check`
Expected: GREEN.

### Step 4: Commit Phase E

```bash
git add src/lib/llm/renderContext.ts src/lib/llm/renderContext.test.ts
git commit -m "$(cat <<'EOF'
docs: lock renderContext alternation precondition in TSDoc + test

CodeRabbit (acknowledge path): same-role coalescing across non-alternating
turns would break the cache-prefix invariant. The harness loop guarantees
strict user↔assistant alternation, so this is theoretical for MVP.
Documented as a precondition; one regression test asserts the
within-turn coalescing behaviour so future refactors must update both
the test and the docstring together.
EOF
)"
```

---

## Task 6: Phase F — Test specificity + connection teardown

**Files:**

- Modify: `src/db/seed.ts` (try/finally teardown)
- Modify: `src/db/testing/setup.ts` (or whatever the fixture entry point is — find via grep)
- Modify: `src/db/testing/withTestDb.ts` (drift guard)
- Modify: `src/db/migrations/schema.integration.test.ts` (3 assertion tightenings)

### Step 1: Locate the fixture entry point

Run: `rg -n "testcontainer|withTestDb|beforeAll" src/db/testing src/db/migrations | head -30`
Expected: identifies the file(s) that own connection lifecycle. Read them once before editing.

### Step 2: Wrap `seed.ts` in `try/finally`

- [ ] Edit `src/db/seed.ts`. Pattern:

```ts
async function main() {
  try {
    // …existing seed body…
  } finally {
    // Close the pool so the script process exits cleanly even if seeding throws.
    // Without this, `bun run seed` can hang waiting for an open connection on error.
    await db.$client.end?.(); // exact method depends on the driver; verify
  }
}
```

The exact teardown call depends on the driver — read `src/db/client.ts` to see what `db` exposes.

### Step 3: Same try/finally idiom in test fixtures

- [ ] In the integration-test setup file, ensure every `beforeAll` that opens a connection has an `afterAll` that closes it. If the existing fixture already does this, skip (CodeRabbit may have flagged a partial cover).

### Step 4: Drift guard in `withTestDb` (or equivalent migration harness)

- [ ] After `bunx drizzle-kit migrate` runs in the harness, add an assertion that the live schema matches the Drizzle-inferred shape. Cheapest implementation: `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'public'` and assert the count and a representative subset matches the schema constants. The point is to fail loudly if a hand-edited migration drifts from the schema TS — not to be exhaustive.

```ts
// After migrations apply, confirm at least one CHECK we just added is present —
// guards against a future where the migration is dropped but the schema isn't.
const [{ exists }] = await db.execute<{ exists: boolean }>(sql`
  SELECT EXISTS (
    SELECT 1 FROM information_schema.check_constraints
    WHERE constraint_name = 'waves_tier_positive'
  ) AS exists
`);
if (!exists) {
  throw new Error("withTestDb: invariant CHECK missing — schema drift?");
}
```

### Step 5: Tighten 3 flagged test assertions

- [ ] In `schema.integration.test.ts`, replace any assertion of the form `expect(rows.length).toBeGreaterThan(0)` with a specific check on the row that is supposed to exist. Example:

Before:

```ts
const rows = await db.select().from(courses).where(eq(courses.id, id));
expect(rows.length).toBeGreaterThan(0);
```

After:

```ts
const rows = await db.select().from(courses).where(eq(courses.id, id));
expect(rows).toHaveLength(1);
expect(rows[0]).toMatchObject({ id, status: "scoping" });
```

Identify the 3 flagged sites via the CodeRabbit review (search the review comments for "specific assertion" / "loose check" — exact line numbers in the review). If only 2 are easily found, that is fine; the goal is to remove obviously-loose assertions, not to chase every one.

### Step 6: Run check + integration

Run: `just check && just test`
Expected: GREEN.

### Step 7: Commit Phase F

```bash
git add src/db/seed.ts src/db/testing/ src/db/migrations/schema.integration.test.ts
git commit -m "$(cat <<'EOF'
test: harden fixture teardown and tighten loose assertions

CodeRabbit Minor: seed.ts could leak the connection on error; some
schema-integration assertions checked array length rather than the
specific row shape. Adds try/finally teardown, schema-drift guard in
the test harness, and tightens three loose checks to specific
toMatchObject assertions.
EOF
)"
```

---

## Task 7: Phase G — Docs, config, and TODOs

**Files:**

- Modify: `docs/PRD.md:353` (`<card_answers>` → `<card_answer>`)
- Modify: `docs/ux-simulation-rust-ownership.md` (`<curriculum_note>` reference)
- Modify: `package.json` (vitest passWithNoTests)
- Modify: `drizzle.config.ts` (strict: true)
- Modify: `vitest.unit.config.ts` (narrow exclude)
- Modify: `src/db/client.ts` (TSDoc only)
- Modify: `src/db/queries/contextMessages.ts` (`getNextTurnIndex` race TSDoc)
- Modify: `docs/TODO.md` (3 new entries)

### Step 1: PRD typo

- [ ] Edit `docs/PRD.md:353`. Find `<card_answers>` and replace with `<card_answer>`. (One occurrence per CodeRabbit; verify with `grep -n card_answers docs/PRD.md` first.)

### Step 2: ux-simulation `<curriculum_note>` reference

- [ ] In `docs/ux-simulation-rust-ownership.md`, locate the section listing harness-emitted tags (it cross-references PRD §6.5). Add a short stub mentioning that `<curriculum_note>` is reserved as a post-MVP tag (cross-ref the matching TODO in `docs/TODO.md`). One sentence is enough.

### Step 3: vitest `passWithNoTests: false`

- [ ] Edit `package.json`. The vitest invocation should NOT silently green-pass when zero tests are discovered (CI safety). Find the `test` script (probably `"test": "vitest run"`) and explicitly pass `--passWithNoTests=false` if the default is true; or set `passWithNoTests: false` in the vitest config. The exact location depends on whether config lives in `package.json` or in `vitest.config.ts` / `vitest.unit.config.ts` — read first.

### Step 4: drizzle strict mode

- [ ] Edit `drizzle.config.ts`. Add or change:

```ts
export default defineConfig({
  // …
  strict: true, // fail-fast on schema/migration drift
  verbose: true, // optional; CI logs are already terse
});
```

### Step 5: vitest exclude narrowing

- [ ] Edit `vitest.unit.config.ts` (or wherever the unit-test exclude lives). The current pattern likely excludes everything matching `**/*.integration.test.ts`. Verify the pattern is anchored correctly — should NOT incidentally match (e.g.) `myintegrationtest.ts` or skip files outside the intended directory. If unclear, add a comment explaining what each glob does.

### Step 6: `client.ts` TSDoc

- [ ] In `src/db/client.ts`, add TSDoc to the exported `db` constant explaining: pool semantics (singleton against `DATABASE_URL`), how to close it (`db.$client.end()`), and that callers should NOT create their own pool. One paragraph.

### Step 7: `getNextTurnIndex` race precondition TSDoc

- [ ] In `src/db/queries/contextMessages.ts:138`, add TSDoc above `getNextTurnIndex`:

```ts
/**
 * Return the next monotonically-increasing turn_index for a context parent.
 *
 * Read-then-insert race precondition: two concurrent callers will compute
 * the same next index and the second insert will violate the partial unique
 * index on (parent, turn_index, seq). The MVP harness loop is single-user-
 * per-Wave, so concurrent writers cannot happen in practice. If the harness
 * ever gains parallel write paths, this function must move to a SERIALIZABLE
 * transaction or be replaced by a Postgres sequence per parent.
 *
 * See docs/TODO.md → "getNextTurnIndex race".
 */
```

### Step 8: TODO.md entries

- [ ] Append three bullets to `docs/TODO.md`:

```md
- **`getNextTurnIndex` read-then-insert race (post-MVP).** The current implementation is safe under the single-user-per-Wave harness loop — concurrent writers cannot occur. If parallel write paths are ever added (e.g. sub-agent harness, multi-device replay), wrap the SELECT MAX + INSERT in a SERIALIZABLE transaction or convert to a per-parent Postgres sequence. See `src/db/queries/contextMessages.ts:138` for the inline note.

- **File-size cleanup pass (post-merge).** `src/db/queries/courses.ts` (298 LOC), `src/db/migrations/schema.integration.test.ts` (~334 LOC) and `src/db/queries/contextMessages.integration.test.ts` (~241 LOC) exceed the 200-LOC guideline. Splits were intentionally deferred from PR #8 to keep the review-fix diff focused. Suggested splits: courses.ts → courses-reads.ts + courses-writes.ts + courses-utils.ts; integration tests → one file per table.

- **Optional `closed_at >= opened_at` invariant (post-MVP).** Considered for `scoping_passes` and `waves` during Phase B but deferred — adds a CHECK that uses two columns and would have a nontrivial cost on bulk insert. Add when we have a concrete bug or audit requirement that would benefit.
```

### Step 9: Run final check

Run: `just check`
Expected: GREEN.

### Step 10: Commit Phase G

```bash
git add docs/ package.json drizzle.config.ts vitest.unit.config.ts \
        src/db/client.ts src/db/queries/contextMessages.ts
git commit -m "$(cat <<'EOF'
docs: address PR #8 doc/config nitpicks and record deferred work

- PRD typo: <card_answers> → <card_answer> (matches schema discriminator).
- ux-simulation cross-references <curriculum_note> stub.
- vitest passWithNoTests=false (CI safety).
- drizzle strict mode (schema-drift fail-fast).
- vitest unit-config exclude pattern narrowed.
- TSDoc added to client.ts and getNextTurnIndex.
- TODO.md: 3 new entries (turn-index race, file splits, optional
  closed_at invariant).
EOF
)"
```

---

## Task 8: Push, reply to threads, and resolve

After all 7 commits are local and `just check` is green:

### Step 1: Run check one more time before push

Run: `just check`
Expected: GREEN.

### Step 2: Push

```bash
git push origin feat/data-model-schema
```

Wait for GitHub to register the new commits.

### Step 3: Reply to each thread, then resolve

Use the `/review-pr` workflow already in flight (tasks #56 / #57). For each fix:

- Inline-comment thread: `gh api … pulls/8/comments/{id}/replies -f body="Fixed in <sha> — <one line>"`
- Review-body-only nitpicks: one summary `gh pr comment 8 --body "..."` listing each finding.

Then resolve threads via the GraphQL `resolveReviewThread` mutation.

### Step 4: Post the summary comment

The `/review-pr` skill template covers this — group by reviewer (Codex, CodeRabbit) and by category (Fixed / Acknowledged / Rejected), one line each. The reply must reference the commit SHAs.

---

## Self-review checklist (run AFTER all 7 phases above are written)

This is the writing-plans skill's self-review — done inline before handing off to execution.

**1. Spec coverage:** every "Fix" item from the 28-item triage maps to at least one step above. The 3 "Acknowledge" items are baked in as Phase E (renderContext docstring), Phase G (file splits TODO), Phase G (turn-index race TODO). ✓

**2. Placeholder scan:** no "TBD" / "implement later" steps. Each step shows the actual code change or the actual command. The driver row-count probe in Phase C Step 1 is intentionally a single throwaway test (one minute) rather than a placeholder. ✓

**3. Type consistency:** `escapeXmlText` introduced in Phase A is referenced by name in Phases A only (matches signature). `blueprintEmittedSchema` introduced in `src/lib/types/jsonb.ts` is imported in Phase C Step 3. `clarificationQuestionSchema` is the same name throughout. `NotFoundError` is re-exported wherever it's first thrown. ✓

**4. Phase independence:** each phase ends with a green `just check` and one commit. A phase can be cherry-picked or reverted without breaking subsequent phases. Phase B (migration) is the only phase with a hard ordering dependency on the others (Phase D's parse-before-write doesn't strictly require the CHECKs but is cleaner with them). ✓

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-30-pr8-review-remediation.md`. Two execution options:

**1. Subagent-Driven (recommended)** — Each phase dispatched to a fresh Sonnet implementer subagent, two-stage review (spec compliance → code quality), controller verifies green `just check` locally between phases. Best given the context-management note ("we will need to split this out").

**2. Inline Execution** — Execute phases here in this session via superpowers:executing-plans, batch execution with checkpoints between phases.

Subagent-driven is the right call here: 7 phases × ~3 subagents per phase = ~21 dispatches, each with isolated context — keeps the controller window clean across the whole remediation. Recommend Sonnet for all roles per the saved feedback memory.

Which approach?
