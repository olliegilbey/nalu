# Nalu — Architecture Notes

Light reference for design choices that aren't obvious from the code. Read alongside `PRD.md` (product spec) and `UBIQUITOUS_LANGUAGE.md` (vocabulary).

## Persistence has three stores, each shaped for its consumer

Every LLM turn produces writes to up to three stores. They are not redundant: each one serves a different reader.

| Store                                                                                 | Reader                                           | Shape                                                                                                            |
| ------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `context_messages`                                                                    | LLM (replay log)                                 | Append-only strings, byte-stable for prefix caching: XML-tagged user envelopes, raw model output, tool-call JSON |
| Typed JSONB (`courses.{clarification, framework, baseline}`, `waves.chat_log`)        | UI projection + pre-LLM durability               | Structured wire shapes — `Question[]`, `Response[]`, etc.                                                        |
| Business-logic stores (`concepts`, `assessments`, `courses.{total_xp, current_tier}`) | Deterministic logic (SM-2, XP, tier advancement) | Domain-specific columns, queryable                                                                               |

At write time, one model response drives **one** fan-out: its raw text → `context_messages.content`, beside the user envelope that prompted it; its parsed payload → typed JSONB; its signals → business-logic stores. Single source of truth, three projections.

A Wave close also writes `waves.summary` and `waves.blueprint_emitted`. They are a record of the close turn. No code reads them back; the next Wave reads its blueprint from its own `waves.seed_source`.

## The replay-log invariant

`context_messages` is the LLM's view of history. Two rules:

1. **Byte stability.** `context_messages.content` is never re-rendered from typed data. The bytes written on emission are the exact bytes read back on the next turn. Cerebras and OpenAI cache prefixes at the byte level; whitespace or key-ordering drift causes cache-miss-per-turn.
2. **Atomic pairing.** A `user_message` row is only ever persisted in one batch with the model output it produced. `executeTurn` and its tool-loop sibling `executeToolTurnStream` write that batch after the LLM responds. On success the batch ends in `assistant_response`. On terminal validation failure it ends in `failed_assistant_response`. A transport failure produces **no** rows. There is never a dangling user-row without its assistant-row.

The atomicity rule is what makes replay trivial: walk rows in `(turn_index, seq)` order, every pair was actually seen by the LLM.

One row is not raw model output: a failed tool-loop attempt's `failed_assistant_response`. It holds the prose the learner saw, cut at any JSON leak, with no tool trail (#140). The retry replays it as the model's previous reply, and a JSON reply there primes the model to answer in JSON again. `src/lib/turn/CLAUDE.md` has the details.

## The system prompt is recomputed, never persisted

`context_messages` stores only `user` / `assistant` / `tool` rows. The schema CHECK `context_messages_kind_role_pair` pins each row kind to its one role, and no kind maps to `system`. The system prompt is **rebuilt fresh on every LLM call** from seed columns (`courses` / `waves` rows) by the pure renderers (`renderTeachingSystem`, `renderScopingSystem`).

It is byte-stable across a session's turns not because it is stored, but because the renderer is pure: identical seed in → identical bytes out. The conversation is byte-stable by _persistence_ (the same rows replayed); the system prompt is byte-stable by _purity_.

**What this means when you edit a prompt:**

- Editing a _rendering function_ — the system prompt or a per-turn envelope (`renderTeachingSystem`, `renderWaveTurnEnvelope`, `buildLearnerInput`, …) — takes effect on the **next turn of existing sessions**. No new course needed; dev-server hot-reload is enough.
- Editing something whose _output is persisted_ — a wave's `openingText`, the framework, the starting tier, baseline gradings — only affects **new runs**. That output was frozen into a row at the turn that produced it; existing sessions keep the old value.
- Changing the system prompt shifts the cache prefix from byte 0, so the first turn after the edit is a full prompt-cache miss; caching re-establishes on the new prefix from the turn after.

## The two-store split — why typed JSONB exists

If `context_messages` is honest about what the LLM saw, two needs are still unmet:

**UI projection.** `context_messages.content` is an envelope string. The UI wants `Question[]` + `Response[]` to render cards. Re-parsing envelopes is fragile and burns tokens; storing the typed shape once at write time is cleaner.

**Pre-LLM durability.** When the learner submits answers, `context_messages` cannot capture them until the LLM responds (because of the atomicity rule). If the LLM transport fails, the learner's input would be lost. The solution: write the typed payload to the typed-JSONB store **before** calling the LLM. On retry, the responses survive in typed JSONB, and the retried call renders a fresh envelope from the resubmitted input.

The pattern, in any phase:

```text
1. updateTypedJsonb(...learner input...)   ← persists durably, before LLM
2. executeTurn(...)                         ← atomic context_messages batch on success
3. updateTypedJsonb(...assistant output...) ← persists typed projection
```

## Ping-pong of state

Every cross of the client↔server net writes something durable, but to different stores:

| Direction                      | `context_messages`                    | Typed JSONB            |
| ------------------------------ | ------------------------------------- | ---------------------- |
| Client → server (learner move) | ❌ (waits for LLM)                    | ✅ (pre-persist)       |
| LLM → server (assistant move)  | ✅ (atomic batch with prior user-row) | ✅ (parsed wire shape) |

The asymmetry of `context_messages` is what makes it the honest replay log. Typed JSONB closes the durability gap on the learner-side direction.

## Per-phase shape choices

Scoping and wave share the **primitives** but pick different **column shapes** because their cardinalities differ.

**Scoping** — fixed-cardinality stages (clarify → framework → baseline). One typed JSONB column per stage on `courses`:

```text
courses.clarification = { userMessage, questions, responses }
courses.framework     = { userMessage, tiers, estimatedStartingTier, baselineScopeTiers }
courses.baseline      = { userMessage, questions, responses, gradings[, immutableSummary, summarySeed, startingTier] }
```

**Wave** — variable-cardinality turns (up to `WAVE.turnCount` per wave). One JSONB array column on `waves`:

```text
waves.chat_log = WaveChatLogEntry[]
  // each entry: { role, kind, content?, questionnaireId?, questions?, responses? }
```

**Shared primitives** (no duplication across phases):

- `v3Question`, `v3Response` Zod schemas — `src/lib/types/jsonb.ts`
- `ChatEntry` union (the rendered chat-row type) — `src/lib/types/chatEntry.ts`
- `formatAnswers(questions, responses)` formatter — `src/lib/course/deriveChatEntries.ts`
- `executeTurn` + envelope renderers — `src/lib/turn/`, `src/lib/prompts/`

The future option of unifying scoping into the same array shape (e.g. moving its UI state into `context_messages.payload` for both phases) is **deliberately deferred**. The current split serves all current consumers and keeps per-stage queryability for scoping.

## Boundary rules

- **LLM never sees XP, SM-2 internals, or tier-advancement decisions.** It emits content and assesses learner answers; deterministic code owns scoring and progression. See `AGENTS.md` ("The harness owns the score") for the boundary statement.
- **No code outside `src/lib/turn/` writes to `context_messages`.** That's the only place where the atomicity invariant can be enforced. One exception: the close transactions (`persistScopingClose`, `persistWaveClose`) seed the next Wave's turn-0 `assistant_response` with the blueprint's `openingText`.
- **No code outside `src/db/queries/` issues raw SQL.** Typed query functions are the trust boundary for DB I/O. Transactions open in `src/lib/course/` and pass `tx` into those functions.
- **No code rebuilds the envelope from typed JSONB.** Prefix-cache stability depends on canonical envelope bytes; rerendering would silently invalidate the cache.

## Where to add a new turn-shape

If you need to introduce a new per-turn behaviour:

1. Define the wire shape in `src/lib/prompts/<phase>.ts` (a Zod schema for `responseSchema`).
2. Define the typed-JSONB shape in `src/lib/types/jsonb.ts` (reuse `v3Question`, `v3Response` where applicable).
3. Add a `ChatEntry` variant in `src/lib/types/chatEntry.ts` if it needs a new rendered row.
4. Wire the persistence in the turn's `src/lib/course/` function — call `executeTurn` (or its tool-loop sibling `executeToolTurnStream`) for the envelope, then the typed-JSONB writer for UI/durability.
5. Extend the projection (`deriveChatEntries.ts` or `deriveWaveChatEntries.ts`) to emit the new `ChatEntry` variant.

Don't add LLM-needed fields to typed JSONB (the LLM doesn't see it). Don't add UI-only fields to envelopes (the LLM pays tokens for it).
