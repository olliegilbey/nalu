# Wave `chat_log` Mirror-Scoping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (Opus 4.7 implementer + reviewers; feature branch `feat/teaching-loop`, NOT a worktree) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Mirror scoping's typed-JSONB dual-write on the wave teaching loop. A new `waves.chat_log` JSONB array becomes the UI's source of truth; `context_messages` stays unchanged as the LLM replay log. Net effect: server stops shipping envelope strings to the client; open-questionnaire reconstruction moves from a 70-line envelope re-parse to a 5-line array scan.

**Architecture:** Append-only typed JSONB array column on `waves`. Helper `appendWaveChatLog` (atomic JSONB `||` concat) writes alongside every `appendMessage`. Reads go through `waveRowGuard` Zod-validation. UI derives `activeQuestionnaire` client-side from the chat log, mirroring `useScopingState`.

**Tech Stack:** Drizzle ORM + Postgres (JSONB), Zod (trust-boundary parsing), tRPC v11, Vitest (unit + integration via testcontainers), React Query.

**Spec:** `docs/superpowers/specs/2026-05-20-wave-chat-log-mirror-scoping-design.md` (read alongside this plan; the spec owns wire shapes, the plan owns task ordering).

**Companion doc:** `docs/ARCHITECTURE.md` — the two-store split + replay-log invariants.

---

## Phase A — Foundation (types, schema, helpers)

### Task 1: Add `waveChatLogEntrySchema` to `src/lib/types/jsonb.ts`

**Files:**

- Modify: `src/lib/types/jsonb.ts:25-56`
- Create test: `src/lib/types/waveChatLog.test.ts` (colocated unit test)

- [ ] **Step 1: Export `v3Question` and `v3Response`**

Currently both are unexported `const`s (`src/lib/types/jsonb.ts:27` and `:48`). Wave's chat log entry schema needs them. Edit both declarations to add `export`:

```ts
// src/lib/types/jsonb.ts:27 — was `const v3Question = ...`
export const v3Question = z.discriminatedUnion("type", [
  /* unchanged body */
]);

// src/lib/types/jsonb.ts:48 — was `const v3Response = ...`
export const v3Response = z
  .object({
    /* unchanged body */
  })
  .refine(/* unchanged */);
```

Also export the inferred types (will be imported by both the schema below and `redactWaveChatLog.ts`):

```ts
export type V3Question = z.infer<typeof v3Question>;
export type V3Response = z.infer<typeof v3Response>;
```

- [ ] **Step 2: Write failing test for `waveChatLogEntrySchema`**

Create `src/lib/types/waveChatLog.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { waveChatLogEntrySchema, waveChatLogSchema } from "./jsonb";

describe("waveChatLogEntrySchema", () => {
  it("parses a user-text entry", () => {
    const parsed = waveChatLogEntrySchema.parse({
      role: "user",
      kind: "text",
      content: "Tell me more.",
    });
    expect(parsed).toEqual({ role: "user", kind: "text", content: "Tell me more." });
  });

  it("parses a user-answers entry with responses", () => {
    const parsed = waveChatLogEntrySchema.parse({
      role: "user",
      kind: "answers",
      questionnaireId: "q-1",
      responses: [{ questionId: "qid-a", choice: "A" }],
    });
    expect(parsed.kind).toBe("answers");
  });

  it("parses an assistant-text entry", () => {
    expect(
      waveChatLogEntrySchema.parse({ role: "assistant", kind: "text", content: "Hello." }),
    ).toBeTruthy();
  });

  it("parses an assistant-text_with_questionnaire entry with MC question", () => {
    const parsed = waveChatLogEntrySchema.parse({
      role: "assistant",
      kind: "text_with_questionnaire",
      questionnaireId: "q-1",
      content: "Try this:",
      questions: [
        {
          id: "qid-a",
          type: "multiple_choice",
          prompt: "2+2?",
          options: { A: "3", B: "4", C: "5", D: "6" },
          correct: "B",
          freetextRubric: "n/a",
        },
      ],
    });
    expect(parsed.kind).toBe("text_with_questionnaire");
  });

  it("rejects an entry with an unknown kind", () => {
    expect(() =>
      waveChatLogEntrySchema.parse({ role: "user", kind: "bogus", content: "x" }),
    ).toThrow();
  });

  it("waveChatLogSchema accepts an empty array (the default for fresh waves)", () => {
    expect(waveChatLogSchema.parse([])).toEqual([]);
  });
});
```

- [ ] **Step 3: Run test, verify it fails**

```bash
bun run test src/lib/types/waveChatLog.test.ts
```

Expected: FAIL — `waveChatLogEntrySchema` is not exported yet.

- [ ] **Step 4: Add the schemas + types to `jsonb.ts`**

Append at the end of `src/lib/types/jsonb.ts` (after the `blueprintEmittedSchema` block):

```ts
// --- waves.chat_log -----------------------------------------------------

/**
 * One row in `waves.chat_log` — the typed JSONB store the wave UI reads.
 *
 * Discriminated on `kind`; `Question` / `Response` reused verbatim from the
 * scoping primitives above. Strictly append-only; the four kinds cover:
 *  - user text turn (chat-text mode)
 *  - user questionnaire submission (pre-LLM, paired with assistant emission)
 *  - assistant text turn (no questionnaire)
 *  - assistant text turn that opens a new questionnaire
 *
 * Mirror of scoping's typed JSONB store (`courses.{clarification|baseline}`);
 * wave is variable-cardinality so the column is an array. See
 * `docs/ARCHITECTURE.md` and the spec for why per-row beats per-round.
 */
export const waveChatLogEntrySchema = z.discriminatedUnion("kind", [
  z.object({
    role: z.literal("user"),
    kind: z.literal("text"),
    content: z.string(),
  }),
  z.object({
    role: z.literal("user"),
    kind: z.literal("answers"),
    questionnaireId: z.string(),
    responses: z.array(v3Response),
  }),
  z.object({
    role: z.literal("assistant"),
    kind: z.literal("text"),
    content: z.string(),
  }),
  z.object({
    role: z.literal("assistant"),
    kind: z.literal("text_with_questionnaire"),
    questionnaireId: z.string(),
    content: z.string(),
    questions: z.array(v3Question),
  }),
]);
export const waveChatLogSchema = z.array(waveChatLogEntrySchema);
export type WaveChatLogEntry = z.infer<typeof waveChatLogEntrySchema>;
export type WaveChatLog = z.infer<typeof waveChatLogSchema>;
```

- [ ] **Step 5: Run test, verify it passes**

```bash
bun run test src/lib/types/waveChatLog.test.ts
```

Expected: PASS (all 6 cases).

- [ ] **Step 6: Commit**

```bash
git add src/lib/types/jsonb.ts src/lib/types/waveChatLog.test.ts
git commit -m "feat(types): add waveChatLogEntrySchema + WaveChatLog primitives

Discriminated-union JSONB store mirroring scoping's typed payload pattern.
Reuses v3Question/v3Response verbatim; exports them so wave can import.
First step in mirroring scoping persistence onto the wave teaching loop."
```

---

### Task 2: Drizzle migration — add `waves.chat_log` column

**Files:**

- Modify: `src/db/schema/waves.ts:49`
- Create: `src/db/migrations/0007_wave_chat_log.sql` (generated)

- [ ] **Step 1: Add `chatLog` to the Drizzle schema**

In `src/db/schema/waves.ts:49` (right after `blueprintEmitted`), insert:

```ts
    chatLog: jsonb("chat_log").notNull().default(sql`'[]'::jsonb`),
```

Schema imports `sql` already (line 11). No other changes here.

- [ ] **Step 2: Generate the migration SQL**

```bash
just db-generate wave_chat_log
```

Expected output: a new file `src/db/migrations/0007_wave_chat_log.sql` containing approximately:

```sql
ALTER TABLE "waves" ADD COLUMN "chat_log" jsonb DEFAULT '[]'::jsonb NOT NULL;
```

(Drizzle Kit may add `--> statement-breakpoint` markers; leave as generated.)

Verify nothing else changed:

```bash
git diff src/db/migrations/meta/
```

Expected: meta journal updated to record migration 0007. No other migrations touched.

- [ ] **Step 3: Apply the migration locally**

```bash
just db-migrate
```

Expected output: `0007_wave_chat_log: ok`.

- [ ] **Step 4: Commit migration + schema**

```bash
git add src/db/schema/waves.ts src/db/migrations/0007_wave_chat_log.sql src/db/migrations/meta/
git commit -m "$(cat <<'EOF'
chore(db): add waves.chat_log column

Typed JSONB array column that mirrors scoping's per-stage JSONB stores.
Wave UI will read this column for its chat scroll instead of context_messages
envelope strings. Schema-only migration; existing dev waves will have empty
chat_log and render as an empty chat scroll.

Before testing locally on feat/teaching-loop, wipe dev state:

    TRUNCATE waves, courses CASCADE;

No prod backfill — branch is unshipped.
EOF
)"
```

---

### Task 3: Extend `waveRowGuard` to validate `chat_log`

**Files:**

- Modify: `src/db/queries/waves.ts:1-13` (imports), `:42-54` (`waveRowGuard` body)

- [ ] **Step 1: Add `waveChatLogSchema` to the imports**

In `src/db/queries/waves.ts:4-12`, add `waveChatLogSchema` and the `WaveChatLog` type to the imports from `@/lib/types/jsonb`:

```ts
import {
  frameworkJsonbSchema,
  dueConceptsSnapshotSchema,
  seedSourceSchema,
  blueprintEmittedSchema,
  waveChatLogSchema,
  type DueConceptsSnapshot,
  type SeedSource,
  type Blueprint,
  type WaveChatLog,
} from "@/lib/types/jsonb";
```

- [ ] **Step 2: Add `chatLog` validation in `waveRowGuard`**

In `src/db/queries/waves.ts:42-54`, add the `chatLog` line after `blueprintEmitted`:

```ts
export function waveRowGuard(row: Wave): Wave {
  return {
    ...row,
    frameworkSnapshot: frameworkJsonbSchema.parse(row.frameworkSnapshot),
    dueConceptsSnapshot: dueConceptsSnapshotSchema.parse(row.dueConceptsSnapshot),
    seedSource: seedSourceSchema.parse(row.seedSource),
    blueprintEmitted: blueprintEmittedSchema.parse(row.blueprintEmitted),
    // chat_log is NOT NULL with a default of [], so it's always populated.
    // Validation here mirrors the trust-boundary discipline of courseRowGuard.
    chatLog: waveChatLogSchema.parse(row.chatLog) as Wave["chatLog"],
  };
}
```

The cast at the end is needed because `Wave["chatLog"]` is `unknown` (Drizzle's JSONB type) while `WaveChatLog` is the parsed shape — same pattern as `frameworkSnapshot` in `openWave`.

- [ ] **Step 3: Run existing wave tests to confirm no regressions**

```bash
bun run test src/db/queries/
```

Expected: existing tests still pass — the new validation runs on every `waveRowGuard` invocation but an empty array (the column default) is valid input.

- [ ] **Step 4: Commit**

```bash
git add src/db/queries/waves.ts
git commit -m "feat(db): validate waves.chat_log via waveRowGuard

Every read of a wave row Zod-parses chat_log against waveChatLogSchema.
Mirrors courseRowGuard's per-column validation discipline."
```

---

### Task 4: Add `appendWaveChatLog` query helper

**Files:**

- Modify: `src/db/queries/waves.ts` (append new export)
- Create test: `src/db/queries/waves.appendChatLog.integration.test.ts`

- [ ] **Step 1: Write failing integration test**

Create `src/db/queries/waves.appendChatLog.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll } from "vitest";
import { setupTestDb } from "@/db/testing/testcontainer";
import { db } from "@/db/client";
import { appendWaveChatLog, getWaveById, openWave } from "./waves";
import { createCourse } from "./courses";
import { createTestUser } from "@/db/testing/createTestUser";

describe("appendWaveChatLog", () => {
  beforeAll(setupTestDb);

  async function makeWave() {
    const user = await createTestUser();
    const course = await createCourse({ userId: user.id, topic: "go" });
    const wave = await openWave({
      courseId: course.id,
      waveNumber: 1,
      tier: 1,
      frameworkSnapshot: {
        userMessage: "x",
        tiers: [],
        estimatedStartingTier: 1,
        baselineScopeTiers: [],
      },
      customInstructionsSnapshot: null,
      dueConceptsSnapshot: [],
      seedSource: {
        kind: "scoping_handoff",
        blueprint: { topic: "go", outline: [], openingText: "hi", plannedConcepts: [] },
      },
      turnBudget: 10,
    });
    return wave;
  }

  it("appends a single entry to the empty default chat_log", async () => {
    const wave = await makeWave();
    expect(wave.chatLog).toEqual([]);
    await appendWaveChatLog(db, wave.id, {
      role: "assistant",
      kind: "text",
      content: "Welcome.",
    });
    const reloaded = await getWaveById(wave.id);
    expect(reloaded.chatLog).toEqual([{ role: "assistant", kind: "text", content: "Welcome." }]);
  });

  it("preserves order across multiple appends", async () => {
    const wave = await makeWave();
    await appendWaveChatLog(db, wave.id, {
      role: "assistant",
      kind: "text",
      content: "First.",
    });
    await appendWaveChatLog(db, wave.id, {
      role: "user",
      kind: "text",
      content: "Second.",
    });
    const reloaded = await getWaveById(wave.id);
    expect(reloaded.chatLog).toEqual([
      { role: "assistant", kind: "text", content: "First." },
      { role: "user", kind: "text", content: "Second." },
    ]);
  });

  it("participates in a caller's transaction (rollback wipes the append)", async () => {
    const wave = await makeWave();
    await expect(
      db.transaction(async (tx) => {
        await appendWaveChatLog(tx, wave.id, {
          role: "assistant",
          kind: "text",
          content: "Tx-only.",
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    const reloaded = await getWaveById(wave.id);
    expect(reloaded.chatLog).toEqual([]);
  });
});
```

Run it to confirm it fails:

```bash
bun run test:integration src/db/queries/waves.appendChatLog.integration.test.ts
```

Expected: FAIL — `appendWaveChatLog` is not exported.

- [ ] **Step 2: Implement `appendWaveChatLog`**

Append to `src/db/queries/waves.ts` (after `closeWave`):

```ts
// ---------------------------------------------------------------------------
// chat_log append (typed JSONB store for the wave UI — mirrors scoping's
// per-stage JSONB columns on `courses`).
// ---------------------------------------------------------------------------

/**
 * Append one entry to `waves.chat_log`.
 *
 * Uses Postgres JSONB `||` concat so the write is atomic: no read-modify-write
 * round-trip, no lost-update race when two tx's append in parallel against the
 * same wave (they serialise on the row lock and apply in commit order).
 *
 * `tx` opts the UPDATE into a caller's transaction so the chat_log append
 * rolls back atomically with sibling writes (e.g. the executeWaveMid tx that
 * inserts assessment rows + persists context_messages).
 */
export async function appendWaveChatLog(
  exec: DbOrTx,
  waveId: string,
  entry: WaveChatLogEntry,
): Promise<void> {
  // `::jsonb` cast guarantees Postgres treats the parameter as JSONB even
  // though the driver sends it as a JSON-encoded string. The array wrap is
  // required by `||` semantics (append-many).
  const payload = JSON.stringify([entry]);
  await exec.execute(sql`
    UPDATE waves
    SET chat_log = chat_log || ${payload}::jsonb
    WHERE id = ${waveId}
  `);
}
```

And import the entry type at the top:

```ts
import {
  // ... existing imports ...
  waveChatLogSchema,
  type WaveChatLog,
  type WaveChatLogEntry, // ← add
} from "@/lib/types/jsonb";
```

- [ ] **Step 3: Run test, verify it passes**

```bash
bun run test:integration src/db/queries/waves.appendChatLog.integration.test.ts
```

Expected: PASS (all 3 cases).

- [ ] **Step 4: Commit**

```bash
git add src/db/queries/waves.ts src/db/queries/waves.appendChatLog.integration.test.ts
git commit -m "feat(db): add appendWaveChatLog atomic-concat helper

Atomic JSONB || concat avoids the read-modify-write race when two tx's
append against the same wave. Tx-aware so callers can roll the append
back alongside sibling writes (executeWaveMid, persistWaveClose, etc)."
```

---

### Task 5: Un-private and rename `formatAnswers` in `deriveTurns.ts`

**Files:**

- Modify: `src/lib/course/deriveTurns.ts`
- Modify: `src/lib/course/deriveTurns.test.ts` (if asserting helper-internal behaviour)

- [ ] **Step 1: Rewrite `deriveTurns.ts` to expose a single `formatAnswers`**

Replace the file body's helper section with one exported function. Full new contents of `src/lib/course/deriveTurns.ts`:

```ts
import type { Turn } from "@/lib/types/turn";
import type { CourseState } from "./getState";
import type { ClarificationJsonb, BaselineJsonb, V3Question, V3Response } from "@/lib/types/jsonb";

/**
 * Project a `CourseState` to the chat scroll `Turn[]`.
 *
 * Deterministic and pure. Each downstream turn depends on the presence of a
 * specific JSONB column on the row, in this order:
 *
 *   topic → clarification → (clarify responses present → framework) → baseline
 *   → (scopingResult present → close + move-on-cta)
 *
 * The active questionnaire (clarify or baseline) is not a turn — the Composer
 * renders it separately from `useScopingState.activeQuestionnaire`.
 */
export function deriveTurns(state: CourseState): readonly Turn[] {
  const turns: Turn[] = [{ kind: "user-text", content: state.topic }];

  if (state.clarification) {
    turns.push({ kind: "assistant-text", content: state.clarification.userMessage });
  }

  // Once the framework lands, clarify responses are guaranteed to be saved
  // (generateFramework persists them before calling the LLM — see
  // src/lib/course/generateFramework.ts:82-92). Emit the user-questionnaire-answers
  // turn from the persisted responses so a reload renders identically.
  if (state.framework && state.clarification) {
    turns.push({
      kind: "user-questionnaire-answers",
      content: formatAnswers(state.clarification.questions, state.clarification.responses),
    });
    turns.push({
      kind: "assistant-text-with-framework",
      userMessage: state.framework.userMessage,
      tiers: state.framework.tiers.map((t) => ({
        number: t.number,
        name: t.name,
        description: t.description,
      })),
    });
  }

  if (state.baseline) {
    turns.push({ kind: "assistant-text", content: state.baseline.userMessage });
  }

  if (state.scopingResult && state.baseline) {
    turns.push({
      kind: "user-questionnaire-answers",
      content: formatAnswers(state.baseline.questions, state.baseline.responses),
    });
    turns.push({ kind: "assistant-text", content: state.scopingResult.closingMessage });
    turns.push({ kind: "move-on-cta", next: { phase: "wave", n: 1 } });
  }

  return turns;
}

/**
 * Format a `(questions, responses)` pair as a numbered prose list.
 *
 * Shared by scoping clarify, scoping baseline, and wave questionnaire answers.
 * MC responses (`r.choice`) render as the chosen option's text; free-text
 * responses (`r.freetext`) render verbatim. Missing question lookups fall back
 * to `Q{n}` so a corrupted response list still produces readable output rather
 * than a crash.
 *
 * Exported (and renamed from the prior `concatBaselineAnswers`) so wave's
 * `deriveWaveTurns` can reuse it. Clarify's prior dedicated helper
 * (`concatClarifyAnswers`) is deleted; clarify responses never carry `choice`
 * so the baseline-shaped formatter handles them identically.
 */
export function formatAnswers(
  questions: readonly V3Question[],
  responses: readonly V3Response[],
): string {
  const byId = new Map(questions.map((q) => [q.id, q]));
  return responses
    .map((r, i) => {
      const q = byId.get(r.questionId);
      const prompt = q?.prompt ?? `Q${i + 1}`;
      const answer =
        r.choice !== undefined
          ? q && q.type === "multiple_choice"
            ? q.options[r.choice]
            : r.choice
          : (r.freetext ?? "");
      return `${i + 1}. ${prompt} — ${answer}`;
    })
    .join("\n");
}
```

Imports of `ClarificationJsonb` / `BaselineJsonb` are no longer used directly by `deriveTurns` itself but remain in the file's type imports for clarity — drop them to keep the import block tight:

```ts
import type { V3Question, V3Response } from "@/lib/types/jsonb";
```

(Remove the `ClarificationJsonb, BaselineJsonb` import; they were only used by the old private helpers.)

- [ ] **Step 2: Run existing tests, confirm green**

```bash
bun run test src/lib/course/deriveTurns.test.ts
```

Expected: PASS — the public `deriveTurns(state)` API is identical; only its internal helper changed. If any test directly asserted on the helper symbol it now needs `formatAnswers` instead — patch as needed.

- [ ] **Step 3: Add a unit test for `formatAnswers` (the new public surface)**

Append to `src/lib/course/deriveTurns.test.ts`:

```ts
import { formatAnswers } from "./deriveTurns";
import type { V3Question, V3Response } from "@/lib/types/jsonb";

describe("formatAnswers", () => {
  it("renders MC answers as the chosen option's text", () => {
    const questions: V3Question[] = [
      {
        id: "q1",
        type: "multiple_choice",
        prompt: "Color?",
        options: { A: "red", B: "blue", C: "green", D: "yellow" },
        correct: "B",
        freetextRubric: "n/a",
      },
    ];
    const responses: V3Response[] = [{ questionId: "q1", choice: "B" }];
    expect(formatAnswers(questions, responses)).toBe("1. Color? — blue");
  });

  it("renders free-text answers verbatim", () => {
    const questions: V3Question[] = [
      { id: "q1", type: "free_text", prompt: "Why?", freetextRubric: "n/a" },
    ];
    const responses: V3Response[] = [{ questionId: "q1", freetext: "because." }];
    expect(formatAnswers(questions, responses)).toBe("1. Why? — because.");
  });

  it("falls back to Q{n} when a response references an unknown question id", () => {
    const responses: V3Response[] = [{ questionId: "missing", freetext: "x" }];
    expect(formatAnswers([], responses)).toBe("1. Q1 — x");
  });
});
```

Run it:

```bash
bun run test src/lib/course/deriveTurns.test.ts
```

Expected: all old tests + 3 new ones pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/course/deriveTurns.ts src/lib/course/deriveTurns.test.ts
git commit -m "refactor(scoping): collapse clarify/baseline formatters into shared formatAnswers

Single exported helper handles both stages and (next) wave answers. Clarify
never carries r.choice so the baseline-shaped formatter is a strict superset.
Wave's deriveWaveTurns will import this in a later task."
```

---

## Phase B — Write path: dual-writes everywhere

### Task 6: `persistScopingClose` seeds Wave 1's `chat_log` opening entry

**Files:**

- Modify: `src/lib/course/submitBaseline.persist.ts:5` (imports), `:161-171` (after the `appendMessage` call for Wave 1)
- Modify: `src/lib/course/submitBaseline.persist.integration.test.ts` (extend)

- [ ] **Step 1: Add the failing integration test**

Open `src/lib/course/submitBaseline.persist.integration.test.ts` and add a case asserting Wave 1's `chat_log` has the opening entry after a successful close. Inside the existing `describe("persistScopingClose")` block, add:

```ts
it("seeds Wave 1's chat_log with the openingText assistant entry", async () => {
  // Reuse whatever setup helper the existing tests use to drive a
  // persistScopingClose call to completion. Assert on Wave 1's chat_log:
  const { courseId, blueprint } = await runFullScopingCloseFixture();
  const wave1 = await getWaveByCourseAndNumber(courseId, 1);
  if (!wave1) throw new Error("Wave 1 must exist after scoping close");
  expect(wave1.chatLog).toEqual([
    { role: "assistant", kind: "text", content: blueprint.openingText },
  ]);
});
```

Use whichever setup helper the file already imports (look for the existing scoping-close happy-path test in the same file; reuse its fixture wiring rather than duplicating it). If a named setup helper doesn't exist, lift the relevant 10–15 lines out of the first test into a local `async function runFullScopingCloseFixture()` and reuse from both.

Run:

```bash
bun run test:integration src/lib/course/submitBaseline.persist.integration.test.ts
```

Expected: FAIL — `wave1.chatLog` is `[]`.

- [ ] **Step 2: Add `appendWaveChatLog` import and call**

In `src/lib/course/submitBaseline.persist.ts`, top of file (alongside the existing `openWave` import):

```ts
import { appendWaveChatLog, openWave } from "@/db/queries/waves";
```

After the existing turn-0 `appendMessage` block at `src/lib/course/submitBaseline.persist.ts:161-171`, append one more block inside the same `db.transaction(...)` callback:

```ts
// 5b. Dual-write Wave 1's opening entry to chat_log — the typed JSONB
//     store the wave UI reads. Mirror of step 5: that one persists to
//     context_messages (LLM replay log), this one persists to chat_log
//     (UI projection). See docs/ARCHITECTURE.md "two-store split".
await appendWaveChatLog(tx, wave1.id, {
  role: "assistant",
  kind: "text",
  content: parsed.nextUnitBlueprint.openingText,
});
```

- [ ] **Step 3: Run test, verify it passes**

```bash
bun run test:integration src/lib/course/submitBaseline.persist.integration.test.ts
```

Expected: PASS — Wave 1 now has the opening entry in chat_log alongside its context_messages row.

- [ ] **Step 4: Commit**

```bash
git add src/lib/course/submitBaseline.persist.ts src/lib/course/submitBaseline.persist.integration.test.ts
git commit -m "feat(course): seed Wave 1 chat_log opening entry on scoping close

Dual-write: context_messages keeps the assistant_response row for LLM replay;
chat_log gets the typed entry for the wave UI to read. Same transaction so
the two stores can never diverge."
```

---

### Task 7: `persistWaveClose` writes closing entry on Wave N + opening on Wave N+1

**Files:**

- Modify: `src/lib/course/persistWaveClose.ts:4` (imports), inside the existing tx block
- Modify: `src/lib/course/persistWaveClose.integration.test.ts` (extend)

- [ ] **Step 1: Add the failing test**

Append to `src/lib/course/persistWaveClose.integration.test.ts` a case asserting both writes:

```ts
it("dual-writes chat_log: closing entry on Wave N, opening on Wave N+1", async () => {
  const { ctx, parsed } = await setupCloseFixture(); // existing helper
  await persistWaveClose({ ctx, parsed, now: new Date() });

  const closingWave = await getWaveById(ctx.wave.id);
  // The closing wave's chat_log gains one final entry. Earlier mid-turn
  // appends from executeWaveMid are not exercised here — we only assert the
  // LAST entry is the closing assistant text.
  expect(closingWave.chatLog.at(-1)).toEqual({
    role: "assistant",
    kind: "text",
    content: parsed.closingMessage,
  });

  const nextWave = await getWaveByCourseAndNumber(ctx.course.id, ctx.wave.waveNumber + 1);
  if (!nextWave) throw new Error("next wave must exist");
  expect(nextWave.chatLog).toEqual([
    { role: "assistant", kind: "text", content: parsed.nextUnitBlueprint.openingText },
  ]);
});
```

Run:

```bash
bun run test:integration src/lib/course/persistWaveClose.integration.test.ts
```

Expected: FAIL — closing wave's chat_log doesn't gain the entry; next wave's chat_log is `[]`.

- [ ] **Step 2: Add the two appends inside the existing tx**

In `src/lib/course/persistWaveClose.ts:4`, add `appendWaveChatLog`:

```ts
import { appendWaveChatLog, closeWave, openWave } from "@/db/queries/waves";
```

Inside the `db.transaction(async (tx) => { ... })` block:

- After `await closeWave(...)` (currently `:90-94`), insert the closing-entry append on Wave N:

```ts
// 3b. Closing assistant entry on Wave N's chat_log — paired with the
//     close-turn assistant_response that was persisted by executeTurn
//     in the parent executeWaveClose. Same two-store invariant as
//     mid-turn (see executeWaveMid).
await appendWaveChatLog(tx, ctx.wave.id, {
  role: "assistant",
  kind: "text",
  content: parsed.closingMessage,
});
```

- After the turn-0 `appendMessage` for Wave N+1 (currently `:150-160`), insert the opening-entry append on Wave N+1:

```ts
// 6b. Opening assistant entry on Wave N+1's chat_log. Mirror of step 6's
//     context_messages seed: that one is the LLM replay log; this one is
//     the wave UI's typed source of truth.
await appendWaveChatLog(tx, nextWave.id, {
  role: "assistant",
  kind: "text",
  content: parsed.nextUnitBlueprint.openingText,
});
```

- [ ] **Step 3: Run test, verify it passes**

```bash
bun run test:integration src/lib/course/persistWaveClose.integration.test.ts
```

Expected: PASS — both waves now carry their entries.

- [ ] **Step 4: Commit**

```bash
git add src/lib/course/persistWaveClose.ts src/lib/course/persistWaveClose.integration.test.ts
git commit -m "feat(course): dual-write chat_log entries on wave close

Wave N gains a closing assistant entry; Wave N+1 starts with its opening
assistant entry. Atomic with the close transaction — rollback wipes both."
```

---

### Task 8: `executeWaveMid` writes the assistant `chat_log` entry

**Files:**

- Modify: `src/lib/course/executeWaveMid.ts`
- Modify: `src/lib/course/executeWaveMid.integration.test.ts` (extend)

- [ ] **Step 1: Write failing assertion**

Open `src/lib/course/executeWaveMid.integration.test.ts` and add an assertion after an existing happy-path call. After the call returns, assert the wave's chat_log gained a typed entry matching the assistant emission. Inside the existing happy-path test, after `expect(...)` assertions on the result, add:

```ts
// Dual-write invariant: assistant emission lands on chat_log too.
const waveRow = await getWaveById(ctx.wave.id);
const last = waveRow.chatLog.at(-1);
if (parsed.questionnaire) {
  expect(last).toMatchObject({
    role: "assistant",
    kind: "text_with_questionnaire",
    content: parsed.userMessage,
  });
} else {
  expect(last).toEqual({
    role: "assistant",
    kind: "text",
    content: parsed.userMessage,
  });
}
```

(If the test doesn't already have `parsed` in scope, mock it as `result.newQuestionnaire !== null ? ... : ...` against the result fields.)

Run:

```bash
bun run test:integration src/lib/course/executeWaveMid.integration.test.ts
```

Expected: FAIL.

- [ ] **Step 2: Append the chat_log write inside the existing transaction**

In `src/lib/course/executeWaveMid.ts`, the `db.transaction(async (tx) => { ... })` block currently ends at `return { graded, newQuestionnaire };`. Right before that return, add:

```ts
// Dual-write: assistant emission lands on chat_log alongside the
// context_messages row that executeTurn already persisted. Same tx so
// either both stores receive the write or neither does.
const chatLogEntry: WaveChatLogEntry = parsed.questionnaire
  ? {
      role: "assistant",
      kind: "text_with_questionnaire",
      // questionnaireId matches the assistant_response row id —
      // same addressing scheme insertNewQuestionnaire uses, so the
      // wire shape stays self-consistent between emit + reload.
      questionnaireId: assistantRow.id,
      content: parsed.userMessage,
      questions: parsed.questionnaire.questions,
    }
  : {
      role: "assistant",
      kind: "text",
      content: parsed.userMessage,
    };
await appendWaveChatLog(tx, ctx.wave.id, chatLogEntry);
```

Add to the imports at the top of `executeWaveMid.ts`:

```ts
import { appendWaveChatLog } from "@/db/queries/waves";
import type { WaveChatLogEntry } from "@/lib/types/jsonb";
```

- [ ] **Step 3: Run test, verify pass**

```bash
bun run test:integration src/lib/course/executeWaveMid.integration.test.ts
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/course/executeWaveMid.ts src/lib/course/executeWaveMid.integration.test.ts
git commit -m "feat(course): dual-write assistant emission to wave chat_log

executeWaveMid now appends a typed chat_log entry inside the same tx that
persists grading + assessment rows. Mirrors scoping's pre/post-LLM persistence
pattern: context_messages keeps the LLM replay log; chat_log feeds the UI."
```

---

### Task 9: `submitWaveTurn` writes the learner `chat_log` entry pre-LLM

**Files:**

- Modify: `src/lib/course/submitWaveTurn.ts`
- Modify: `src/lib/course/submitWaveTurn.integration.test.ts` (extend)

- [ ] **Step 1: Write the failing durability test**

Append to `src/lib/course/submitWaveTurn.integration.test.ts`:

```ts
import { vi } from "vitest";
// near top of file
vi.mock("./executeWaveMid", async (orig) => {
  const real = (await orig()) as typeof import("./executeWaveMid");
  return {
    ...real,
    executeWaveMid: vi.fn(real.executeWaveMid),
  };
});

it("persists learner chat-text to chat_log before executeWaveMid runs", async () => {
  const { courseId, waveNumber, waveId } = await setupOpenWave(); // existing helper
  const { executeWaveMid } = await import("./executeWaveMid");
  vi.mocked(executeWaveMid).mockRejectedValueOnce(new Error("LLM transport failure"));

  await expect(
    submitWaveTurn({
      userId: TEST_USER_ID,
      courseId,
      waveNumber,
      payload: { kind: "chat-text", text: "Hello?" },
    }),
  ).rejects.toThrow("LLM transport failure");

  const wave = await getWaveById(waveId);
  const userEntries = wave.chatLog.filter((e) => e.role === "user" && e.kind === "text");
  expect(userEntries).toHaveLength(1);
  expect(userEntries[0]).toEqual({ role: "user", kind: "text", content: "Hello?" });

  // context_messages must NOT have a user_message row for the failed turn
  // — atomicity rule: no LLM response → no context_messages batch.
  const ctxRows = await getMessagesForWave(waveId);
  expect(ctxRows.filter((r) => r.kind === "user_message")).toHaveLength(0);
});
```

Add a parallel test for `questionnaire-answers` to assert the `{role: user, kind: answers, ...}` entry survives the same way. (Reuse the existing open-questionnaire fixture; sabotage executeWaveMid the same way.)

Run:

```bash
bun run test:integration src/lib/course/submitWaveTurn.integration.test.ts
```

Expected: FAIL on both — chat_log empty after rejected mutation.

- [ ] **Step 2: Pre-LLM persist in `submitWaveTurn`**

In `src/lib/course/submitWaveTurn.ts`, inside `submitWaveTurn` after the existing guards finish (right before the `if (isCloseTurn)` branch at the end), add a pre-LLM persist step. The atomicity is per-store: chat_log gets the learner write before executeWaveMid; context_messages gets it inside executeWaveMid's atomic batch.

```ts
import { appendWaveChatLog } from "@/db/queries/waves";
import { db } from "@/db/client";
import type { WaveChatLogEntry } from "@/lib/types/jsonb";
```

Right after the existing `consumed` / `turnsRemaining` block (currently `:127-130`), add:

```ts
// Pre-LLM persistence (mirrors scoping's generateFramework.ts:82-92 +
// submitBaseline.persist.ts pattern). The learner-side write lands FIRST
// so a downstream LLM transport failure doesn't drop the learner's input.
// The matching context_messages user_message row is written by executeTurn
// ONLY on LLM success — atomicity rule from docs/ARCHITECTURE.md.
const learnerEntry: WaveChatLogEntry =
  params.payload.kind === "chat-text"
    ? { role: "user", kind: "text", content: params.payload.text }
    : {
        role: "user",
        kind: "answers",
        questionnaireId: params.payload.questionnaireId,
        responses: params.payload.answers.map((a) =>
          a.kind === "mc"
            ? { questionId: a.id, choice: a.selected }
            : { questionId: a.id, freetext: a.text },
        ),
      };
await appendWaveChatLog(db, ctx.wave.id, learnerEntry);
```

The pre-LLM write uses the `db` singleton (no enclosing tx — there isn't one here, mirroring how `generateFramework` pre-persists clarify responses via the singleton before `executeTurn`).

- [ ] **Step 3: Run test, verify pass**

```bash
bun run test:integration src/lib/course/submitWaveTurn.integration.test.ts
```

Expected: PASS on both chat-text and questionnaire-answers durability cases.

- [ ] **Step 4: Commit**

```bash
git add src/lib/course/submitWaveTurn.ts src/lib/course/submitWaveTurn.integration.test.ts
git commit -m "feat(course): pre-LLM persist learner input to wave chat_log

Learner-direction durability mirrors scoping (generateFramework pre-persists
clarify responses; submitBaseline pre-persists baseline responses). An LLM
transport failure no longer loses the learner's chat-text or answers; the
typed chat_log captures it before executeTurn's atomic context_messages batch."
```

---

## Phase C — Read path: drop envelope reads

### Task 10: Create `redactWaveChatLog.ts` — pure wire-projection

**Files:**

- Create: `src/lib/course/redactWaveChatLog.ts`
- Create: `src/lib/course/redactWaveChatLog.test.ts`

- [ ] **Step 1: Write failing unit test**

Create `src/lib/course/redactWaveChatLog.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { redactWaveChatLog } from "./redactWaveChatLog";
import { decodeCorrect } from "@/lib/security/obfuscateCorrect";
import { KEY_TO_INDEX } from "./buildLearnerInput";
import type { WaveChatLogEntry } from "@/lib/types/jsonb";

describe("redactWaveChatLog", () => {
  it("passes user-text entries through unchanged", () => {
    const log: WaveChatLogEntry[] = [{ role: "user", kind: "text", content: "hi" }];
    expect(redactWaveChatLog(log)).toEqual(log);
  });

  it("passes user-answers entries through unchanged", () => {
    const log: WaveChatLogEntry[] = [
      {
        role: "user",
        kind: "answers",
        questionnaireId: "q-1",
        responses: [{ questionId: "qid-a", choice: "A" }],
      },
    ];
    expect(redactWaveChatLog(log)).toEqual(log);
  });

  it("passes assistant-text entries through unchanged", () => {
    const log: WaveChatLogEntry[] = [{ role: "assistant", kind: "text", content: "Welcome." }];
    expect(redactWaveChatLog(log)).toEqual(log);
  });

  it("substitutes correctEnc for MC questions; preserves free-text branch", () => {
    const log: WaveChatLogEntry[] = [
      {
        role: "assistant",
        kind: "text_with_questionnaire",
        questionnaireId: "q-1",
        content: "Try these:",
        questions: [
          {
            id: "qid-mc",
            type: "multiple_choice",
            prompt: "2+2?",
            options: { A: "3", B: "4", C: "5", D: "6" },
            correct: "B",
            freetextRubric: "n/a",
          },
          {
            id: "qid-ft",
            type: "free_text",
            prompt: "Why?",
            freetextRubric: "rubric",
          },
        ],
      },
    ];
    const [entry] = redactWaveChatLog(log);
    if (!entry || entry.role !== "assistant" || entry.kind !== "text_with_questionnaire") {
      throw new Error("expected text_with_questionnaire entry");
    }
    const [mc, ft] = entry.questions;
    if (!mc || mc.type !== "multiple_choice") throw new Error("MC expected");
    if (!ft || ft.type !== "free_text") throw new Error("free_text expected");
    expect("correct" in mc).toBe(false);
    expect(decodeCorrect("qid-mc", mc.correctEnc)).toBe(KEY_TO_INDEX.B);
    expect(ft.prompt).toBe("Why?");
  });

  it("throws if an MC question is missing the correct key", () => {
    const log: WaveChatLogEntry[] = [
      {
        role: "assistant",
        kind: "text_with_questionnaire",
        questionnaireId: "q-1",
        content: "x",
        questions: [
          {
            id: "qid-mc",
            type: "multiple_choice",
            prompt: "?",
            options: { A: "1", B: "2", C: "3", D: "4" },
            // correct: missing
            freetextRubric: "n/a",
          },
        ],
      },
    ];
    expect(() => redactWaveChatLog(log)).toThrow(/correct/);
  });
});
```

Run:

```bash
bun run test src/lib/course/redactWaveChatLog.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 2: Implement `redactWaveChatLog`**

Create `src/lib/course/redactWaveChatLog.ts`:

```ts
import { encodeCorrect } from "@/lib/security/obfuscateCorrect";
import { KEY_TO_INDEX } from "./buildLearnerInput";
import type { V3Response, WaveChatLogEntry } from "@/lib/types/jsonb";

/**
 * Server → client projection of `waves.chat_log`.
 *
 * The on-disk schema stores raw MC `correct` keys (the LLM-facing path needs
 * them for grading + envelope rendering). The wire must never carry the raw
 * key — we substitute `correctEnc` (questionId-bound base64) the same way
 * `redactQuestionnaire` does for the currently-open questionnaire. The
 * substitution applies to BOTH currently-open and already-answered
 * questionnaire entries — the wire is uniformly redacted; the UI never sees
 * plaintext `correct`.
 *
 * Free-text branches pass through (no `correct` to hide). User-side entries
 * (text + answers) carry no secret; they pass through.
 *
 * Pure function. Single-pass map; no DB, no env. Tested in
 * `redactWaveChatLog.test.ts`.
 */

/** One client-safe question shape inside an `assistant.text_with_questionnaire`. */
export type WaveQuestionForClient =
  | {
      readonly id: string;
      readonly type: "multiple_choice";
      readonly prompt: string;
      readonly options: {
        readonly A: string;
        readonly B: string;
        readonly C: string;
        readonly D: string;
      };
      /** Base64-obfuscated correct index, bound to `id`. NOT cryptographic. */
      readonly correctEnc: string;
      readonly freetextRubric: string;
    }
  | {
      readonly id: string;
      readonly type: "free_text";
      readonly prompt: string;
      readonly freetextRubric: string;
    };

/** Wire-safe projection of one `WaveChatLogEntry`. */
export type WaveChatLogEntryForClient =
  | { readonly role: "user"; readonly kind: "text"; readonly content: string }
  | {
      readonly role: "user";
      readonly kind: "answers";
      readonly questionnaireId: string;
      readonly responses: readonly V3Response[];
    }
  | { readonly role: "assistant"; readonly kind: "text"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly kind: "text_with_questionnaire";
      readonly questionnaireId: string;
      readonly content: string;
      readonly questions: readonly WaveQuestionForClient[];
    };

export function redactWaveChatLog(
  entries: readonly WaveChatLogEntry[],
): readonly WaveChatLogEntryForClient[] {
  return entries.map((entry): WaveChatLogEntryForClient => {
    if (entry.role === "user") return entry;
    if (entry.kind === "text") return entry;

    // entry.kind === "text_with_questionnaire" — redact every MC question.
    const questions = entry.questions.map((q): WaveQuestionForClient => {
      if (q.type === "multiple_choice") {
        // The chat_log entry is the LLM-graded MC: `correct` must be set. If
        // somehow absent (corrupt row, schema regression), fail loud rather
        // than emit an unrenderable wire shape.
        if (q.correct === undefined) {
          throw new Error(`redactWaveChatLog: MC question id=${q.id} missing correct key`);
        }
        return {
          id: q.id,
          type: "multiple_choice",
          prompt: q.prompt,
          options: q.options,
          correctEnc: encodeCorrect(q.id, KEY_TO_INDEX[q.correct]),
          freetextRubric: q.freetextRubric,
        };
      }
      return {
        id: q.id,
        type: "free_text",
        prompt: q.prompt,
        freetextRubric: q.freetextRubric,
      };
    });

    return {
      role: "assistant",
      kind: "text_with_questionnaire",
      questionnaireId: entry.questionnaireId,
      content: entry.content,
      questions,
    };
  });
}
```

- [ ] **Step 3: Run tests, verify pass**

```bash
bun run test src/lib/course/redactWaveChatLog.test.ts
```

Expected: PASS (all 5 cases).

- [ ] **Step 4: Commit**

```bash
git add src/lib/course/redactWaveChatLog.ts src/lib/course/redactWaveChatLog.test.ts
git commit -m "feat(course): add redactWaveChatLog wire-projection

Pure single-pass projection of WaveChatLogEntry[] → wire shape with MC
correct keys substituted for correctEnc. Symmetric with redactQuestionnaire
but applies to the entire log (currently-open + answered)."
```

---

### Task 11: Rewrite `getWaveState` to read `chat_log` only

**Files:**

- Modify: `src/lib/course/getWaveState.ts` (full rewrite)
- Modify: `src/lib/course/getWaveState.integration.test.ts`

- [ ] **Step 1: Update the integration test to assert the new shape**

In `src/lib/course/getWaveState.integration.test.ts`, replace `messages` / `openQuestionnaire` assertions with `chatLog` assertions. Concrete edits:

- Delete any block asserting on `state.messages` (was `RenderedMessage[]`).
- Delete any block asserting on `state.openQuestionnaire` (was `OpenQuestionnaireForClient | null`).
- Add a new block asserting `state.chatLog` shape after seeding entries via `appendWaveChatLog`:

```ts
it("ships chat_log via the wire with MC correct redacted to correctEnc", async () => {
  const { wave } = await setupWave();
  await appendWaveChatLog(db, wave.id, {
    role: "assistant",
    kind: "text_with_questionnaire",
    questionnaireId: "qid-1",
    content: "Try this:",
    questions: [
      {
        id: "q1",
        type: "multiple_choice",
        prompt: "?",
        options: { A: "1", B: "2", C: "3", D: "4" },
        correct: "C",
        freetextRubric: "n/a",
      },
    ],
  });
  const state = await getWaveState({
    userId: TEST_USER_ID,
    courseId: wave.courseId,
    waveNumber: wave.waveNumber,
  });
  expect(state.chatLog).toHaveLength(1);
  const entry = state.chatLog[0];
  if (entry?.role !== "assistant" || entry.kind !== "text_with_questionnaire") {
    throw new Error("expected text_with_questionnaire entry");
  }
  const mc = entry.questions[0];
  if (mc?.type !== "multiple_choice") throw new Error("MC expected");
  expect("correct" in mc).toBe(false);
  expect(decodeCorrect("q1", mc.correctEnc)).toBe(KEY_TO_INDEX.C);
});
```

Add a `turnsRemaining` case asserting the count derives from user-role chat_log entries (not context_messages):

```ts
it("derives turnsRemaining from user-role chat_log entries", async () => {
  const { wave } = await setupWave();
  await appendWaveChatLog(db, wave.id, { role: "assistant", kind: "text", content: "hi" });
  await appendWaveChatLog(db, wave.id, { role: "user", kind: "text", content: "u1" });
  await appendWaveChatLog(db, wave.id, { role: "assistant", kind: "text", content: "a1" });
  const state = await getWaveState({
    /* same args */
  });
  expect(state.turnsRemaining).toBe(WAVE.turnCount - 1); // one user entry consumed
});
```

Run:

```bash
bun run test:integration src/lib/course/getWaveState.integration.test.ts
```

Expected: FAIL — `WaveState` doesn't have `chatLog` yet.

- [ ] **Step 2: Rewrite `getWaveState.ts`**

Replace the full contents of `src/lib/course/getWaveState.ts` with:

```ts
import { TRPCError } from "@trpc/server";
import { getWaveByCourseAndNumber } from "@/db/queries/waves";
import { getCourseById } from "@/db/queries/courses";
import { WAVE } from "@/lib/config/tuning";
import { redactWaveChatLog, type WaveChatLogEntryForClient } from "./redactWaveChatLog";

/**
 * Client-facing projection of a wave's state.
 *
 * Mirrors scoping's `getState`: reads typed JSONB on the parent entity
 * (`waves.chat_log`) and ships a wire-redacted projection. No
 * context_messages access from this path — replay-log byte stability is no
 * longer load-bearing for the chat scroll.
 *
 * `chatLog` replaces what used to be two fields (`messages` envelope strings +
 * `openQuestionnaire` server-derived shape). The client derives the active
 * questionnaire from `chatLog` in `useWaveState`, mirroring `useScopingState`.
 */

/** Full wave-state projection returned to the client. */
export interface WaveState {
  readonly courseId: string;
  readonly waveId: string;
  readonly waveNumber: number;
  readonly currentTier: number;
  readonly status: "active" | "closed";
  readonly turnsRemaining: number;
  readonly chatLog: readonly WaveChatLogEntryForClient[];
  /**
   * Always `null` on `getWaveState` — close result is the response payload of
   * `submitWaveTurn`, not a re-readable wave property (spec §7.2). Kept on the
   * wire shape for client-side union stability.
   */
  readonly closeResult: null | {
    readonly closingMessage: string;
    readonly nextWaveNumber: number;
    readonly completionXpAwarded: number;
    readonly tierAdvancedTo: number | null;
  };
}

/** Input to {@link getWaveState}. `userId` enforces row-level ownership. */
export interface GetWaveStateParams {
  readonly userId: string;
  readonly courseId: string;
  readonly waveNumber: number;
}

/**
 * Load the full state for one Wave by its ordinal `waveNumber`.
 *
 * Resolution chain:
 *   1. Resolve `(courseId, waveNumber)` → wave row. NOT_FOUND if absent.
 *   2. Ownership check: load the course as the requesting user. Cross-user
 *      reads surface as NOT_FOUND (info-leak-safe).
 *   3. Cross-course containment: wave.courseId must equal the loaded course.
 *   4. Read chat_log (already parsed by waveRowGuard). Redact MC correct keys.
 *   5. turnsRemaining = max(0, WAVE.turnCount - count(user-role entries)).
 */
export async function getWaveState(params: GetWaveStateParams): Promise<WaveState> {
  const wave = await getWaveByCourseAndNumber(params.courseId, params.waveNumber);
  if (!wave) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: `wave ${params.waveNumber} not found for course ${params.courseId}`,
    });
  }
  // Ownership + cross-course containment.
  const course = await getCourseById(params.courseId, params.userId);
  if (wave.courseId !== course.id) {
    throw new TRPCError({ code: "FORBIDDEN", message: "wave does not belong to course" });
  }

  const chatLog = redactWaveChatLog(wave.chatLog);
  const consumed = wave.chatLog.filter((e) => e.role === "user").length;
  const turnsRemaining = Math.max(0, WAVE.turnCount - consumed);
  const wireStatus: "active" | "closed" = wave.status === "closed" ? "closed" : "active";

  return {
    courseId: course.id,
    waveId: wave.id,
    waveNumber: wave.waveNumber,
    currentTier: wave.tier,
    status: wireStatus,
    turnsRemaining,
    chatLog,
    closeResult: null,
  };
}
```

`RenderedMessage` and the old `openQuestionnaire` projection both disappear from this file — they're no longer part of the wire shape.

- [ ] **Step 3: Run test, verify pass**

```bash
bun run test:integration src/lib/course/getWaveState.integration.test.ts
```

Expected: PASS — new shape assertions hold.

- [ ] **Step 4: Commit**

```bash
git add src/lib/course/getWaveState.ts src/lib/course/getWaveState.integration.test.ts
git commit -m "refactor(course): getWaveState reads chat_log, drops envelope path

WaveState wire shape: chatLog replaces messages + openQuestionnaire. Server
no longer ships context_messages envelope strings to the client; the chat
scroll renders from the typed JSONB store. Mirror of scoping's getState."
```

---

### Task 12: Collapse `loadWaveContext` (delete `reconstructOpenQuestionnaire`)

**Files:**

- Modify: `src/lib/course/loadWaveContext.ts` (rewrite)
- Modify: `src/lib/course/loadWaveContext.integration.test.ts` (shrink)

- [ ] **Step 1: Trim the integration test**

In `src/lib/course/loadWaveContext.integration.test.ts`, delete all cases that assert on `result.openQuestionnaire` (lines ~95–185 area). Keep only:

- The ownership check (course owned by another user → NOT_FOUND).
- The cross-course containment check (wave.courseId !== course.id → FORBIDDEN).
- A happy-path case that returns `{course, wave}` for a valid (user, course, wave) triple.

Run:

```bash
bun run test:integration src/lib/course/loadWaveContext.integration.test.ts
```

Expected: those three should pass after the rewrite below; everything else gone.

- [ ] **Step 2: Rewrite `loadWaveContext.ts`**

Replace the full contents with:

```ts
import { TRPCError } from "@trpc/server";
import { getCourseById } from "@/db/queries/courses";
import { getWaveById } from "@/db/queries/waves";
import type { Course, Wave } from "@/db/schema";

/**
 * One round-trip fetch + access-control check for a (user, course, wave)
 * triple. Used by `submitWaveTurn` (and any future server-side path that
 * needs the loaded course + wave pair).
 *
 * Open-questionnaire reconstruction is gone — it now lives on the typed
 * `waves.chat_log` and is derived by a tiny pure helper
 * (`findOpenQuestionnaire` in `submitWaveTurn.ts`) when needed.
 */
export interface LoadedWaveContext {
  readonly course: Course;
  readonly wave: Wave;
}

/**
 * Load (course, wave) and enforce ownership + cross-course containment.
 *
 * NOT_FOUND from `getCourseById` is the info-leak-safe response for both
 * "no such course" and "course owned by another user". FORBIDDEN for the
 * cross-course mismatch is a real condition: the wave id exists but doesn't
 * belong to the requesting user's course.
 */
export async function loadWaveContext(params: {
  readonly userId: string;
  readonly courseId: string;
  readonly waveId: string;
}): Promise<LoadedWaveContext> {
  const course = await getCourseById(params.courseId, params.userId);
  const wave = await getWaveById(params.waveId);
  if (wave.courseId !== course.id) {
    throw new TRPCError({ code: "FORBIDDEN", message: "wave does not belong to course" });
  }
  return { course, wave };
}
```

The whole `reconstructOpenQuestionnaire` + `safeJsonParse` block is deleted.

- [ ] **Step 3: Confirm all callers still compile**

`loadWaveContext`'s callers are: `submitWaveTurn`, `executeWaveClose` (likely), `getWaveState` (which already lost it in Task 11). Run typecheck:

```bash
bun run typecheck
```

Expected: errors at every site that read `ctx.openQuestionnaire`. List them — these become the targets for Task 13.

- [ ] **Step 4: Commit (intentional broken build accepted; next task fixes)**

This task intentionally leaves the build broken because the open-questionnaire concept moves locations in the next task. Skip the commit here — instead, batch the loadWaveContext rewrite into Task 13's commit so the tree stays buildable between commits.

Mark this checkbox done but defer the commit.

---

### Task 13: Move open-questionnaire lookup into `submitWaveTurn` + add `findOpenQuestionnaire` helper

**Files:**

- Create: `src/lib/course/findOpenQuestionnaire.ts`
- Create: `src/lib/course/findOpenQuestionnaire.test.ts`
- Modify: `src/lib/course/submitWaveTurn.ts`
- Modify: `src/lib/course/executeWaveMid.ts`

- [ ] **Step 1: Write the failing unit test**

Create `src/lib/course/findOpenQuestionnaire.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { findOpenQuestionnaire } from "./findOpenQuestionnaire";
import type { WaveChatLog } from "@/lib/types/jsonb";

describe("findOpenQuestionnaire", () => {
  it("returns null when there are no entries", () => {
    expect(findOpenQuestionnaire([])).toBeNull();
  });

  it("returns null when no text_with_questionnaire has been emitted", () => {
    const log: WaveChatLog = [
      { role: "assistant", kind: "text", content: "hi" },
      { role: "user", kind: "text", content: "ok" },
    ];
    expect(findOpenQuestionnaire(log)).toBeNull();
  });

  it("returns the latest unanswered questionnaire", () => {
    const log: WaveChatLog = [
      {
        role: "assistant",
        kind: "text_with_questionnaire",
        questionnaireId: "q-1",
        content: "first card",
        questions: [
          {
            id: "qa",
            type: "multiple_choice",
            prompt: "?",
            options: { A: "1", B: "2", C: "3", D: "4" },
            correct: "A",
            freetextRubric: "n/a",
          },
        ],
      },
    ];
    const open = findOpenQuestionnaire(log);
    expect(open?.questionnaireId).toBe("q-1");
    expect(open?.questions).toHaveLength(1);
  });

  it("returns null once a user.answers references the latest questionnaire id", () => {
    const log: WaveChatLog = [
      {
        role: "assistant",
        kind: "text_with_questionnaire",
        questionnaireId: "q-1",
        content: "card",
        questions: [
          {
            id: "qa",
            type: "free_text",
            prompt: "Why?",
            freetextRubric: "n/a",
          },
        ],
      },
      {
        role: "user",
        kind: "answers",
        questionnaireId: "q-1",
        responses: [{ questionId: "qa", freetext: "because" }],
      },
    ];
    expect(findOpenQuestionnaire(log)).toBeNull();
  });
});
```

Run:

```bash
bun run test src/lib/course/findOpenQuestionnaire.test.ts
```

Expected: FAIL — module doesn't exist.

- [ ] **Step 2: Implement `findOpenQuestionnaire`**

Create `src/lib/course/findOpenQuestionnaire.ts`:

```ts
import type { WaveChatLog } from "@/lib/types/jsonb";
import type { OpenQuestionnaireRecord } from "./buildLearnerInput";

/**
 * Find the currently-open questionnaire on a wave, or null if none.
 *
 * Open = the latest `assistant.text_with_questionnaire` entry whose
 * `questionnaireId` is NOT referenced by any later `user.answers` entry. Pure;
 * a single linear scan. Replaces the deleted
 * `loadWaveContext.reconstructOpenQuestionnaire` (which re-parsed envelope
 * JSON from `context_messages.content` — see ARCHITECTURE.md for why that
 * envelope-read coupling went away).
 *
 * Produces an `OpenQuestionnaireRecord` (the server-side shape used by
 * `buildLearnerInput` for envelope rendering and by `executeWaveMid` for
 * mechanical MC correctness). The wire-side projection
 * (`WaveChatLogEntryForClient`) is computed separately by
 * `redactWaveChatLog`.
 */
export function findOpenQuestionnaire(log: WaveChatLog): OpenQuestionnaireRecord | null {
  // Walk from the end. Identity of the open questionnaire is determined by
  // whichever text_with_questionnaire is latest AND lacks a later answers entry.
  const lastQIdx = log.findLastIndex(
    (e) => e.role === "assistant" && e.kind === "text_with_questionnaire",
  );
  if (lastQIdx === -1) return null;
  const cand = log[lastQIdx];
  if (cand?.role !== "assistant" || cand.kind !== "text_with_questionnaire") return null;
  const answered = log
    .slice(lastQIdx + 1)
    .some(
      (e) =>
        e.role === "user" && e.kind === "answers" && e.questionnaireId === cand.questionnaireId,
    );
  if (answered) return null;

  // Project to the server-side record shape. MC carries `correct` (server-
  // side truth); the wire-redaction path computes correctEnc elsewhere.
  const questions = cand.questions.map((q) => {
    if (q.type === "multiple_choice") {
      return {
        id: q.id,
        type: "multiple_choice" as const,
        prompt: q.prompt,
        options: q.options,
        correct: q.correct,
        freetextRubric: q.freetextRubric,
      };
    }
    return {
      id: q.id,
      type: "free_text" as const,
      prompt: q.prompt,
      freetextRubric: q.freetextRubric,
    };
  });
  return { questionnaireId: cand.questionnaireId, questions };
}
```

Run the test:

```bash
bun run test src/lib/course/findOpenQuestionnaire.test.ts
```

Expected: PASS (all 4 cases).

- [ ] **Step 3: Update `submitWaveTurn` to derive openQ from chat_log**

In `src/lib/course/submitWaveTurn.ts`, replace the line that reads `const { openQuestionnaire } = ctx;` (around `:84`) with:

```ts
// Open questionnaire is derived from chat_log here — loadWaveContext no
// longer carries it. The find helper is a single linear scan; cheap.
const openQuestionnaire = findOpenQuestionnaire(ctx.wave.chatLog);
```

Add the import:

```ts
import { findOpenQuestionnaire } from "./findOpenQuestionnaire";
```

The §7.4 mutual-exclusion guards below (`:85-121`) are unchanged — they already consume the local `openQuestionnaire` variable.

Also remove `consumed`-from-context_messages computation; switch to chat_log: replace the block at `:127-130` with:

```ts
// Turns consumed = user-role entries in chat_log. After this turn's
// executeWaveMid persists its assistant entry + this fn's pre-LLM user
// entry, consumed advances by exactly 1. WAVE.turnCount is the budget;
// turnsRemaining = budget - (current + about-to-land). Clamp at 0.
const consumed = ctx.wave.chatLog.filter((e) => e.role === "user").length;
const turnsRemaining = Math.max(0, WAVE.turnCount - (consumed + 1));
const isCloseTurn = turnsRemaining === 0;
```

(Drop the `getMessagesForWave` import + call from the top of the file — both go.)

Pass `openQuestionnaire` to `buildLearnerInput` and to `executeWaveMid` exactly as before; the variable is already in scope.

- [ ] **Step 4: Update `executeWaveMid` to derive openQ from chat_log too**

`executeWaveMid` reads `ctx.openQuestionnaire` in two places (lines `:123` and `:171`). Replace both with a `findOpenQuestionnaire(ctx.wave.chatLog)` call captured in a local at the top of the function:

```ts
import { findOpenQuestionnaire } from "./findOpenQuestionnaire";
```

Top of `executeWaveMid`:

```ts
// Resolve open questionnaire once for grading-time lookups (correctLetterMap)
// and the gradePriorAnswers `hasOpenQuestionnaire` flag.
const openQuestionnaire = findOpenQuestionnaire(ctx.wave.chatLog);
```

Then:

- Line `:123`: `hasOpenQuestionnaire: ctx.openQuestionnaire !== null` → `hasOpenQuestionnaire: openQuestionnaire !== null`.
- Line `:170-180`: `buildCorrectLetterMap(ctx)` now needs `openQuestionnaire`, not `ctx`. Inline it:

```ts
const correctLetterById: ReadonlyMap<string, "A" | "B" | "C" | "D"> = openQuestionnaire
  ? new Map(
      openQuestionnaire.questions
        .filter(
          (q): q is typeof q & { readonly correct: "A" | "B" | "C" | "D" } =>
            q.type === "multiple_choice" && q.correct !== undefined,
        )
        .map((q) => [q.id, q.correct] as const),
    )
  : new Map();
```

Delete the standalone `buildCorrectLetterMap` function — its only call site is here.

- [ ] **Step 5: Update `executeWaveClose` if it reads `ctx.openQuestionnaire`**

```bash
grep -n "ctx.openQuestionnaire\|openQuestionnaire" src/lib/course/executeWaveClose.ts
```

If any reference exists, follow the same pattern: derive locally from `findOpenQuestionnaire(ctx.wave.chatLog)`. (Per Task 11 / 12, `LoadedWaveContext` no longer carries the field, so the typechecker will surface every site.)

- [ ] **Step 6: Run typecheck + full integration tests**

```bash
bun run typecheck
bun run test:integration src/lib/course/
```

Expected: typecheck clean; integration tests pass. The `loadWaveContext.integration.test.ts` cases that survived from Task 12 also pass.

- [ ] **Step 7: Commit (batched with Task 12)**

```bash
git add src/lib/course/loadWaveContext.ts src/lib/course/loadWaveContext.integration.test.ts src/lib/course/findOpenQuestionnaire.ts src/lib/course/findOpenQuestionnaire.test.ts src/lib/course/submitWaveTurn.ts src/lib/course/executeWaveMid.ts src/lib/course/executeWaveClose.ts
git commit -m "refactor(course): move open-questionnaire lookup off context_messages

loadWaveContext collapses to ownership + cross-course containment only
(~137 → ~25 lines). findOpenQuestionnaire (pure, scans chat_log) replaces
the deleted reconstructOpenQuestionnaire envelope re-parse. submitWaveTurn,
executeWaveMid, executeWaveClose all derive openQ from the typed chat_log."
```

---

## Phase D — Projection + UI

### Task 14: Rewrite `deriveWaveTurns` for the new signature

**Files:**

- Modify: `src/lib/course/deriveWaveTurns.ts` (full rewrite)
- Modify: `src/lib/course/deriveWaveTurns.test.ts` (full rewrite)

- [ ] **Step 1: Replace the test file**

Replace the full contents of `src/lib/course/deriveWaveTurns.test.ts` with fixtures that match the new signature:

```ts
import { describe, it, expect } from "vitest";
import { deriveWaveTurns } from "./deriveWaveTurns";
import type { WaveChatLogEntryForClient } from "./redactWaveChatLog";

const userText = (content: string): WaveChatLogEntryForClient => ({
  role: "user",
  kind: "text",
  content,
});
const userAnswers = (
  questionnaireId: string,
  responses: WaveChatLogEntryForClient extends infer T
    ? T extends { kind: "answers"; responses: infer R }
      ? R
      : never
    : never,
): WaveChatLogEntryForClient => ({
  role: "user",
  kind: "answers",
  questionnaireId,
  responses,
});
const assistantText = (content: string): WaveChatLogEntryForClient => ({
  role: "assistant",
  kind: "text",
  content,
});
const assistantQ = (
  questionnaireId: string,
  content: string,
  questions: WaveChatLogEntryForClient extends infer T
    ? T extends { kind: "text_with_questionnaire"; questions: infer Q }
      ? Q
      : never
    : never,
): WaveChatLogEntryForClient => ({
  role: "assistant",
  kind: "text_with_questionnaire",
  questionnaireId,
  content,
  questions,
});

describe("deriveWaveTurns", () => {
  it("returns empty array on empty log", () => {
    expect(deriveWaveTurns([])).toEqual([]);
  });

  it("maps user-text → user-text, assistant-text → assistant-text", () => {
    const log: WaveChatLogEntryForClient[] = [
      assistantText("Welcome."),
      userText("Tell me more."),
      assistantText("Sure."),
    ];
    expect(deriveWaveTurns(log)).toEqual([
      { kind: "assistant-text", content: "Welcome." },
      { kind: "user-text", content: "Tell me more." },
      { kind: "assistant-text", content: "Sure." },
    ]);
  });

  it("formats user-answers via formatAnswers using the matching questionnaire's questions", () => {
    const log: WaveChatLogEntryForClient[] = [
      assistantQ("q-1", "Try this:", [
        {
          id: "qa",
          type: "multiple_choice",
          prompt: "?",
          options: { A: "1", B: "2", C: "3", D: "4" },
          correctEnc: "enc",
          freetextRubric: "n/a",
        },
      ]),
      userAnswers("q-1", [{ questionId: "qa", choice: "B" }]),
    ];
    const turns = deriveWaveTurns(log);
    // The answered questionnaire emits as plain assistant-text (no open Q).
    expect(turns[0]).toEqual({ kind: "assistant-text", content: "Try this:" });
    expect(turns[1]).toEqual({
      kind: "user-questionnaire-answers",
      content: "1. ? — 2",
    });
  });

  it("emits assistant-text-with-questionnaire for the LATEST unanswered text_with_questionnaire", () => {
    const log: WaveChatLogEntryForClient[] = [
      assistantQ("q-1", "Old card", [
        { id: "qa", type: "free_text", prompt: "Why?", freetextRubric: "n/a" },
      ]),
      userAnswers("q-1", [{ questionId: "qa", freetext: "because" }]),
      assistantQ("q-2", "New card", [
        { id: "qb", type: "free_text", prompt: "How?", freetextRubric: "n/a" },
      ]),
    ];
    const turns = deriveWaveTurns(log);
    expect(turns[0]).toEqual({ kind: "assistant-text", content: "Old card" }); // answered → text
    expect(turns[2]).toEqual({
      kind: "assistant-text-with-questionnaire",
      content: "New card",
      questionnaire: {
        questionnaireId: "q-2",
        questions: [{ id: "qb", type: "free_text", prompt: "How?", freetextRubric: "n/a" }],
      },
    });
  });
});
```

Run:

```bash
bun run test src/lib/course/deriveWaveTurns.test.ts
```

Expected: FAIL — `deriveWaveTurns` still has the old signature.

- [ ] **Step 2: Rewrite `deriveWaveTurns.ts`**

Replace contents of `src/lib/course/deriveWaveTurns.ts`:

```ts
import type { Turn } from "@/lib/types/turn";
import { formatAnswers } from "./deriveTurns";
import type { WaveChatLogEntryForClient } from "./redactWaveChatLog";
import type { V3Question } from "@/lib/types/jsonb";

/**
 * Project the wave's wire-redacted chat log to `Turn[]` for the chat scroll.
 *
 * Pure. Single linear pass + one `findLastIndex` for the open-questionnaire
 * id resolution. No DB, no DOM.
 *
 * Algorithm:
 *   - The latest `assistant.text_with_questionnaire` whose id has no later
 *     `user.answers` is the OPEN questionnaire; only that entry emits
 *     `assistant-text-with-questionnaire`. Closed (already-answered) cards
 *     fall back to plain `assistant-text` (their prose still renders; the
 *     Composer never re-shows locked questionnaires).
 *   - `user.answers` formats via the shared `formatAnswers` helper, looking
 *     up the matching questionnaire's questions for prompt text. If the
 *     questionnaire isn't found (corrupt log), the helper falls back to
 *     `Q{n}` and renders something rather than crashing.
 *
 * `move-on-cta` is NOT emitted here — wave move-on is driven by
 * `useWaveState`'s `closeResult`, not by chat_log.
 */
export function deriveWaveTurns(log: readonly WaveChatLogEntryForClient[]): readonly Turn[] {
  // Open questionnaire id = latest text_with_questionnaire whose id has no
  // later user.answers match. Computed once; used inside the map.
  const lastQIdx = log.findLastIndex(
    (e) => e.role === "assistant" && e.kind === "text_with_questionnaire",
  );
  const openId = (() => {
    if (lastQIdx === -1) return null;
    const cand = log[lastQIdx];
    if (cand?.role !== "assistant" || cand.kind !== "text_with_questionnaire") return null;
    const answered = log
      .slice(lastQIdx + 1)
      .some(
        (e) =>
          e.role === "user" && e.kind === "answers" && e.questionnaireId === cand.questionnaireId,
      );
    return answered ? null : cand.questionnaireId;
  })();

  return log.map((entry, idx): Turn => {
    if (entry.role === "user" && entry.kind === "text") {
      return { kind: "user-text", content: entry.content };
    }
    if (entry.role === "user" && entry.kind === "answers") {
      // formatAnswers needs `V3Question[]` — the client wire shape has
      // `correctEnc` instead of `correct`, but the formatter only reads
      // `prompt`, `type`, and `options`, so a structural projection works.
      const qEntry = log
        .slice(0, idx)
        .find(
          (e) =>
            e.role === "assistant" &&
            e.kind === "text_with_questionnaire" &&
            e.questionnaireId === entry.questionnaireId,
        );
      const questions: readonly V3Question[] =
        qEntry?.role === "assistant" && qEntry.kind === "text_with_questionnaire"
          ? qEntry.questions.map((q) =>
              q.type === "multiple_choice"
                ? {
                    id: q.id,
                    type: "multiple_choice",
                    prompt: q.prompt,
                    options: q.options,
                    freetextRubric: q.freetextRubric,
                  }
                : {
                    id: q.id,
                    type: "free_text",
                    prompt: q.prompt,
                    freetextRubric: q.freetextRubric,
                  },
            )
          : [];
      return {
        kind: "user-questionnaire-answers",
        content: formatAnswers(questions, entry.responses),
      };
    }
    if (entry.role === "assistant" && entry.kind === "text") {
      return { kind: "assistant-text", content: entry.content };
    }
    // entry.role === "assistant" && entry.kind === "text_with_questionnaire"
    if (entry.questionnaireId === openId) {
      return {
        kind: "assistant-text-with-questionnaire",
        content: entry.content,
        questionnaire: {
          questionnaireId: entry.questionnaireId,
          questions: entry.questions,
        },
      };
    }
    return { kind: "assistant-text", content: entry.content };
  });
}
```

- [ ] **Step 3: Run test, verify pass**

```bash
bun run test src/lib/course/deriveWaveTurns.test.ts
```

Expected: PASS (all 4 cases).

- [ ] **Step 4: Commit**

```bash
git add src/lib/course/deriveWaveTurns.ts src/lib/course/deriveWaveTurns.test.ts
git commit -m "refactor(course): rewrite deriveWaveTurns to consume chat_log

Single-arg projection over WaveChatLogEntryForClient[]. Open-questionnaire
detection moves into this pure function (mirrors useScopingState's pattern).
formatAnswers reused from deriveTurns; no duplicated formatter."
```

---

### Task 15: Update `useWaveState` for the new wire shape

**Files:**

- Modify: `src/hooks/useWaveState.ts`
- Modify: `src/hooks/useWaveState.test.tsx`

- [ ] **Step 1: Rewrite the test fixture for the new shape**

In `src/hooks/useWaveState.test.tsx`, replace the `stateData` constant (lines ~22–41) with the new shape:

```ts
const stateData = {
  courseId: "c1",
  waveId: "w1",
  waveNumber: 1,
  currentTier: 1,
  status: "active" as const,
  turnsRemaining: 9,
  chatLog: [{ role: "assistant", kind: "text", content: "Welcome to wave 1." }] as const,
  closeResult: null,
};
```

The existing test bodies assert on `result.current.turns[0]` content and on `activeQuestionnaire` being null — both stay valid; only the source field changed.

Add a new test for the active-questionnaire derivation:

```ts
it("derives activeQuestionnaire from chatLog when a text_with_questionnaire is open", async () => {
  // Re-stub stateData for this test by re-defining the mock inline.
  const localState = {
    ...stateData,
    chatLog: [
      { role: "assistant", kind: "text", content: "Welcome." },
      {
        role: "assistant",
        kind: "text_with_questionnaire",
        questionnaireId: "q-1",
        content: "Try this:",
        questions: [
          {
            id: "qa",
            type: "multiple_choice",
            prompt: "?",
            options: { A: "1", B: "2", C: "3", D: "4" },
            correctEnc: "enc",
            freetextRubric: "n/a",
          },
        ],
      },
    ],
  };
  // (Adapt the existing vi.mock("@/lib/trpc", ...) to use `localState` here, or
  // refactor the mock to read from a `let currentState` cell that tests assign.)
  // ... renderHook ... waitFor ...
  expect(result.current.activeQuestionnaire?.questionsKey).toBe("q-1");
});
```

Wiring tip: the existing `vi.mock("@/lib/trpc", ...)` closes over `stateData`. The cleanest path is to change `stateData` to a mutable `let currentState` cell that each test assigns at the top. Mirror the pattern already used for `latestOnSuccess`.

Run:

```bash
bun run test src/hooks/useWaveState.test.tsx
```

Expected: FAIL — `state.data.messages` access in useWaveState references a field that no longer exists on the new fixture.

- [ ] **Step 2: Rewrite `useWaveState.ts`**

Replace the body of `src/hooks/useWaveState.ts` (the parts that derive `turns` and `activeQuestionnaire`) to consume `chatLog`. Full replacement of the two `useMemo` blocks (currently `:96-115`):

```ts
// Derive Turn[] from chat_log. Pure; safe to run on every render
// (memoized for stability across consumer re-renders).
const turns = useMemo<readonly Turn[]>(
  () => (state.data ? deriveWaveTurns(state.data.chatLog) : []),
  [state.data],
);

// Active questionnaire for the Composer: latest assistant.text_with_questionnaire
// whose id has no later user.answers in the chat log. Mirrors useScopingState's
// derivation pattern — same ActiveQuestionnaire shape.
const activeQuestionnaire = useMemo<ActiveQuestionnaire | null>(() => {
  if (!state.data) return null;
  const log = state.data.chatLog;
  const lastQIdx = log.findLastIndex(
    (e) => e.role === "assistant" && e.kind === "text_with_questionnaire",
  );
  if (lastQIdx === -1) return null;
  const lastQ = log[lastQIdx];
  if (lastQ?.role !== "assistant" || lastQ.kind !== "text_with_questionnaire") return null;
  const answered = log
    .slice(lastQIdx + 1)
    .some(
      (e) =>
        e.role === "user" && e.kind === "answers" && e.questionnaireId === lastQ.questionnaireId,
    );
  if (answered) return null;
  return {
    kind: "wave",
    questions: lastQ.questions.map(adaptOpenQuestion),
    questionsKey: lastQ.questionnaireId,
    persistKey: `nalu:wave:${state.data.waveId}:q:${lastQ.questionnaireId}`,
  };
}, [state.data]);
```

And replace the `submitQuestionnaireAnswers` body's `questionnaireId` lookup. Currently:

```ts
const questionnaireId = state.data?.openQuestionnaire?.questionnaireId;
```

Becomes:

```ts
const questionnaireId = activeQuestionnaire?.questionsKey;
```

(The `questionsKey` was set to the `questionnaireId` in the memo above; reuse it rather than re-scanning.)

- [ ] **Step 3: Run tests, verify pass**

```bash
bun run test src/hooks/useWaveState.test.tsx
```

Expected: PASS for all cases including the new derivation test.

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useWaveState.ts src/hooks/useWaveState.test.tsx
git commit -m "refactor(hooks): useWaveState consumes chatLog wire shape

Mirrors useScopingState: client-side derivation of activeQuestionnaire from
the typed log. Drops dependence on the old getWaveState.messages +
openQuestionnaire fields."
```

---

### Task 16: Update router integration + live tests for the new shape

**Files:**

- Modify: `src/server/routers/wave.ts` (TSDoc only)
- Modify: `src/server/routers/wave.integration.test.ts`
- Modify: `src/server/routers/wave.live.test.ts`

- [ ] **Step 1: Update TSDoc in `wave.ts`**

In `src/server/routers/wave.ts:18` (the `getState` TSDoc):

```ts
/** Restore wave state by ordinal (spec §7.1) — chatLog, turnsRemaining, closeResult. */
```

No code change here — the router is a transparent passthrough to `getWaveState`, and `getWaveState`'s wire shape was already updated in Task 11.

- [ ] **Step 2: Update `wave.integration.test.ts`**

Find every `state.openQuestionnaire` and `state.messages` reference and update to the new shape. Concretely, line 239 (`expect(state.openQuestionnaire).toBeNull();`) becomes a check that no open questionnaire is derivable from chatLog:

```ts
expect(
  state.chatLog.findLast((e) => e.role === "assistant" && e.kind === "text_with_questionnaire"),
).toBeUndefined();
```

(Or, simpler if no questionnaire-entry is expected at all: `expect(state.chatLog.some((e) => e.role === "assistant" && e.kind === "text_with_questionnaire")).toBe(false);`)

Run:

```bash
bun run test:integration src/server/routers/wave.integration.test.ts
```

Expected: PASS.

- [ ] **Step 3: Update `wave.live.test.ts` to read chatLog**

In `src/server/routers/wave.live.test.ts:182-188`, replace the open-questionnaire detection with the chatLog-derived form:

```ts
const lastQEntry = state.chatLog.findLast(
  (e) => e.role === "assistant" && e.kind === "text_with_questionnaire",
);
const hadOpenQuestionnaireBefore =
  lastQEntry !== undefined &&
  !state.chatLog.some(
    (e) =>
      e.role === "user" && e.kind === "answers" && e.questionnaireId === lastQEntry.questionnaireId,
  );
const payload =
  lastQEntry && hadOpenQuestionnaireBefore
    ? {
        kind: "questionnaire-answers",
        questionnaireId: lastQEntry.questionnaireId,
        answers: lastQEntry.questions.map((q) =>
          q.type === "multiple_choice"
            ? { id: q.id, kind: "mc", selected: "A" }
            : { id: q.id, kind: "freetext", text: "answer", fromEscape: false },
        ),
      }
    : { kind: "chat-text", text: "go on" };
```

(Keep the rest of the live test's loop body intact; only the open-questionnaire detection logic changed.)

DO NOT run `just smoke` — it requires Touch ID. The live test is structurally adjusted only; the user runs the smoke test after Task 17's verification step.

- [ ] **Step 4: Commit**

```bash
git add src/server/routers/wave.ts src/server/routers/wave.integration.test.ts src/server/routers/wave.live.test.ts
git commit -m "test(wave): update router integration + live tests for chatLog wire

No router code change — the procedure forwards to getWaveState. Tests
update fixture shape to match the new WaveState wire (chatLog replacing
messages + openQuestionnaire)."
```

---

## Phase E — Verification

### Task 17: Full local check + cleanup dead code

**Files:**

- Search for dead-code: `RenderedMessage`, `getMessagesForWave` (read-side), `OpenQuestionnaireForClient` callers, `redactQuestionnaire`.

- [ ] **Step 1: Hunt for `RenderedMessage` references**

```bash
grep -rn "RenderedMessage" src/ --include="*.ts" --include="*.tsx"
```

Expected: the type was exported from `getWaveState.ts`. After Task 11 it shouldn't be used anywhere. Confirm zero references; if any remain (e.g. an unused import), delete them.

- [ ] **Step 2: Hunt for `getMessagesForWave` UI-side callers**

```bash
grep -rn "getMessagesForWave" src/ --include="*.ts" --include="*.tsx"
```

Expected: only callers should be the LLM-replay path (renderContext, executeTurn internals) and the persistence integration tests. UI/projection path should have none. Document any remaining call site in a comment if the call is needed for assertions in integration tests.

- [ ] **Step 3: Check `redactQuestionnaire`/`OpenQuestionnaireForClient`**

```bash
grep -rn "redactQuestionnaire\|OpenQuestionnaireForClient" src/ --include="*.ts" --include="*.tsx"
```

Expected: `redactQuestionnaire` should now only be referenced by its own test file (if at all post-collapse). If `OpenQuestionnaireForClient` and `redactQuestionnaire` have no non-test consumers, delete:

- `src/lib/course/redactQuestionnaire.ts`
- `src/lib/course/redactQuestionnaire.test.ts`

If the test still has incidental coverage value, keep the file alive but verify it isn't imported anywhere outside tests.

- [ ] **Step 4: Run `just check`**

```bash
just check
```

Expected: typecheck + lint + all unit + integration tests pass.

If any step fails, fix in place and re-run. **Do NOT bypass git hooks** — fix root causes.

- [ ] **Step 5: Wipe local dev data before manual smoke (if user requests)**

Document in the PR description: developers wishing to run a local manual smoke must first execute:

```sql
TRUNCATE waves, courses CASCADE;
```

against their local DB. (Wave 1 entries written by the prior code path don't have `chat_log`; the UI would render an empty scroll.)

Do NOT run `just smoke` — the controller (you) cannot pass Touch ID for the user. The user runs `just smoke` once the controller confirms `just check` is green.

- [ ] **Step 6: Final commit + PR readiness signal**

If any cleanup commits accumulated (dead-code removal), batch them now:

```bash
git add -A
git commit -m "chore: remove dead UI projection code superseded by chatLog refactor

Drops RenderedMessage and (if unused) redactQuestionnaire / OpenQuestionnaireForClient.
The chat scroll's source of truth is now waves.chat_log end-to-end."
```

Then signal to the user: `just check` is green; smoke is the user's call.

---

## Subagent dispatch notes

This plan is structured for `superpowers:subagent-driven-development` with Opus 4.7 implementer + reviewer subagents on branch `feat/teaching-loop` (not a worktree — per `feedback_subagent_branches_not_worktrees.md`).

- **Per-task discipline:** fresh subagent per task, two-stage review (spec compliance → code quality), controller verifies `just check` (typecheck + lint + tests) green locally before marking done.
- **Live smoke:** runs AFTER Task 17, by the user, via `just smoke` (Touch ID required — controller cannot run it). Per `feedback_op_run_requires_biometric.md`.
- **Commit cadence:** every task ends with one commit (Task 12 batches into Task 13's commit by design — flagged in-task). No `--no-verify` ever.
- **Branch hygiene:** all commits on `feat/teaching-loop`. Final PR via `superpowers:finishing-a-development-branch`.

## Self-review (spec coverage check)

Spec section → plan task mapping:

| Spec section                                             | Task(s)                                                                                                                                    |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| §1 Architecture (lockstep with scoping)                  | Tasks 4, 6–11 collectively realise the symmetric pattern                                                                                   |
| §2 Shape `waves.chat_log`                                | Task 1 (schema + types), Task 2 (column)                                                                                                   |
| §3 Persist call sites (3 places)                         | Task 6 (persistScopingClose Wave 1), Task 7 (persistWaveClose), Task 8 (executeWaveMid assistant), Task 9 (submitWaveTurn pre-LLM learner) |
| DRY inventory: shared formatAnswers                      | Task 5                                                                                                                                     |
| DRY inventory: appendWaveChatLog helper                  | Task 4                                                                                                                                     |
| §4 Read path + WaveState wire change                     | Task 10 (redact projection), Task 11 (getWaveState rewrite)                                                                                |
| §4 loadWaveContext collapses                             | Task 12                                                                                                                                    |
| §4 client-side activeQuestionnaire derivation            | Task 15                                                                                                                                    |
| §4 submitWaveTurn echo-id validation via direct scan     | Task 13                                                                                                                                    |
| §5 deriveWaveTurns rewrite                               | Task 14                                                                                                                                    |
| §5 deriveTurns single-line touch-up (formatAnswers swap) | Task 5                                                                                                                                     |
| §6 Migration + waveRowGuard                              | Task 2 (migration), Task 3 (guard)                                                                                                         |
| §7 Tests + smoke + subagent flow                         | Tests live in every task; smoke is Step 5 of Task 17 (user-run)                                                                            |

Placeholder scan: `grep -nE "TBD|TODO|implement later|fill in|add appropriate" docs/superpowers/plans/2026-05-20-wave-chat-log-mirror-scoping.md` should return zero matches in step bodies (a single `TODO.md` reference in a code comment is permitted — it points at the existing tracking doc).

Type consistency: `appendWaveChatLog(exec, waveId, entry)` arg order is consistent across Tasks 4, 6, 7, 8, 9. `WaveChatLogEntry` (server-side) vs `WaveChatLogEntryForClient` (wire) is consistent: server-side carries raw `correct` on MC, wire carries `correctEnc`.
