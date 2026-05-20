# Wave UI Persistence — Mirror Scoping (`waves.chat_log`)

**Status:** ready for user review. All seven sections drafted; self-review complete.

**Companion doc:** `docs/ARCHITECTURE.md` (the persistence-layer split + replay-log invariants, written alongside this spec).

---

## Problem

The wave teaching loop currently writes to `context_messages` only (the LLM replay log). The UI reads back `context_messages.content` — envelope strings — and projects to `Turn[]`. This is **out of parity with scoping**, where the UI reads typed JSONB columns on `courses` (`clarification`, `framework`, `baseline`) that mirror the wire shapes from `src/lib/prompts/`.

Symptoms today:

- `getWaveState` shoves raw envelope/JSON strings into `RenderedMessage.content` and ships them to the client (`src/lib/course/getWaveState.ts:120-133`).
- `loadWaveContext.reconstructOpenQuestionnaire` re-parses the latest `assistant_response.content` back through `waveMidTurnSchema` to rebuild the open questionnaire (`src/lib/course/loadWaveContext.ts:65-120`).
- `deriveWaveTurns` consumes those envelope strings verbatim (`src/lib/course/deriveWaveTurns.ts`).

This is a missing dual-write: scoping persists every typed wire shape alongside its `context_messages` envelope; wave only persists the envelope. Closing the gap brings wave into structural lockstep with scoping, with shared primitives.

## Goal

Mirror scoping's persistence pattern on the wave side. UI reads typed payloads from a typed JSONB store on `waves`. `Question`/`Response` Zod schemas are reused verbatim from `src/lib/types/jsonb.ts`. Projection helpers are shared between scoping (`deriveTurns`) and wave (`deriveWaveTurns`). `executeTurn`, `renderContext`, `context_messages.content` semantics, and envelope rendering are **untouched**.

This work supersedes TODO entry #26 ("JSON-everywhere refactor for wave context_messages content"). The prior framing was an over-complication; the actual fix is the scoping dual-write mirror.

## Non-goals

- **No data migration on `courses.{clarification, framework, baseline}`.** Scoping's existing typed JSONB shapes are unchanged.
- **No `executeTurn` / `renderContext` refactor.** Envelope rendering and replay-log semantics stay exactly as today.
- **No unification of scoping + wave under a single persistence shape** (Option C from brainstorming). Deferred as a future refactor; out of scope for this PR.

**In-scope scoping-side touches** (minimal, listed explicitly so they're not surprising):

1. `deriveTurns.ts` swaps `concatClarifyAnswers` / `concatBaselineAnswers` for the shared `formatAnswers`.
2. `persistScopingClose` writes the initial `assistant.text` opening entry to Wave 1's `chat_log` (parallels what `persistWaveClose` does for Wave N+1; see §3 call site 1).

## Section 1 — Architecture (lockstep with scoping)

After this refactor, the write/read pattern is symmetric across phases:

```
Scoping (reference, today):
  executeTurn  ──writes──▶  context_messages.content (XML envelope, LLM replay only)
        │
        └──then──▶  updateCourseScopingState  ──writes──▶  courses.{clarification|framework|baseline}

  getState  ──reads──▶  courses.{...}  ──projects via deriveTurns──▶  Turn[]

Wave (after this refactor):
  executeWaveMid.insert  ──writes──▶  context_messages.content (XML envelope, LLM replay only)
        │
        └──then──▶  appendWaveChatLog        ──writes──▶  waves.chat_log (typed JSONB array)

  getWaveState  ──reads──▶  waves.chat_log  ──projects via deriveWaveTurns──▶  Turn[]
```

Same two-store split. Same write triggers (typed write before LLM for learner input; typed write after LLM for assistant output). See `docs/ARCHITECTURE.md` for the principles.

## Section 2 — Shape: `waves.chat_log`

**New JSONB column** on `waves`, default `'[]' NOT NULL`. Append-only array of typed entries. `Question`/`Response` schemas imported verbatim from `src/lib/types/jsonb.ts`. Zero shape duplication across phases.

```ts
// src/lib/types/jsonb.ts — new exports, sit next to ClarificationJsonb / BaselineJsonb
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

**Append rules (strictly append-only, no read-modify-write of prior entries):**

- Wave opened (turn 0) → 1 entry: `{ assistant, text, content: openingText }`.
- Learner chat-text turn → append `{ user, text }` (before LLM); later append `{ assistant, text | text_with_questionnaire }` (after LLM success).
- Learner submits questionnaire answers → append `{ user, answers, responses }` referencing the open questionnaire's id (before LLM); later append assistant emission.
- Wave closes → append closing `{ assistant, text, content: closingMessage }` to the closing wave; the next wave's opening message is appended to **its own** chat_log via the same "wave opened" rule.

**Derived state (no separate columns needed):**

- **Open questionnaire** = latest `assistant.text_with_questionnaire` whose `questionnaireId` has no matching `user.answers.questionnaireId` later in the array. Replaces the current `reconstructOpenQuestionnaire` that re-parses envelope JSON.
- **`turnsRemaining`** = `WAVE.turnCount - count(entries where role === "user")`. Equivalent to today's count of `user_message` + `card_answer` rows in `context_messages`.

**Why per-row Turn-shaped, not per-round ClarificationJsonb-shaped:** scoping uses per-stage columns because scoping has fixed-cardinality stages. Wave has variable-cardinality turns, so the natural unit of the column shape is "one rendered row", not "one round". Per-row also keeps appends strictly forward-only (no RMW), which is the simpler-than-scoping direction.

## Section 3 — Persist call sites (3 places, each gets one new line)

Each place already writes to `context_messages` via `appendMessage`. Right next to that call, write the typed payload via a new helper `appendWaveChatLog(tx, waveId, entry)`. Same transaction. No restructuring of existing logic.

**Call site 1: Wave opened — `persistWaveClose.ts:150-160` and `persistScopingClose` (for Wave 1)**
After the existing `appendMessage` that seeds the turn-0 `assistant_response`, append the typed entry:

```ts
await appendWaveChatLog(tx, nextWave.id, {
  role: "assistant",
  kind: "text",
  content: parsed.nextUnitBlueprint.openingText, // Wave N+1 case
});
// For Wave 1, content = scoping handoff blueprint's openingText.
```

**Call site 2: Mid-wave turn — `executeWaveMid.insert.ts` (and the surrounding `executeWaveMid.ts`)**
After the existing `appendMessage` calls that persist `user_message` + `assistant_response`:

```ts
// Learner side (PRE-LLM in submitWaveTurn — durability):
await appendWaveChatLog(
  tx,
  waveId,
  learnerKind === "answers"
    ? { role: "user", kind: "answers", questionnaireId, responses }
    : { role: "user", kind: "text", content: learnerText },
);

// Assistant side (POST-LLM success):
await appendWaveChatLog(
  tx,
  waveId,
  parsed.questionnaire
    ? {
        role: "assistant",
        kind: "text_with_questionnaire",
        questionnaireId: assistantMessageId,
        content: parsed.userMessage,
        questions: parsed.questionnaire.questions,
      }
    : { role: "assistant", kind: "text", content: parsed.userMessage },
);
```

**Call site 3: Wave close — `persistWaveClose.ts`**
The closing `assistant_response` on Wave N gets a parallel typed entry on Wave N's chat_log. Wave N+1's opening message is handled by call site 1.

**Helper:**

```ts
// src/db/queries/waves.ts
export async function appendWaveChatLog(
  tx: DbOrTx,
  waveId: string,
  entry: WaveChatLogEntry,
): Promise<void> {
  // Postgres JSONB `||` concat is atomic; avoids the read-modify-write cycle.
  await tx.execute(sql`
    UPDATE waves SET chat_log = chat_log || ${JSON.stringify([entry])}::jsonb
    WHERE id = ${waveId}
  `);
}
```

**Pre-LLM persistence on learner input** (per `docs/ARCHITECTURE.md` "persist-before-LLM"): in `submitWaveTurn.ts`, the `{ role: "user", kind: ... }` chat_log entry is written **before** the `executeWaveMid` invocation, inside the same transaction. This mirrors scoping's `generateFramework.ts:82-92` (pre-persist `clarification.responses` before `executeTurn`) and `submitBaseline.persist.ts` (pre-persist baseline responses — commit `287195f`).

## DRY inventory (shared primitives across scoping + wave)

| Concern                                              | Source                                                                         | Reused by wave                                                                                                                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Question shape                                       | `v3Question` in `src/lib/types/jsonb.ts`                                       | Imported verbatim                                                                                                                                                                                                                        |
| Response shape                                       | `v3Response` in `src/lib/types/jsonb.ts`                                       | Imported verbatim                                                                                                                                                                                                                        |
| Answer→string formatter                              | `concatClarifyAnswers` + `concatBaselineAnswers` in `deriveTurns.ts` (private) | Un-private and rename baseline's helper to `formatAnswers`, exported from the same file; clarify helper deleted (baseline is the superset). Wave imports `formatAnswers` from `deriveTurns.ts`. Net: -2 helpers, +1 helper. No new file. |
| Turn union                                           | `Turn` in `src/lib/types/turn.ts`                                              | Already shared. `deriveWaveTurns` emits the same union.                                                                                                                                                                                  |
| State-writer entry point                             | `updateCourseScopingState` in `src/db/queries/courses.ts`                      | Mirror: `appendWaveChatLog` in `src/db/queries/waves.ts`                                                                                                                                                                                 |
| `executeTurn` + envelope renderer                    | `src/lib/turn/executeTurn.ts`, `src/lib/prompts/scoping.ts`                    | Already shared with wave; untouched in this refactor                                                                                                                                                                                     |
| Read pattern: typed JSONB on parent entity → project | `getState` reads `courses`                                                     | `getWaveState` reads `waves` (new)                                                                                                                                                                                                       |

## Section 4 — Read path (mirrors scoping's `getState` + `useScopingState`)

### Wire-shape change for `WaveState`

`messages: RenderedMessage[]` and `openQuestionnaire: OpenQuestionnaireForClient | null` are **both replaced** by a single field: `chatLog: WaveChatLogEntryForClient[]`. The client derives `activeQuestionnaire` from `chatLog` exactly as scoping derives it from `clarification` / `baseline` JSONB in `useScopingState.ts:82-111`.

```ts
// src/lib/course/getWaveState.ts (post-refactor)
export interface WaveState {
  readonly courseId: string;
  readonly waveId: string;
  readonly waveNumber: number;
  readonly currentTier: number;
  readonly status: "active" | "closed";
  readonly turnsRemaining: number;
  readonly chatLog: readonly WaveChatLogEntryForClient[]; // ← replaces `messages` + `openQuestionnaire`
  readonly closeResult:
    | null
    | {
        /* unchanged */
      };
}
```

### `WaveChatLogEntryForClient` (wire-safe projection of `WaveChatLogEntry`)

Identical to `WaveChatLogEntry` except the `assistant.text_with_questionnaire` branch — each MC question swaps raw `correct` for `correctEnc` (the existing `encodeCorrect(questionId, index)` from `src/lib/security/obfuscateCorrect.ts`). The redaction is applied uniformly to all questionnaire entries — historical and currently-open — so the wire never carries raw `correct`. The LLM-facing path (`context_messages`, `executeWaveMid`) still sees plain `correct`; the obfuscation is purely a wire-boundary concern, applied once in `getWaveState`.

```ts
// src/lib/course/redactWaveChatLog.ts (new)
export type OpenQuestionForClient = // already exists in redactQuestionnaire.ts; reused verbatim
  | { id; type: "multiple_choice"; prompt; options; correctEnc; freetextRubric }
  | { id; type: "free_text"; prompt; freetextRubric };

export type WaveChatLogEntryForClient =
  | { role: "user"; kind: "text"; content: string }
  | { role: "user"; kind: "answers"; questionnaireId: string; responses: readonly Response[] }
  | { role: "assistant"; kind: "text"; content: string }
  | {
      role: "assistant";
      kind: "text_with_questionnaire";
      questionnaireId: string;
      content: string;
      questions: readonly OpenQuestionForClient[];
    };

export function redactWaveChatLog(
  entries: readonly WaveChatLogEntry[],
): readonly WaveChatLogEntryForClient[] {
  /* per-branch projection, reuses encodeCorrect */
}
```

### `getWaveState` rewrite

```ts
export async function getWaveState(params): Promise<WaveState> {
  // (1) Resolve waveNumber → wave row (unchanged).
  const wave = await getWaveByCourseAndNumber(params.courseId, params.waveNumber);
  if (!wave) throw new TRPCError({ code: "NOT_FOUND", ... });

  // (2) Ownership + cross-course containment — same checks as today, but no
  // longer needs to reconstruct the open questionnaire. `loadWaveContext`
  // collapses (see below).
  const { course } = await loadWaveContext({ userId, courseId, waveId: wave.id });

  // (3) Read typed JSONB column, NOT context_messages. Mirrors `getState` reading
  // `courses.{clarification, framework, baseline}`.
  const chatLog = wave.chatLog; // already parsed by wavesRowGuard on the DB read

  // (4) Redact correct → correctEnc on questionnaire entries.
  const redacted = redactWaveChatLog(chatLog);

  // (5) turnsRemaining derived from chat_log (count user-role entries), same
  // semantics as today's `consumed` count.
  const consumed = chatLog.filter((e) => e.role === "user").length;
  const turnsRemaining = Math.max(0, WAVE.turnCount - consumed);

  return {
    courseId: course.id, waveId: wave.id, waveNumber: wave.waveNumber,
    currentTier: wave.tier, status: wave.status === "closed" ? "closed" : "active",
    turnsRemaining, chatLog: redacted, closeResult: null,
  };
}
```

No more `getMessagesForWave` call from this path. `context_messages` becomes invisible to the UI read side — a strict improvement: replay-log byte stability is no longer load-bearing for the chat scroll.

### `loadWaveContext` collapses

The `reconstructOpenQuestionnaire` helper **is deleted**. The "open questionnaire" concept moves to:

1. **Wire side:** derived on the client in `useWaveState` from `chatLog` (see below).
2. **Server-side validation in `submitWaveTurn`:** when the learner submits answers, validate the echoed `questionnaireId` against the current `waves.chat_log` directly — a 5-line scan replacing the current envelope-JSON re-parse. This validation moves into `submitWaveTurn` itself (or a tiny pure helper next to it). It does NOT need to round-trip through `loadWaveContext`.

After the collapse:

```ts
// src/lib/course/loadWaveContext.ts (post-refactor)
export interface LoadedWaveContext {
  readonly course: Course;
  readonly wave: Wave;   // wave.chatLog is now typed via wavesRowGuard
}
export async function loadWaveContext(params): Promise<LoadedWaveContext> {
  const course = await getCourseById(params.courseId, params.userId);
  const wave = await getWaveById(params.waveId);
  if (wave.courseId !== course.id) throw new TRPCError({ code: "FORBIDDEN", ... });
  return { course, wave };
}
```

Net: 137 → ~25 lines. `safeJsonParse`, `findLastIndex` walk, and the `waveMidTurnSchema` re-parse all disappear.

### Client-side `activeQuestionnaire` derivation (mirrors `useScopingState`)

```ts
// src/hooks/useWaveState.ts (post-refactor)
const activeQuestionnaire = useMemo<ActiveQuestionnaire | null>(() => {
  if (!state.data) return null;
  // Latest assistant.text_with_questionnaire whose questionnaireId has no
  // matching user.answers later in the chatLog.
  const log = state.data.chatLog;
  const lastQIdx = log.findLastIndex(
    (e) => e.role === "assistant" && e.kind === "text_with_questionnaire",
  );
  if (lastQIdx === -1) return null;
  const lastQ = log[lastQIdx];
  if (lastQ.role !== "assistant" || lastQ.kind !== "text_with_questionnaire") return null;
  const answered = log
    .slice(lastQIdx + 1)
    .some(
      (e) =>
        e.role === "user" && e.kind === "answers" && e.questionnaireId === lastQ.questionnaireId,
    );
  if (answered) return null;
  return {
    kind: "wave",
    questions: lastQ.questions,
    questionsKey: lastQ.questions.map((q) => q.id).join("|"),
    persistKey: `nalu:wave:${state.data.waveId}:q:${lastQ.questionnaireId}`,
  };
}, [state.data]);
```

The shape matches `useScopingState.activeQuestionnaire` exactly — same `ActiveQuestionnaire` type, same `questionsKey`/`persistKey` semantics. The Composer keeps consuming this prop with no change.

### Read-side summary

| Concern                                        | Before                                                | After                                                |
| ---------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------- |
| `WaveState.messages`                           | `RenderedMessage[]` (envelope strings)                | **gone**                                             |
| `WaveState.openQuestionnaire`                  | `OpenQuestionnaireForClient \| null` (server-derived) | **gone**                                             |
| `WaveState.chatLog`                            | —                                                     | `WaveChatLogEntryForClient[]` (new)                  |
| `getMessagesForWave` call in read path         | yes                                                   | **removed**                                          |
| `loadWaveContext.reconstructOpenQuestionnaire` | 70 lines envelope-reparse                             | **deleted**                                          |
| Open-questionnaire derivation                  | server-side via envelope re-parse                     | client-side `useMemo` over chatLog (mirrors scoping) |
| `submitWaveTurn` open-questionnaire lookup     | through `loadWaveContext`                             | direct scan over `waves.chat_log` (5 lines)          |

## Section 5 — Projection + shared helpers

### Shared `formatAnswers` (single helper, three call sites)

Scoping today has two near-duplicate private helpers in `deriveTurns.ts` (`concatClarifyAnswers`, `concatBaselineAnswers`). The difference is artifactual: clarify never produces MC questions, so its formatter skips the MC branch as dead code. Baseline's formatter is the **superset** that handles both MC (`q.options[r.choice]`) and free-text (`r.freetext`). Wave needs both branches.

Decision: keep one implementation. The baseline-shaped helper is the canonical one; rename to `formatAnswers`, un-private (export from `deriveTurns.ts`, no new file), and use it from all three call sites.

```ts
// src/lib/course/deriveTurns.ts — un-private, rename, single implementation
export function formatAnswers(
  questions: readonly Question[],
  responses: readonly Response[],
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

Consumers:

- `deriveTurns` clarify branch: `formatAnswers(state.clarification.questions, state.clarification.responses)`. (Switches from `concatClarifyAnswers`; behaviour identical because clarify responses never carry `choice`.)
- `deriveTurns` baseline branch: `formatAnswers(state.baseline.questions, state.baseline.responses)`. (Switches from `concatBaselineAnswers`; same function body.)
- `deriveWaveTurns` answers branch: see below.

`concatClarifyAnswers` is deleted. `concatBaselineAnswers` becomes `formatAnswers`. Net: -2 helpers, +1 helper.

### `deriveWaveTurns` rewrite (consumes typed chat log)

Today's signature: `deriveWaveTurns(messages: RenderedMessage[], openQuestionnaire: OpenQuestionnaireForClient | null): Turn[]`. After the refactor it takes the wire-shape chat log alone — the open-questionnaire concept disappears from the projection layer (the client derives `activeQuestionnaire` separately in `useWaveState`, see §4).

```ts
// src/lib/course/deriveWaveTurns.ts (post-refactor)
import type { Turn } from "@/lib/types/turn";
import { formatAnswers } from "./deriveTurns"; // shared
import type { WaveChatLogEntryForClient } from "./redactWaveChatLog";

export function deriveWaveTurns(chatLog: readonly WaveChatLogEntryForClient[]): readonly Turn[] {
  // Find the latest text_with_questionnaire entry whose questionnaireId
  // has no matching user.answers later. That's the OPEN questionnaire row,
  // and only THAT row gets emitted as `assistant-text-with-questionnaire`.
  // All other text_with_questionnaire entries (already-answered) emit as
  // plain `assistant-text` (the questions+correctEnc payload is still on the
  // wire for that entry but the chat scroll only renders the prose).
  const lastQIdx = chatLog.findLastIndex(
    (e) => e.role === "assistant" && e.kind === "text_with_questionnaire",
  );
  const openId = (() => {
    if (lastQIdx === -1) return null;
    const cand = chatLog[lastQIdx];
    if (cand.role !== "assistant" || cand.kind !== "text_with_questionnaire") return null;
    const answered = chatLog
      .slice(lastQIdx + 1)
      .some(
        (e) =>
          e.role === "user" && e.kind === "answers" && e.questionnaireId === cand.questionnaireId,
      );
    return answered ? null : cand.questionnaireId;
  })();

  return chatLog.map((entry, idx): Turn => {
    if (entry.role === "user" && entry.kind === "text") {
      return { kind: "user-text", content: entry.content };
    }
    if (entry.role === "user" && entry.kind === "answers") {
      // For wave answers we need the matching questions[] to format. Walk back
      // to the assistant.text_with_questionnaire whose id matches.
      const qEntry = chatLog
        .slice(0, idx)
        .find(
          (e) =>
            e.role === "assistant" &&
            e.kind === "text_with_questionnaire" &&
            e.questionnaireId === entry.questionnaireId,
        );
      const questions =
        qEntry && qEntry.role === "assistant" && qEntry.kind === "text_with_questionnaire"
          ? qEntry.questions
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
        questionnaire: { questions: entry.questions, questionnaireId: entry.questionnaireId },
      };
    }
    return { kind: "assistant-text", content: entry.content };
  });
}
```

**Behavioural parity:** the only `Turn` variant whose attached payload differs from the latest version is `assistant-text-with-questionnaire`. Closed/answered questionnaires fall back to plain `assistant-text` (their prose content is still rendered; the Composer doesn't re-show locked questionnaires anyway). This matches today's behaviour exactly — the current `deriveWaveTurns` only attaches the questionnaire to the latest assistant_response.

**No `move-on-cta`** emitted from this projection — same as today. The wave move-on CTA is driven by `useWaveState.closeResult`, not by `chatLog`.

### `deriveTurns` (scoping) — single-line touch-up

The only change is swapping `concatClarifyAnswers` / `concatBaselineAnswers` calls for `formatAnswers(...)`. Behaviour unchanged. The function signature, the gating rules (`state.framework && state.clarification`, etc.), the move-on-cta logic, and the `assistant-text-with-framework` emission are all preserved.

### Projection-layer summary

| File                                        | Change                                                                                                                                                                                                                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/course/deriveTurns.ts`             | `concatBaseline...` renamed and exported as `formatAnswers`; `concatClarify...` deleted; both call sites switch to `formatAnswers`                                                                                                                                        |
| `src/lib/course/deriveWaveTurns.ts`         | Signature changes: `(chatLog: WaveChatLogEntryForClient[]) → Turn[]`. Body rewritten to walk the typed chat log, emit `user-text` / `user-questionnaire-answers` / `assistant-text` / `assistant-text-with-questionnaire`. Imports `formatAnswers` from `deriveTurns.ts`. |
| `src/lib/course/redactWaveChatLog.ts` (new) | Pure wire-redaction function + `WaveChatLogEntryForClient` type. Reuses `OpenQuestionForClient` type from `redactQuestionnaire.ts` (already exists, no duplication). Reuses `encodeCorrect` from `src/lib/security/obfuscateCorrect.ts`.                                  |
| `src/lib/course/redactQuestionnaire.ts`     | **No change.** Function and `OpenQuestionForClient` type are still used by `redactWaveChatLog` for the per-entry projection. (If it ends up with no other consumers post-refactor, decommission is a future concern, not this PR.)                                        |

## Section 6 — Migration + schema

### Drizzle schema change

```ts
// src/db/schema/waves.ts — add column
chatLog: jsonb("chat_log").$type<WaveChatLog>().notNull().default(sql`'[]'::jsonb`),
```

Generated migration file (Drizzle Kit):

```sql
-- migrations/NNNN_wave_chat_log.sql
ALTER TABLE "waves" ADD COLUMN "chat_log" jsonb DEFAULT '[]'::jsonb NOT NULL;
```

### Backfill strategy: none (dev wipe)

The branch `feat/teaching-loop` is unshipped — no prod data exists. Existing dev waves were written by the old code path (context_messages only) and will have an empty `chat_log`. The UI of an existing dev wave would render as an empty chat scroll, which is broken-looking but not catastrophic.

**Decision: no backfill SQL.** Dev developers wipe their wave/course data before testing the refactor. The wipe is a single SQL script (or `just db:reset` if it exists; otherwise document the `TRUNCATE waves, courses CASCADE` step in the migration commit message). Cost of backfilling envelope strings into typed entries (parsing JSON, validating against `waveChatLogEntrySchema`, handling historical malformed rows) is not worth paying for non-prod data.

### `wavesRowGuard`

Mirror `courseRowGuard` (which Zod-validates every JSONB column on read). Add `wavesRowGuard` that validates `chat_log` against `waveChatLogSchema`. Applied inside `getWaveById` and `getWaveByCourseAndNumber` so every read produces a typed `wave.chatLog: WaveChatLog`.

```ts
// src/db/queries/waves.ts
const wavesRowGuard = z.object({
  // ...existing fields...
  chatLog: waveChatLogSchema,
});

export async function getWaveById(id: string): Promise<Wave> {
  const row = await db.select().from(waves).where(eq(waves.id, id)).limit(1);
  if (!row[0]) throw new TRPCError({ code: "NOT_FOUND", message: `wave ${id} not found` });
  return wavesRowGuard.parse(row[0]);
}
```

Failure on a corrupt row throws loudly — same trust-boundary discipline as `courseRowGuard`.

### Migration commit checklist

1. Drizzle migration SQL committed alongside schema change.
2. `bun run db:generate` produces the migration; `bun run db:migrate` applies it.
3. Commit message documents the dev-wipe step verbatim:

   ```
   chore(db): add waves.chat_log column

   This refactor reads UI state from waves.chat_log (typed JSONB) instead of
   context_messages envelope strings. Existing dev waves have empty chat_log
   → render as empty chat scroll. Before testing locally, wipe:
       TRUNCATE waves, courses CASCADE;
   No prod backfill — branch is unshipped.
   ```

## Section 7 — Tests + smoke

### Test inventory (changes)

| Test file                                                                  | Action                                                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/course/getWaveState.integration.test.ts`                          | **Rewrite.** Seeds `waves.chat_log` instead of `context_messages` for the read-side assertions. Asserts `chatLog`, `turnsRemaining`, `closeResult` on `WaveState`. Drops `messages` and `openQuestionnaire` assertions.                                                                                       |
| `src/lib/course/deriveWaveTurns.test.ts`                                   | **Rewrite.** Inputs are `WaveChatLogEntryForClient[]` fixtures. Cases: user-text, user-answers (formats via `formatAnswers`), assistant-text, latest assistant-text-with-questionnaire is open (emits `assistant-text-with-questionnaire`), older text_with_questionnaire is closed (emits `assistant-text`). |
| `src/lib/course/redactWaveChatLog.test.ts`                                 | **New.** Pure unit test: MC question entry → `correctEnc` substituted (decodable back via `decodeCorrect`); free-text entry pass-through; user entries pass-through.                                                                                                                                          |
| `src/lib/course/loadWaveContext.test.ts`                                   | **Shrink.** Most cases delete (no more `reconstructOpenQuestionnaire`). Remaining cases: ownership check + cross-course containment check.                                                                                                                                                                    |
| `src/lib/course/executeWaveMid.insert.integration.test.ts` (or equivalent) | **Extend.** Assert that after `executeWaveMid`, both `context_messages` row pairs AND `waves.chat_log` entries are present, in the same transaction. Crash injection between the two writes leaves no partial state.                                                                                          |
| `src/lib/course/submitWaveTurn.integration.test.ts`                        | **Extend.** Pre-LLM persistence: assert the `{ role: "user", ... }` entry lands in `waves.chat_log` before `executeWaveMid` is invoked. Mock `executeWaveMid` to throw → assert the user entry survived (durability invariant).                                                                               |
| `src/lib/course/persistWaveClose.integration.test.ts`                      | **Extend.** Assert the closing `assistant.text` entry lands on the closing wave's chat_log; assert the next wave's chat_log starts with one `assistant.text` opening entry.                                                                                                                                   |
| `src/hooks/useWaveState.test.tsx`                                          | **Extend.** Asserts client-side `activeQuestionnaire` derivation: open questionnaire detected from `chatLog`; once `user.answers` lands, `activeQuestionnaire` flips to null. Persist-key matches the new `nalu:wave:{waveId}:q:{questionnaireId}` scheme.                                                    |
| `src/server/routers/wave.live.test.ts`                                     | **Unchanged.** End-to-end smoke against Cerebras still exercises the full flow; passes iff the wire shape changes haven't broken it.                                                                                                                                                                          |

### Persistence integration test sketch

```ts
// src/lib/course/submitWaveTurn.integration.test.ts (new case)
it("persists learner answers to chat_log before executeWaveMid runs", async () => {
  const { courseId, waveId, questionnaireId } = await setupOpenQuestionnaire(...);
  // Sabotage the LLM call to verify pre-LLM persistence durability.
  vi.mocked(executeWaveMid).mockRejectedValueOnce(new Error("LLM transport failure"));

  await expect(
    submitWaveTurn({ userId, courseId, waveId, kind: "answers", questionnaireId, responses }),
  ).rejects.toThrow("LLM transport failure");

  // The user.answers entry must have survived.
  const wave = await getWaveById(waveId);
  const userAnswerEntries = wave.chatLog.filter(
    (e) => e.role === "user" && e.kind === "answers",
  );
  expect(userAnswerEntries).toHaveLength(1);
  expect(userAnswerEntries[0].questionnaireId).toBe(questionnaireId);
  // context_messages must NOT have a user_message row for this turn
  // (atomicity rule: no LLM response → no context_messages batch).
  const ctxRows = await getMessagesForWave(waveId);
  expect(ctxRows.filter((r) => r.kind === "user_message" || r.kind === "card_answer")).toHaveLength(0);
});
```

This case is the load-bearing one — it proves the dual-store contract: typed JSONB carries learner-direction durability, `context_messages` waits for LLM success.

### Fixture sharing

Existing fixtures like `submitBaseline.fixtures.ts` produce `ClarificationJsonb` / `BaselineJsonb` payloads. Wave gets its own `waveChatLog.fixtures.ts` next to `deriveWaveTurns.ts` (small file: helper `makeChatLog(...entries)` and a few canonical-shape constants for the common scenarios). No coupling to scoping fixtures — the JSONB shape is per-phase even if primitives are shared.

### Smoke

`wave.live.test.ts` runs unchanged structurally; it exercises Wave 1 mid-turns + close end-to-end against Cerebras. If the wire-shape change has broken anything, the smoke test fails on the assertion that the chat scroll renders. Per `feedback_op_run_requires_biometric.md`, smoke runs locally on the user's machine via `just smoke` (Touch ID required). The controller does **not** run smoke on the user's behalf.

### Subagent flow

Per `superpowers:subagent-driven-development`:

1. Each task in the implementation plan gets a fresh Opus-4.7 subagent on a feature branch (not a worktree — see `feedback_subagent_branches_not_worktrees.md`).
2. Two-stage review per task: spec-compliance review first, then code-quality review.
3. Controller verifies `just check` (typecheck + lint + tests) passes locally before marking each task done.
4. Smoke runs after the final task, by the user, with Touch ID.

## Locked-in decisions

- **Per-row Turn-shaped entries** (not per-round ClarificationJsonb-shaped). Lockstep at primitive level (`Question`/`Response`/`Turn`/`formatAnswers`); per-table at column level (per-stage cols on `courses`; array col on `waves`).
- **`waves.chat_log` over `context_messages.payload`.** The latter would be a third pattern neither phase currently uses; scoping migration is out of scope.
- **`executeTurn` / `renderContext` / envelope rendering / `context_messages.content` semantics are untouched.** The replay-log invariants (byte stability, atomic batch) remain load-bearing as documented in `docs/ARCHITECTURE.md`.
- **Pre-LLM persistence for learner input** is the standard pattern. Wave gains it via the `{ role: "user", ... }` entry written before `executeWaveMid` in `submitWaveTurn`.
- **DRY win:** `concatClarifyAnswers` + `concatBaselineAnswers` collapse into one `formatAnswers` helper consumed by both phases. Scoping gets cleaner as a side effect.
- **Architecture doc written** at `docs/ARCHITECTURE.md` capturing the two-store split, replay-log invariants, ping-pong state-update asymmetry, per-phase shape choices, and boundary rules.
- **Wire shape mirrors scoping:** server ships typed `chatLog: WaveChatLogEntryForClient[]` (redacted MC `correct` → `correctEnc`); `openQuestionnaire` field is dropped from `WaveState`; client derives `activeQuestionnaire` in `useWaveState` (mirrors `useScopingState`).
- **Open-questionnaire reconstruction concept deleted server-side.** `loadWaveContext` collapses to ~25 lines (ownership + cross-course containment only). `submitWaveTurn` validates the echoed `questionnaireId` against `waves.chat_log` directly.
- **`formatAnswers` exported from `deriveTurns.ts`, no new file.** Baseline's superset helper is the canonical implementation; clarify and wave both call it.
- **Pre-existing scoping leak** (baseline MC `correct` shipped raw to client) is flagged as a separate TODO — out of scope for this PR.
- **Migration tactic:** schema-only migration + dev DB wipe (no backfill). Branch is unshipped.
- **`wavesRowGuard`** Zod-validates `chat_log` on every read (mirrors `courseRowGuard`).
- **Test fixtures per-phase:** wave gets `waveChatLog.fixtures.ts` next to `deriveWaveTurns.ts`; no coupling to scoping fixtures.
