# Nalu — Architecture Notes

Light reference for design choices that aren't obvious from the code. Read alongside `PRD.md` (product spec) and `UBIQUITOUS_LANGUAGE.md` (vocabulary).

## Persistence has three stores, each shaped for its consumer

Every LLM turn produces writes to up to three stores. They are not redundant: each one serves a different reader.

| Store                                                                                   | Reader                                           | Shape                                                            |
| --------------------------------------------------------------------------------------- | ------------------------------------------------ | ---------------------------------------------------------------- |
| `context_messages`                                                                      | LLM (replay log)                                 | Append-only XML envelope strings, byte-stable for prefix caching |
| Typed JSONB (`courses.{clarification, framework, baseline}`, `waves.chat_log`)          | UI projection + pre-LLM durability               | Structured wire shapes — `Question[]`, `Response[]`, etc.        |
| Business-logic stores (`concepts`, `assessments`, `waves.{summary, blueprint_emitted}`) | Deterministic logic (SM-2, XP, tier advancement) | Domain-specific columns, queryable                               |

At write time, the parsed model output drives **one** fan-out: render envelope → `context_messages.content`; project typed payload → typed JSONB; extract signals → business-logic stores. Single source of truth, three projections.

## The replay-log invariant

`context_messages` is the LLM's view of history. Two rules:

1. **Byte stability.** `context_messages.content` is never re-rendered from typed data. The XML envelope written on emission is the exact bytes read back on the next turn. Cerebras and OpenAI cache prefixes at the byte level; whitespace or key-ordering drift causes cache-miss-per-turn.
2. **Atomic pairing.** A `user_message` row is only ever persisted alongside its paired `assistant_response`, written together by `executeTurn` after the LLM responds successfully. A transport failure produces **no** rows. There is never a dangling user-row without its assistant-row.

The atomicity rule is what makes replay trivial: walk rows in `(turn_index, seq)` order, every pair was actually seen by the LLM.

## The two-store split — why typed JSONB exists

If `context_messages` is honest about what the LLM saw, two needs are still unmet:

**UI projection.** `context_messages.content` is an envelope string. The UI wants `Question[]` + `Response[]` to render cards. Re-parsing envelopes is fragile and burns tokens; storing the typed shape once at write time is cleaner.

**Pre-LLM durability.** When the learner submits answers, `context_messages` cannot capture them until the LLM responds (because of the atomicity rule). If the LLM transport fails, the learner's input would be lost. The solution: write the typed payload to the typed-JSONB store **before** calling the LLM. On retry, the responses survive; the LLM call re-renders the envelope from them.

The pattern, in any phase:

```
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

```
courses.clarification = { userMessage, questions, responses }
courses.framework     = { userMessage, tiers, estimatedStartingTier, baselineScopeTiers }
courses.baseline      = { userMessage, questions, responses[, gradings, startingTier, ...] }
```

**Wave** — variable-cardinality turns (up to `WAVE.turnCount` per wave). One JSONB array column on `waves`:

```
waves.chat_log = WaveChatLogEntry[]
  // each entry: { role, kind, content?, questionnaireId?, questions?, responses? }
```

**Shared primitives** (no duplication across phases):

- `Question`, `Response` Zod schemas — `src/lib/types/jsonb.ts`
- `Turn` union (the rendered chat-row type) — `src/lib/types/turn.ts`
- `formatAnswers(questions, responses)` formatter — `src/lib/course/formatAnswers.ts`
- `executeTurn` + envelope renderers — `src/lib/turn/`, `src/lib/prompts/`

The future option of unifying scoping into the same array shape (e.g. moving its UI state into `context_messages.payload` for both phases) is **deliberately deferred**. The current split serves all current consumers and keeps per-stage queryability for scoping.

## Boundary rules

- **LLM never sees XP, SM-2 internals, or tier-advancement decisions.** It emits content and assesses learner answers; deterministic code owns scoring and progression. See `CLAUDE.md` for the boundary statement.
- **No code outside `src/lib/turn/` writes to `context_messages`.** That's the only place where the atomicity invariant can be enforced.
- **No code outside `src/db/queries/` issues raw SQL.** Typed query functions are the trust boundary for DB I/O.
- **No code rebuilds the envelope from typed JSONB.** Prefix-cache stability depends on canonical envelope bytes; rerendering would silently invalidate the cache.

## Where to add a new turn-shape

If you need to introduce a new per-turn behaviour:

1. Define the wire shape in `src/lib/prompts/<phase>.ts` (a Zod schema for `responseSchema`).
2. Define the typed-JSONB shape in `src/lib/types/jsonb.ts` (reuse `v3Question`, `v3Response` where applicable).
3. Add a `Turn` variant in `src/lib/types/turn.ts` if it needs a new rendered row.
4. Wire the persistence in the step file (`src/lib/course/<step>.ts`) — call `executeTurn` for the envelope, then the typed-JSONB writer for UI/durability.
5. Extend the projection (`deriveTurns.ts` or `deriveWaveTurns.ts`) to emit the new `Turn` variant.

Don't add LLM-needed fields to typed JSONB (the LLM doesn't see it). Don't add UI-only fields to envelopes (the LLM pays tokens for it).
