# Streaming Wave Turns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stream the teaching prose of every mid-Wave turn to the learner token-by-token (instead of a blocking spinner for the whole generation + retries + rate-limit pacing), using the AI SDK's UI Message Stream protocol end-to-end.

**Architecture:** A new Next.js route handler (`POST /api/course/[courseId]/wave/[waveNumber]/turn`) replaces the tRPC `wave.submitTurn` mutation as the turn transport. Server-side, a streaming sibling of `executeTurn` (`executeTurnStream`) drives `streamText` + `Output.object`, projecting the growing `userMessage` field out of `partialOutputStream` as text deltas into a `createUIMessageStream` writer. Grading/XP/persistence run exactly as today after the stream completes, and the result is delivered as a transient data part. Client-side, `useChat` (`@ai-sdk/react`) consumes the stream for the **in-flight turn only**; committed history still renders from `wave.getState` via react-query (invalidated on finish), so `deriveWaveTurns`, the Composer, and all questionnaire logic survive unchanged. tRPC keeps `getState` and all non-LLM mutations.

**Tech Stack:** `ai@6.0.158` (`streamText`, `Output.object`, `createUIMessageStream`, `createUIMessageStreamResponse`, `UIMessage` data parts), `@ai-sdk/react` (`useChat`, `DefaultChatTransport`), Next.js 16.2 route handlers, tRPC v11 (retained for state), Vitest + `MockLanguageModelV3`.

**Branch:** create `feat/streaming-wave-turns` off `main`.

**Prerequisite:** `2026-06-10-ai-sdk-output-object.md` is merged (this plan assumes `generateChat` returns `parsed`, `toOutputSchema` exists, and `executeTurn` converts `NoObjectGeneratedError` → `ValidationGateFailure`).

---

## Phase sequence context (for agents with zero context)

This is Phase 2 of a five-plan AI SDK modernization:

1. `2026-06-10-ai-sdk-output-object.md` — structured output on SDK primitives (merged prerequisite).
2. **This plan** — streaming UX for wave turns.
3. `2026-06-10-tool-calling-turn-actions.md` — replace the mega-schema with SDK tool calls.
4. `2026-06-10-agent-loop-scoping.md` — multi-step agent loop where it pays.
5. `2026-06-10-llm-hygiene-observability.md` — dead-code removal, telemetry, DevTools.

Background: Nalu's turn loop was built request/response — one blocking `generateText` per learner action, dispatched via a tRPC mutation, with the client showing a pending spinner until the full JSON arrives (`src/hooks/useWaveState.ts`). Under the Cerebras rate-limit gate (`src/lib/llm/cerebrasRateLimit.ts`) plus up to 3 validation attempts, that wait can stretch to tens of seconds. Streaming is the single highest-leverage UX change identified in the 2026-06-10 assessment.

## Documentation manifest

**Read before writing code.** Local copies in `node_modules/ai/docs/` are version-matched to `ai@6.0.158` and authoritative; web URLs are the latest published docs. The repo's `AGENTS.md` "RTFM" rule applies — fetch anything here you haven't read.

| Topic                                                                                            | Local (version-matched)                                                                                                | Web                                                                          |
| ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `useChat` hook (status, sendMessage, parts, onData, onFinish, setMessages)                       | `node_modules/ai/docs/04-ai-sdk-ui/02-chatbot.mdx`                                                                     | https://ai-sdk.dev/docs/ai-sdk-ui/chatbot                                    |
| `useChat` reference                                                                              | —                                                                                                                      | https://ai-sdk.dev/docs/reference/ai-sdk-ui/use-chat                         |
| Streaming custom data (`createUIMessageStream`, data parts, `transient`, reconciliation by `id`) | `node_modules/ai/docs/04-ai-sdk-ui/20-streaming-data.mdx`                                                              | https://ai-sdk.dev/docs/ai-sdk-ui/streaming-data                             |
| Transport customization (`DefaultChatTransport`, `prepareSendMessagesRequest`)                   | `node_modules/ai/docs/04-ai-sdk-ui/21-transport.mdx`                                                                   | https://ai-sdk.dev/docs/ai-sdk-ui/transport                                  |
| UI Message Stream protocol (chunk types: `text-start`/`text-delta`/`text-end`/`data-*`)          | `node_modules/ai/docs/04-ai-sdk-ui/50-stream-protocol.mdx`                                                             | https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol                            |
| Streaming structured output (`streamText` + `Output.object`, `partialOutputStream`)              | `node_modules/ai/docs/03-ai-sdk-core/10-generating-structured-data.mdx`                                                | https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data               |
| `streamText` reference (promise fields: `text`, `usage`, `output`, `response`)                   | —                                                                                                                      | https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text                    |
| Stream error handling (errors become stream parts, `onError`)                                    | `node_modules/ai/docs/04-ai-sdk-ui/21-error-handling.mdx`, `node_modules/ai/docs/03-ai-sdk-core/50-error-handling.mdx` | https://ai-sdk.dev/docs/ai-sdk-ui/error-handling                             |
| Message persistence patterns (why we send only the payload, not client messages)                 | `node_modules/ai/docs/04-ai-sdk-ui/03-chatbot-message-persistence.mdx`                                                 | https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-message-persistence                |
| Resumable streams (explicit non-goal here; future work)                                          | `node_modules/ai/docs/04-ai-sdk-ui/03-chatbot-resume-streams.mdx`                                                      | https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-resume-streams                     |
| Testing (`MockLanguageModelV3`, `simulateReadableStream`)                                        | `node_modules/ai/docs/03-ai-sdk-core/55-testing.mdx`                                                                   | https://ai-sdk.dev/docs/ai-sdk-core/testing                                  |
| Next.js route handlers                                                                           | `node_modules/next/dist/docs/` (search "route handlers"; Next 16.2 has breaking changes vs training data)              | https://nextjs.org/docs/app/building-your-application/routing/route-handlers |
| Doc search API                                                                                   | —                                                                                                                      | `https://ai-sdk.dev/api/search-docs?q=your_query`                            |

**Key SDK facts verified against `ai@6.0.158` source (re-verify on version bump):**

- `streamText({ output: Output.object(...) })` exposes `partialOutputStream` (AsyncIterable of `DeepPartial<T>`, JSON-repaired but NOT validated) and an `output` promise that runs full validation on the final text and **rejects with `NoObjectGeneratedError`** on failure (`node_modules/ai/src/generate-text/stream-text.ts:2327,2356`).
- Errors during streaming become part of the stream rather than thrown exceptions; promise accessors reject. **Task 1 pins these semantics in a unit test before anything is built on them.**
- `createUIMessageStream({ execute: ({ writer }) => ... })` + `createUIMessageStreamResponse({ stream })` produce an SSE response `useChat` consumes. `writer.write()` accepts raw chunks (`{type:'text-start',id}`, `{type:'text-delta',id,delta}`, `{type:'text-end',id}`) and typed data parts (`{type:'data-<name>', data, transient}`). `transient: true` parts are delivered to `useChat`'s `onData` but never enter message history.
- `UIMessage<METADATA, DATA_PARTS>` generics give type-safe data parts; define the type in a file shared by route and client.

## Background reading (repo)

- `docs/PRD.md` §3.3, §7 — turn lifecycle and Wave UX contract. `docs/UBIQUITOUS_LANGUAGE.md` for Wave/Tier/lesson vocabulary.
- `src/lib/course/submitWaveTurn.ts` — the guard/dispatch entry point being split. Pay attention to the `bug_001` resume-idempotency block; it must survive verbatim.
- `src/lib/course/executeWaveMid.ts` — mid-turn orchestration being split into LLM dispatch + `persistWaveMidTurn`.
- `src/lib/course/executeWaveClose.ts` — close-turn orchestration (stays blocking in this plan; read it to confirm the result shape you forward).
- `src/lib/turn/executeTurn.ts` — the blocking primitive `executeTurnStream` mirrors; retry/persistence semantics are the spec.
- `src/lib/llm/generate.ts`, `src/lib/llm/cerebrasRateLimit.ts`, `src/lib/llm/userIdStore.ts` — the LLM seam, pacing gate, and the ALS that carries `userId` into the rate limiter. The new route MUST bind `userIdStore.run(...)` just like `protectedProcedure` does (`src/server/trpc.ts:77`).
- `src/server/trpc.ts` — context/auth pattern the route replicates (`createTRPCContext`).
- `src/hooks/useWaveState.ts` — the client hook being extended; its `onSuccess` XP/closeResult branches move into `onData`/`onFinish` handlers.
- `src/components/chat/WaveSession.tsx` + `src/components/chat/CLAUDE.md` (if present) — where the pending bubble renders.
- `src/lib/course/CLAUDE.md`, `src/server/routers/CLAUDE.md`, `src/lib/turn/CLAUDE.md` — boundary rules (update at the end).

## Design decisions locked in by this plan

1. **Hybrid client state, not full `useChat` adoption.** `useChat` manages ONLY the in-flight turn (status + streaming assistant text). Committed turns keep rendering from `wave.getState` → `deriveWaveTurns`. After each turn finishes we invalidate the query and clear `useChat`'s message list. Why: server state (chatLog JSONB) stays the single source of truth, questionnaire/Composer logic is untouched, and the migration to full UIMessage-native state is deferred to the tool-calling plan where parts-rendering pays for itself.
2. **The server ignores client-sent messages.** The request body carries only the `SubmitTurnPayload`; context is rebuilt from the DB (`renderContext`), exactly as today. This is the documented persistence pattern ("send only the last message" taken to its conclusion — send none): `node_modules/ai/docs/04-ai-sdk-ui/03-chatbot-message-persistence.mdx`.
3. **Mid-turns stream; close-turns run blocking inside the same streamed response.** Close turns (1 in 10) do grading + SM-2 + tier math after the LLM call; streaming their prose adds plan surface for little gain. The route still emits their result as a data part so the client code path is uniform. Streaming close-turn prose is noted in TODO.md as follow-up.
4. **Validation retries restart the visible text.** If attempt N fails Zod validation after streaming, the server emits a transient `data-turn-reset` part and re-streams attempt N+1 under a new text id; the client clears the partial bubble. The learner sees text restart — acceptable, honest, and rare (retries are the exception path).
5. **Monotonic-prefix delta guard.** `partialOutputStream` values come from repaired partial JSON; the projected `userMessage` could in rare cases shrink or rewrite earlier characters mid-stream. We only emit deltas when the new projection extends the already-emitted prefix; the committed turn (from `getState` after invalidation) is always the validated full text, so any divergence self-heals on finish.
6. **tRPC `wave.submitTurn` is retained untouched for one release** as a rollback path, then removed by the hygiene plan. The client stops calling it.
7. **Resumable streams are out of scope.** If the learner reloads mid-stream, the turn completes server-side? No — with route handlers the request aborts. The pre-LLM learner-entry persistence + `bug_001` resume logic already make a re-submit safe. True resumability needs `consumeSseStream` + a stream store; documented as future work (`node_modules/ai/docs/04-ai-sdk-ui/03-chatbot-resume-streams.mdx`).

## File touch list

- **Create:** `src/server/requestUser.ts` — shared `resolveRequestUserId` for tRPC ctx + route.
- **Create:** `src/server/routers/waveTurnInput.ts` — extracted Zod input schema (router + route share it).
- **Create:** `src/lib/llm/streamChat.ts` (+ test) — streaming sibling of `generateChat`.
- **Create:** `src/lib/turn/executeTurnStream.ts` (+ test) — streaming sibling of `executeTurn`.
- **Create:** `src/lib/turn/contextAssembly.ts` — `synthesiseRows` + message flattening extracted from `executeTurn` (shared).
- **Create:** `src/lib/course/persistWaveMidTurn.ts` — post-LLM transaction extracted from `executeWaveMid`.
- **Create:** `src/lib/course/streamWaveTurn.ts` (+ integration test) — streaming variant of `submitWaveTurn`'s dispatch.
- **Create:** `src/lib/course/prepareWaveTurn.ts` — guards/idempotency extracted from `submitWaveTurn`.
- **Create:** `src/lib/types/waveStream.ts` — `WaveTurnUIMessage` data-part types (shared client/server).
- **Create:** `src/app/api/course/[courseId]/wave/[waveNumber]/turn/route.ts` — the streaming endpoint.
- **Modify:** `src/server/trpc.ts` — use `resolveRequestUserId`.
- **Modify:** `src/server/routers/wave.ts` — import the extracted input schema.
- **Modify:** `src/lib/course/submitWaveTurn.ts` — delegate to `prepareWaveTurn`.
- **Modify:** `src/lib/course/executeWaveMid.ts` — delegate to `persistWaveMidTurn`.
- **Modify:** `src/hooks/useWaveState.ts` — submit via `useChat`/`sendMessage`; XP/close handling via `onData`.
- **Modify:** `src/components/chat/WaveSession.tsx` — render streaming bubble from `useChat` message.
- **Modify:** `package.json` — add `@ai-sdk/react`.
- **Modify:** `CLAUDE.md` files for `src/lib/turn`, `src/lib/course`, `src/server/routers`, `src/lib/llm`.

---

## Task 1: Pin `streamText` + `Output.object` semantics in a spike test

This task exists because the rest of the plan builds on three SDK behaviors that must be FACTS, not assumptions: (a) `partialOutputStream` yields growing partials, (b) `result.output` rejects with `NoObjectGeneratedError` on invalid final JSON, (c) transport errors don't crash the iteration silently.

**Files:**

- Create: `src/lib/llm/streamChat.test.ts` (the spike test becomes the real test file in Task 2)

- [ ] **Step 1: Write the spike test**

```typescript
import { describe, it, expect } from "vitest";
import { z } from "zod/v4";
import { streamText, Output, NoObjectGeneratedError } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { toOutputSchema } from "./toCerebrasJsonSchema";

/** Mock model that streams `chunks` of text then finishes. */
function mockStreamModel(deltas: readonly string[]): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: "text-1" },
          ...deltas.map((delta) => ({ type: "text-delta" as const, id: "text-1", delta })),
          { type: "text-end", id: "text-1" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            logprobs: undefined,
            usage: {
              inputTokens: { total: 3, noCache: 3, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 10, text: 10, reasoning: undefined },
            },
          },
        ],
      }),
    }),
  });
}

const schema = z.object({ userMessage: z.string().min(1) });

describe("streamText + Output.object semantics (SDK behavior pin)", () => {
  it("partialOutputStream yields growing partials of the object", async () => {
    const result = streamText({
      model: mockStreamModel(['{ "userMessage": "Hel', "lo wor", 'ld" }']),
      output: Output.object({ schema: toOutputSchema(schema, { name: "t" }) }),
      prompt: "x",
    });
    const partials: unknown[] = [];
    for await (const p of result.partialOutputStream) partials.push(p);
    // Last partial contains the full message; earlier ones are prefixes.
    expect(partials.at(-1)).toEqual({ userMessage: "Hello world" });
    expect(await result.output).toEqual({ userMessage: "Hello world" });
  });

  it("output promise rejects with NoObjectGeneratedError on schema violation", async () => {
    const result = streamText({
      model: mockStreamModel(['{ "wrong": true }']),
      output: Output.object({ schema: toOutputSchema(schema, { name: "t" }) }),
      prompt: "x",
    });
    // Drain partials first (route code will too).
    for await (const _ of result.partialOutputStream) {
      /* drain */
    }
    await expect(result.output).rejects.toSatisfy((e: unknown) =>
      NoObjectGeneratedError.isInstance(e),
    );
  });
});
```

- [ ] **Step 2: Run it**

Run: `bun run test src/lib/llm/streamChat.test.ts`
Expected: PASS. **If either test fails, STOP — read `node_modules/ai/src/generate-text/stream-text.ts` (search `partialOutputStream` and `get output`) and the docs in the manifest, adjust the plan's consumption pattern to the actual semantics, and update this plan file before continuing.** Known wrinkle to check for: an unhandled-rejection warning if `output` rejects while nothing awaits it — if you see one, the fix is `result.output.catch(() => {})` pre-registration in `streamChat` (Task 2) before iteration, then a real `await` afterwards.

- [ ] **Step 3: Commit**

```bash
git add src/lib/llm/streamChat.test.ts
git commit -m "test(llm): pin streamText+Output.object streaming semantics"
```

---

## Task 2: `streamChat` — streaming sibling of `generateChat`

**Files:**

- Create: `src/lib/llm/streamChat.ts`
- Test: `src/lib/llm/streamChat.test.ts` (extend the spike file)

- [ ] **Step 1: Add failing tests**

Append to `src/lib/llm/streamChat.test.ts`:

```typescript
import { streamChat } from "./streamChat";
import type { LlmMessage } from "@/lib/types/llm";

const messages: readonly LlmMessage[] = [{ role: "user", content: "hi" }];

describe("streamChat", () => {
  it("yields partials and resolves final parsed + text + usage", async () => {
    const handle = await streamChat(messages, {
      model: mockStreamModel(['{ "userMessage": "Hi!" }']),
      responseSchema: schema,
      responseSchemaName: "t",
    });
    const partials: unknown[] = [];
    for await (const p of handle.partialOutputStream) partials.push(p);
    const final = await handle.final();
    expect(final.parsed).toEqual({ userMessage: "Hi!" });
    expect(final.text).toBe('{ "userMessage": "Hi!" }');
    expect(final.usage).toBeDefined();
    expect(partials.length).toBeGreaterThan(0);
  });

  it("final() rejects with NoObjectGeneratedError on invalid output", async () => {
    const handle = await streamChat(messages, {
      model: mockStreamModel(['{ "wrong": 1 }']),
      responseSchema: schema,
      responseSchemaName: "t",
    });
    for await (const _ of handle.partialOutputStream) {
      /* drain */
    }
    await expect(handle.final()).rejects.toSatisfy((e: unknown) =>
      NoObjectGeneratedError.isInstance(e),
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun run test src/lib/llm/streamChat.test.ts`
Expected: FAIL — `./streamChat` does not exist.

- [ ] **Step 3: Implement**

Create `src/lib/llm/streamChat.ts`:

```typescript
import { streamText, Output, NoObjectGeneratedError } from "ai";
import type { DeepPartial } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { z } from "zod/v4";
import { LLM } from "@/lib/config/tuning";
import { getLlmModel } from "./provider";
import { toOutputSchema } from "./toCerebrasJsonSchema";
import { awaitCerebrasCallSlot, recordCerebrasRateLimitHeaders } from "./cerebrasRateLimit";
import type { LlmMessage, LlmUsage } from "@/lib/types/llm";

/** Options for {@link streamChat}; schema is REQUIRED (streaming is only used for structured turns). */
export interface StreamChatOptions<T> {
  readonly responseSchema: z.ZodType<T>;
  readonly responseSchemaName?: string;
  readonly temperature?: number;
  readonly maxRetries?: number;
  readonly model?: LanguageModelV3;
}

/** Resolved end-of-stream result: validated object + raw text + usage. */
export interface StreamChatFinal<T> {
  readonly parsed: T;
  readonly text: string;
  readonly usage: LlmUsage;
}

/** Live handle on one streaming LLM call. Iterate partials, then await final(). */
export interface StreamChatHandle<T> {
  /** Repaired-JSON partials of the response object. NOT validated — display only. */
  readonly partialOutputStream: AsyncIterable<DeepPartial<T>>;
  /** Resolve the validated final result; rejects with NoObjectGeneratedError on parse/validation failure. */
  readonly final: () => Promise<StreamChatFinal<T>>;
}

/**
 * Streaming sibling of `generateChat`, for structured turns whose prose the
 * UI wants progressively. Same rate-limit gate, same Cerebras wire bytes
 * (via `toOutputSchema`), same error contract (`NoObjectGeneratedError` on
 * invalid output — `executeTurnStream` converts it to the retry flow).
 *
 * Docs: node_modules/ai/docs/03-ai-sdk-core/10-generating-structured-data.mdx
 *       (https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)
 *       https://ai-sdk.dev/docs/reference/ai-sdk-core/stream-text
 */
export async function streamChat<T>(
  messages: readonly LlmMessage[],
  opts: StreamChatOptions<T>,
): Promise<StreamChatHandle<T>> {
  // Same pacing gate as generateChat — every Cerebras call goes through it.
  await awaitCerebrasCallSlot();

  const name = opts.responseSchemaName ?? "response";
  const result = streamText({
    model: opts.model ?? getLlmModel(),
    messages: [...messages],
    temperature: opts.temperature ?? LLM.defaultTemperature,
    maxRetries: opts.maxRetries ?? LLM.maxRetries,
    output: Output.object({ schema: toOutputSchema(opts.responseSchema, { name }), name }),
  });

  // Pre-register a catch so an output validation failure can't become an
  // unhandled rejection while the caller is still draining partials.
  result.output.catch(() => undefined);

  // Record rate-limit headers as soon as response metadata resolves —
  // even when validation later fails, the HTTP call itself succeeded.
  void result.response.then(
    (r) => recordCerebrasRateLimitHeaders(r.headers),
    () => undefined,
  );

  return {
    partialOutputStream: result.partialOutputStream,
    final: async () => {
      const [parsed, text, usage] = await Promise.all([result.output, result.text, result.usage]);
      return { parsed, text, usage };
    },
  };
}

// Re-export for callers that branch on the failure type without importing `ai`.
export { NoObjectGeneratedError };
```

- [ ] **Step 4: Run tests**

Run: `bun run test src/lib/llm/streamChat.test.ts`
Expected: PASS. If `final()` hangs on the rejection test, the `text`/`usage` promises may also reject — change `final()` to `await result.output` first (its rejection propagates before the others are touched).

- [ ] **Step 5: Update `src/lib/llm/CLAUDE.md`**

Add after the `generate.ts` bullet:

```markdown
- `streamChat.ts` — streaming sibling of `generateChat` for structured turns: `streamText` + `Output.object`, same rate-limit gate and wire bytes. Yields display-only `partialOutputStream` partials; `final()` resolves the validated object or rejects with `NoObjectGeneratedError`.
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/llm/streamChat.ts src/lib/llm/streamChat.test.ts src/lib/llm/CLAUDE.md
git commit -m "feat(llm): streamChat — streaming structured calls via streamText+Output.object"
```

---

## Task 3: Extract shared context assembly from `executeTurn`

`executeTurn` privately owns `synthesiseRows` and the system+messages flattening. `executeTurnStream` needs both. Extract, don't duplicate.

**Files:**

- Create: `src/lib/turn/contextAssembly.ts`
- Modify: `src/lib/turn/executeTurn.ts`

- [ ] **Step 1: Create `src/lib/turn/contextAssembly.ts`**

Move `synthesiseRows` (verbatim, including its TSDoc) from `executeTurn.ts` into this file and export it. Add the message-flattening helper, lifted from `executeTurn`'s `attempt()` body (the `llmMessages` construction, currently `executeTurn.ts:173-186`):

```typescript
import type { ContextMessage } from "@/db/schema";
import type { AppendMessageParams } from "@/db/queries/contextMessages";
import { renderContext } from "@/lib/llm/renderContext";
import type { SeedInputs } from "@/lib/types/context";
import type { LlmMessage } from "@/lib/types/llm";

// [synthesiseRows moved here verbatim — keep its full TSDoc]

/**
 * Render prior rows + the in-memory batch into the flat LLM message list
 * (system first). Shared by executeTurn and executeTurnStream so the
 * blocking and streaming paths can never drift on context assembly.
 */
export function assembleLlmMessages(
  seed: SeedInputs,
  prior: readonly ContextMessage[],
  batch: readonly AppendMessageParams[],
): readonly LlmMessage[] {
  const rendered = renderContext(seed, synthesiseRows(prior, batch));
  return [
    { role: "system", content: rendered.system } satisfies LlmMessage,
    ...rendered.messages.map((m): LlmMessage => {
      if (m.role === "assistant") return { role: "assistant", content: m.content };
      if (m.role === "system") return { role: "system", content: m.content };
      if (m.role === "tool") {
        throw new Error("assembleLlmMessages: tool-role rendered message is not supported");
      }
      return { role: "user", content: m.content };
    }),
  ];
}
```

(Keep the existing inline comments about the `ModelMessage` union narrowing when you move the code — they explain the `tool` branch.)

- [ ] **Step 2: Update `executeTurn.ts` to consume the shared module**

Replace the inline `synthesiseRows` call + flattening in `attempt()` with:

```typescript
const llmMessages = assembleLlmMessages(params.seed, priorRows, batch);
```

Delete the private `synthesiseRows` from `executeTurn.ts`; import from `./contextAssembly`.

- [ ] **Step 3: Verify no behavior change**

Run: `bun run test src/lib/turn/`
Expected: PASS, no test edits needed (pure extraction).

- [ ] **Step 4: Commit**

```bash
git add src/lib/turn/contextAssembly.ts src/lib/turn/executeTurn.ts
git commit -m "refactor(turn): extract context assembly shared by blocking+streaming turn paths"
```

---

## Task 4: `executeTurnStream` — streaming turn primitive

Mirrors `executeTurn`'s contract exactly (same persisted rows, same retry budget, same `ValidationGateFailure`), adding two callbacks: `onTextDelta` (projected prose growth) and `onAttemptStart` (lets the route emit a reset between attempts).

**Files:**

- Create: `src/lib/turn/executeTurnStream.ts`
- Test: `src/lib/turn/executeTurnStream.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/turn/executeTurnStream.test.ts`. Mirror the mock setup from `executeTurn.test.ts` (module mocks for `@/db/queries/contextMessages` and `@/lib/llm/renderContext` — copy the `vi.mock` blocks and `beforeEach` resets verbatim from that file), but mock `@/lib/llm/streamChat` instead of `@/lib/llm/generate`:

```typescript
vi.mock("@/lib/llm/streamChat", () => ({ streamChat: vi.fn() }));
import { streamChat } from "@/lib/llm/streamChat";
import { executeTurnStream } from "./executeTurnStream";
import { NoObjectGeneratedError } from "ai";
import { z } from "zod/v4";

const schema = z.object({ userMessage: z.string() });
const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/** Builds a StreamChatHandle whose partials/final are canned. */
function handleOf(partials: readonly unknown[], final: () => Promise<unknown>) {
  return {
    partialOutputStream: (async function* () {
      for (const p of partials) yield p;
    })(),
    final,
  };
}

function noObjectError(text: string) {
  return new NoObjectGeneratedError({
    message: "No object generated: response did not match schema.",
    text,
    response: { id: "t", timestamp: new Date(0), modelId: "mock" },
    usage,
    finishReason: "stop",
  });
}

describe("executeTurnStream", () => {
  it("emits monotonic prose deltas from the projected field", async () => {
    vi.mocked(streamChat).mockResolvedValueOnce(
      handleOf(
        [{ userMessage: "Hel" }, { userMessage: "Hello wor" }, { userMessage: "Hello world" }],
        async () => ({
          parsed: { userMessage: "Hello world" },
          text: '{"userMessage":"Hello world"}',
          usage,
        }),
      ) as never,
    );
    const deltas: string[] = [];
    const result = await executeTurnStream({
      parent: { kind: "wave", id: "w1" },
      seed: { kind: "wave" } as never, // match the seed fixture used in executeTurn.test.ts
      userMessageContent: "hi",
      responseSchema: schema,
      progressText: (p) => (typeof p.userMessage === "string" ? p.userMessage : undefined),
      onTextDelta: (d) => deltas.push(d),
      onAttemptStart: () => undefined,
    });
    expect(deltas.join("")).toBe("Hello world");
    expect(result.parsed).toEqual({ userMessage: "Hello world" });
    // Persisted batch: user_message + assistant_response, same as executeTurn.
    const batch = vi.mocked(appendMessages).mock.calls[0]![0];
    expect(batch.map((r: { kind: string }) => r.kind)).toEqual([
      "user_message",
      "assistant_response",
    ]);
  });

  it("on validation failure: signals new attempt, persists failed+directive rows, retries", async () => {
    vi.mocked(streamChat)
      .mockResolvedValueOnce(
        handleOf([{ userMessage: "bad" }], async () => {
          throw noObjectError('{"wrong":1}');
        }) as never,
      )
      .mockResolvedValueOnce(
        handleOf([{ userMessage: "ok" }], async () => ({
          parsed: { userMessage: "ok" },
          text: '{"userMessage":"ok"}',
          usage,
        })) as never,
      );
    const attempts: number[] = [];
    const result = await executeTurnStream({
      parent: { kind: "wave", id: "w1" },
      seed: { kind: "wave" } as never,
      userMessageContent: "hi",
      responseSchema: schema,
      progressText: (p) => (typeof p.userMessage === "string" ? p.userMessage : undefined),
      onTextDelta: () => undefined,
      onAttemptStart: (i) => attempts.push(i),
    });
    expect(result.parsed).toEqual({ userMessage: "ok" });
    expect(attempts).toEqual([0, 1]);
    const batch = vi.mocked(appendMessages).mock.calls[0]![0];
    expect(batch.map((r: { kind: string }) => r.kind)).toEqual([
      "user_message",
      "failed_assistant_response",
      "harness_retry_directive",
      "assistant_response",
    ]);
  });

  it("skips non-prefix partials (repair rewrote earlier text)", async () => {
    vi.mocked(streamChat).mockResolvedValueOnce(
      handleOf(
        [{ userMessage: "Hello" }, { userMessage: "Goodbye" }, { userMessage: "Hello world" }],
        async () => ({ parsed: { userMessage: "Hello world" }, text: "{}", usage }),
      ) as never,
    );
    const deltas: string[] = [];
    await executeTurnStream({
      parent: { kind: "wave", id: "w1" },
      seed: { kind: "wave" } as never,
      userMessageContent: "hi",
      responseSchema: schema,
      progressText: (p) => (typeof p.userMessage === "string" ? p.userMessage : undefined),
      onTextDelta: (d) => deltas.push(d),
      onAttemptStart: () => undefined,
    });
    // "Goodbye" is not an extension of "Hello" — skipped; "Hello world" is.
    expect(deltas.join("")).toBe("Hello world");
  });
});
```

Adjust the `seed` fixture to whatever `executeTurn.test.ts` uses (read it first) — the `as never` placeholders above must become the real fixture shape.

- [ ] **Step 2: Run to verify failure**

Run: `bun run test src/lib/turn/executeTurnStream.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `src/lib/turn/executeTurnStream.ts`**

```typescript
import {
  appendMessages,
  getMessagesForScopingPass,
  getMessagesForWave,
  getNextTurnIndex,
  type AppendMessageParams,
} from "@/db/queries/contextMessages";
import { streamChat } from "@/lib/llm/streamChat";
import { NoObjectGeneratedError } from "ai";
import type { DeepPartial } from "ai";
import { ValidationGateFailure } from "@/lib/llm/parseAssistantResponse";
import { JSON_PARSE_RETRY_DIRECTIVE } from "@/lib/prompts/turn";
import { SCOPING } from "@/lib/config/tuning";
import type { z } from "zod/v4";
import { assembleLlmMessages } from "./contextAssembly";
import type { ExecuteTurnParams, ExecuteTurnResult } from "./executeTurn";

/**
 * Streaming extension of {@link ExecuteTurnParams}. The three hooks are how
 * the transport (UIMessage stream writer) observes the turn without this
 * module knowing anything about HTTP or the UI protocol.
 */
export interface ExecuteTurnStreamParams<T> extends ExecuteTurnParams<T> {
  /**
   * Project the learner-visible prose out of a (display-only, unvalidated)
   * partial. Return undefined while the field hasn't appeared yet.
   * Wave mid-turns: `(p) => p.userMessage`.
   */
  readonly progressText: (partial: DeepPartial<T>) => string | undefined;
  /** Called with each NEW chunk of prose (suffix-only; monotonic). */
  readonly onTextDelta: (delta: string, attempt: number) => void;
  /** Called before each attempt's stream starts (attempt is 0-based). The transport emits its reset signal for attempts > 0. */
  readonly onAttemptStart: (attempt: number) => void;
}

/**
 * Streaming sibling of `executeTurn` (read that file's contract first —
 * persisted rows, retry budget, atomicity are IDENTICAL; this adds only
 * progressive prose delivery). On a mid-stream validation failure the
 * failed attempt's text was already shown to the learner; the transport
 * layer handles the visual reset via `onAttemptStart`.
 */
export async function executeTurnStream<T>(
  params: ExecuteTurnStreamParams<T>,
): Promise<ExecuteTurnResult<T>> {
  const turnIndex = await getNextTurnIndex(params.parent);
  const priorRows =
    params.parent.kind === "wave"
      ? await getMessagesForWave(params.parent.id)
      : await getMessagesForScopingPass(params.parent.id);

  const userRow: AppendMessageParams = {
    parent: params.parent,
    turnIndex,
    seq: 0,
    kind: "user_message",
    role: "user",
    content: params.userMessageContent,
  };
  const totalAttempts = SCOPING.maxParseRetries + 1;
  const directiveFn = params.retryDirective ?? ((err) => err.detail);

  async function attempt(
    i: number,
    batch: readonly AppendMessageParams[],
  ): Promise<ExecuteTurnResult<T>> {
    const llmMessages = assembleLlmMessages(params.seed, priorRows, batch);
    params.onAttemptStart(i);

    const handle = await streamChat(llmMessages, {
      responseSchema: params.responseSchema,
      responseSchemaName: params.responseSchemaName ?? params.seed.kind,
    });

    // Monotonic-prefix delta emission: only forward growth that extends
    // what we've already shown. Non-prefix rewrites (rare partial-JSON
    // repair artifacts) are skipped; the committed turn text self-heals
    // from server state after the stream finishes.
    const emitted = { text: "" };
    for await (const partial of handle.partialOutputStream) {
      const text = params.progressText(partial);
      if (
        text !== undefined &&
        text.length > emitted.text.length &&
        text.startsWith(emitted.text)
      ) {
        params.onTextDelta(text.slice(emitted.text.length), i);
        emitted.text = text;
      }
    }

    try {
      const final = await handle.final();
      const successRow: AppendMessageParams = {
        parent: params.parent,
        turnIndex,
        seq: batch.length,
        kind: "assistant_response",
        role: "assistant",
        content: final.text,
      };
      await appendMessages([...batch, successRow]);
      return { parsed: final.parsed, usage: final.usage };
    } catch (err) {
      if (!NoObjectGeneratedError.isInstance(err)) throw err;
      const raw = err.text ?? "";
      const gate = toValidationGateFailure(raw, params.responseSchema);
      const failedRow: AppendMessageParams = {
        parent: params.parent,
        turnIndex,
        seq: batch.length,
        kind: "failed_assistant_response",
        role: "assistant",
        content: raw,
      };
      if (i + 1 >= totalAttempts) {
        await appendMessages([...batch, failedRow]);
        throw gate;
      }
      const directiveRow: AppendMessageParams = {
        parent: params.parent,
        turnIndex,
        seq: batch.length + 1,
        kind: "harness_retry_directive",
        role: "user",
        content: directiveFn(gate, i + 1),
      };
      return attempt(i + 1, [...batch, failedRow, directiveRow]);
    }
  }

  return attempt(0, [userRow]);
}

/**
 * Same directive re-derivation as executeTurn's helper — keep the two in
 * sync (or move to a shared module if a third caller appears; two callers
 * doesn't justify the abstraction yet per the no-premature-abstraction rule).
 */
function toValidationGateFailure<T>(raw: string, schema: z.ZodType<T>): ValidationGateFailure {
  const parsed: unknown = (() => {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      return undefined;
    }
  })();
  if (parsed === undefined) {
    return new ValidationGateFailure("missing_response", JSON_PARSE_RETRY_DIRECTIVE);
  }
  const safe = schema.safeParse(parsed);
  return new ValidationGateFailure(
    "missing_response",
    safe.success ? JSON_PARSE_RETRY_DIRECTIVE : safe.error.message,
  );
}
```

Note: `executeTurn.ts` must export `ExecuteTurnParams` and `ExecuteTurnResult` (they already are). Live-smoke formatting (`formatTurn.ts`) is intentionally NOT wired into the streaming path — live smoke exercises the blocking path; add streaming smoke output only if a live streaming test is added later (TODO.md note).

- [ ] **Step 4: Run tests**

Run: `bun run test src/lib/turn/`
Expected: PASS (new file + no regressions).

- [ ] **Step 5: Update `src/lib/turn/CLAUDE.md`** — change "executeTurn is the only thing in here" to name both primitives and their shared contract:

```markdown
`executeTurn` (blocking) and `executeTurnStream` (streaming; adds
progressText/onTextDelta/onAttemptStart hooks) share one contract: load
prior rows → assemble context (`contextAssembly.ts`) → call the LLM →
validate via Output.object → persist one atomic batch. Persisted rows,
retry budget, and ValidationGateFailure semantics are identical across
both — tests assert the same row sequences for each.
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/turn/executeTurnStream.ts src/lib/turn/executeTurnStream.test.ts src/lib/turn/CLAUDE.md
git commit -m "feat(turn): executeTurnStream — streaming turn primitive with identical persistence"
```

---

## Task 5: Split `executeWaveMid` and `submitWaveTurn` for reuse

Pure refactors — no behavior change, existing integration tests are the safety net.

**Files:**

- Create: `src/lib/course/persistWaveMidTurn.ts`
- Create: `src/lib/course/prepareWaveTurn.ts`
- Modify: `src/lib/course/executeWaveMid.ts`
- Modify: `src/lib/course/submitWaveTurn.ts`

- [ ] **Step 1: Extract `persistWaveMidTurn`**

Move everything in `executeWaveMid.ts` AFTER the `executeTurn` call (the `buildAnswerTextMap`/`correctLetterById` lookups, the whole `db.transaction` block, and the `buildAnswerTextMap` helper) into `src/lib/course/persistWaveMidTurn.ts`:

```typescript
/**
 * Post-LLM persistence for one mid-Wave turn: grade prior answers, insert
 * the new questionnaire, dual-write the assistant chat_log entry — one
 * transaction. Shared by the blocking (`executeWaveMid`) and streaming
 * (`streamWaveTurn`) dispatch paths so grading/XP semantics cannot drift.
 */
export async function persistWaveMidTurn(params: {
  readonly ctx: LoadedWaveContext;
  readonly parsed: WaveMidTurn;
  readonly payload: SubmitTurnPayload;
  readonly turnsRemaining: number;
}): Promise<ExecuteWaveMidResult> { ... }
```

The body is the moved code verbatim (imports follow). `executeWaveMid` becomes: capability/schema setup → `executeTurn` → `return persistWaveMidTurn({ ctx, parsed, payload, turnsRemaining })`. Move the `ExecuteWaveMidResult` interface to `persistWaveMidTurn.ts` and re-export from `executeWaveMid.ts` so existing importers don't churn.

- [ ] **Step 2: Run the integration suite for the wave path**

Run: `bun run test:integration src/lib/course/executeWaveMid.integration.test.ts src/lib/course/submitWaveTurn.integration.test.ts`
Expected: PASS unchanged.

- [ ] **Step 3: Extract `prepareWaveTurn`**

Move from `submitWaveTurn.ts` everything between wave resolution and dispatch (context load, closed-wave check, learner entry build, `bug_001` resume detection, §7.4 guards, `turnsRemaining` computation, pre-LLM chat_log append, `buildLearnerInput`, `dispatchCtx` construction) into `src/lib/course/prepareWaveTurn.ts`:

```typescript
/** Everything submitWaveTurn/streamWaveTurn need to dispatch one turn. */
export interface PreparedWaveTurn {
  readonly dispatchCtx: LoadedWaveContext;
  readonly learnerInput: string;
  readonly turnsRemaining: number;
  readonly isCloseTurn: boolean;
  readonly payload: SubmitTurnPayload;
}

/**
 * Guards + idempotency + pre-LLM persistence for one learner turn
 * (spec §3.3 / §7.4). Extracted verbatim from submitWaveTurn so the tRPC
 * (blocking) and route-handler (streaming) transports share one gate.
 * Keep the bug_001 resume-awareness block intact — see its comments.
 */
export async function prepareWaveTurn(params: SubmitWaveTurnParams): Promise<PreparedWaveTurn> { ... }
```

`submitWaveTurn` becomes ~10 lines: `const prep = await prepareWaveTurn(params); return prep.isCloseTurn ? executeWaveClose(prep.dispatchCtx, prep.learnerInput) : executeWaveMid(prep.dispatchCtx, prep.learnerInput, prep.turnsRemaining, prep.payload);`

- [ ] **Step 4: Run integration tests again**

Run: `bun run test:integration src/lib/course/`
Expected: PASS unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/lib/course/persistWaveMidTurn.ts src/lib/course/prepareWaveTurn.ts src/lib/course/executeWaveMid.ts src/lib/course/submitWaveTurn.ts
git commit -m "refactor(course): split wave-turn guards and persistence for streaming reuse"
```

---

## Task 6: Shared stream types + `streamWaveTurn`

**Files:**

- Create: `src/lib/types/waveStream.ts`
- Create: `src/lib/course/streamWaveTurn.ts`
- Test: `src/lib/course/streamWaveTurn.integration.test.ts`

- [ ] **Step 1: Define the UIMessage type shared by route + client**

Create `src/lib/types/waveStream.ts`:

```typescript
import type { UIMessage } from "ai";
import type { SubmitWaveTurnResult } from "@/lib/course/submitWaveTurn";

/**
 * Client-safe projection of a finished turn, delivered as a transient
 * `data-turn-result` part at the end of the stream. Shape matches what the
 * tRPC mutation returned pre-streaming, so the client's XP/close handling
 * ports across mechanically.
 */
export type WaveTurnResultData = SubmitWaveTurnResult;

/** Emitted (transient) before re-streaming after a validation retry. */
export interface WaveTurnResetData {
  readonly attempt: number;
}

/**
 * The wave-turn UI message type: no metadata; two custom data parts.
 * Server writes parts via `createUIMessageStream<WaveTurnUIMessage>`;
 * client consumes via `useChat<WaveTurnUIMessage>` `onData`.
 * Docs: node_modules/ai/docs/04-ai-sdk-ui/20-streaming-data.mdx
 *       (https://ai-sdk.dev/docs/ai-sdk-ui/streaming-data)
 */
export type WaveTurnUIMessage = UIMessage<
  never,
  {
    "turn-result": WaveTurnResultData;
    "turn-reset": WaveTurnResetData;
  }
>;
```

(If `SubmitWaveTurnResult` contains server-only fields, define an explicit client-safe interface here instead and project in `streamWaveTurn` — check `ExecuteWaveMidResult`/`ExecuteWaveCloseResult` field-by-field; as of this writing both are already client-safe projections returned over tRPC.)

- [ ] **Step 2: Implement `streamWaveTurn`**

Create `src/lib/course/streamWaveTurn.ts`:

```typescript
import type { UIMessageStreamWriter } from "ai";
import { getModelCapabilities } from "@/lib/llm/modelCapabilities";
import { toSchemaJsonString } from "@/lib/llm/toCerebrasJsonSchema";
import { buildRetryDirective } from "@/lib/turn/retryDirective";
import { executeTurnStream } from "@/lib/turn/executeTurnStream";
import { waveMidTurnSchema, renderWaveTurnEnvelope } from "@/lib/prompts/waveTurn";
import type { WaveTurnUIMessage } from "@/lib/types/waveStream";
import { buildWaveSeed } from "./buildWaveSeed";
import { prepareWaveTurn, type PreparedWaveTurn } from "./prepareWaveTurn";
import { persistWaveMidTurn } from "./persistWaveMidTurn";
import { executeWaveClose } from "./executeWaveClose";
import type { SubmitWaveTurnParams } from "./submitWaveTurn";

/**
 * Streaming counterpart of `submitWaveTurn`. Same guards (via
 * prepareWaveTurn), same persistence (via persistWaveMidTurn /
 * executeWaveClose); the difference is transport: teaching prose streams
 * as text parts, the finished-turn projection arrives as a transient
 * `data-turn-result` part, and validation retries emit `data-turn-reset`.
 *
 * Close turns (turnsRemaining === 0) run BLOCKING inside the stream —
 * only the final data part is emitted. Streaming close prose is a noted
 * follow-up (TODO.md).
 */
export async function streamWaveTurn(
  params: SubmitWaveTurnParams,
  writer: UIMessageStreamWriter<WaveTurnUIMessage>,
): Promise<void> {
  const prep: PreparedWaveTurn = await prepareWaveTurn(params);

  if (prep.isCloseTurn) {
    const result = await executeWaveClose(prep.dispatchCtx, prep.learnerInput);
    writer.write({ type: "data-turn-result", data: result, transient: true });
    return;
  }

  // Mirror executeWaveMid's schema/envelope setup (inline-schema fallback
  // for non-strict models stays at this layer — see modelCapabilities.ts).
  const capabilities = getModelCapabilities(process.env.LLM_MODEL ?? "(default)");
  const schemaJson = toSchemaJsonString(waveMidTurnSchema, { name: "wave_mid_turn" });

  // Each attempt streams under its own text id so the client can
  // distinguish a retry's fresh text from a continuation.
  const textState = { id: "", open: false };
  const closeText = () => {
    if (textState.open) {
      writer.write({ type: "text-end", id: textState.id });
      textState.open = false;
    }
  };

  const { parsed } = await executeTurnStream({
    parent: { kind: "wave", id: prep.dispatchCtx.wave.id },
    seed: buildWaveSeed(prep.dispatchCtx.course, prep.dispatchCtx.wave),
    userMessageContent: renderWaveTurnEnvelope({
      learnerInput: prep.learnerInput,
      turnsRemaining: prep.turnsRemaining,
      responseSchema: capabilities.honorsStrictMode ? undefined : schemaJson,
    }),
    responseSchema: waveMidTurnSchema,
    responseSchemaName: "wave_mid_turn",
    retryDirective: (err) => buildRetryDirective(err, schemaJson),
    label: "wave-mid",
    progressText: (p) => (typeof p.userMessage === "string" ? p.userMessage : undefined),
    onAttemptStart: (attempt) => {
      closeText();
      if (attempt > 0) {
        writer.write({ type: "data-turn-reset", data: { attempt }, transient: true });
      }
      textState.id = `wave-turn-text-${attempt}`;
      writer.write({ type: "text-start", id: textState.id });
      textState.open = true;
    },
    onTextDelta: (delta) => {
      writer.write({ type: "text-delta", id: textState.id, delta });
    },
  });
  closeText();

  const result = await persistWaveMidTurn({
    ctx: prep.dispatchCtx,
    parsed,
    payload: prep.payload,
    turnsRemaining: prep.turnsRemaining,
  });
  writer.write({ type: "data-turn-result", data: result, transient: true });
}
```

- [ ] **Step 3: Integration test**

Create `src/lib/course/streamWaveTurn.integration.test.ts`. Read `src/lib/course/submitWaveTurn.integration.test.ts` FIRST and reuse its testcontainer setup, fixtures, and `streamChat`-level mocking approach (it mocks `generateChat`; mock `streamChat` the same way using the `handleOf` helper pattern from `executeTurnStream.test.ts`). Assert, with a recording fake writer:

```typescript
/** Minimal recording writer satisfying UIMessageStreamWriter for assertions. */
function recordingWriter() {
  const parts: unknown[] = [];
  return {
    parts,
    writer: {
      write: (part: unknown) => {
        parts.push(part);
      },
      merge: () => undefined,
      onError: undefined,
    } as never,
  };
}
```

Cases (mirroring the blocking suite's coverage):

1. Happy mid-turn: parts sequence is `text-start`, ≥1 `text-delta`, `text-end`, `data-turn-result`; DB rows (context_messages, chat_log, assessments) match what `submitWaveTurn` produces for the same fixture.
2. Validation retry: parts include `data-turn-reset` with `attempt: 1` and two `text-start` ids; final result still lands.
3. Close turn: only `data-turn-result` (kind `close-turn`) — no text parts.

Run: `bun run test:integration src/lib/course/streamWaveTurn.integration.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/lib/types/waveStream.ts src/lib/course/streamWaveTurn.ts src/lib/course/streamWaveTurn.integration.test.ts
git commit -m "feat(course): streamWaveTurn — UIMessage-stream transport over shared turn pipeline"
```

---

## Task 7: Shared auth helper + input schema + the route handler

**Files:**

- Create: `src/server/requestUser.ts`
- Create: `src/server/routers/waveTurnInput.ts`
- Create: `src/app/api/course/[courseId]/wave/[waveNumber]/turn/route.ts`
- Modify: `src/server/trpc.ts`
- Modify: `src/server/routers/wave.ts`

- [ ] **Step 1: Extract `resolveRequestUserId`**

Create `src/server/requestUser.ts` with the body of `createTRPCContext`'s logic (`src/server/trpc.ts:16-26`), generalized to a Web `Request`:

```typescript
import { createClient } from "@/lib/supabase/server";

/**
 * Resolve the requesting user's id. Production: Supabase session cookie
 * (minted by `src/proxy.ts`). Non-production: the `x-dev-user-id` dev-stub
 * header so `just dev` and tests need no Supabase Auth. Shared by the tRPC
 * context and the streaming wave-turn route — one auth story, two transports.
 */
export async function resolveRequestUserId(req: Request): Promise<string | undefined> {
  if (process.env.NODE_ENV === "production") {
    const supabase = await createClient();
    const { data } = await supabase.auth.getUser();
    return data.user?.id;
  }
  return req.headers.get("x-dev-user-id") ?? undefined;
}
```

Update `createTRPCContext` in `src/server/trpc.ts` to `return { userId: await resolveRequestUserId(opts.req) };`. Run `bun run test` — tRPC context tests (if any) must pass unchanged.

- [ ] **Step 2: Extract the turn input schema**

Create `src/server/routers/waveTurnInput.ts` exporting `submitTurnInputSchema` — move the entire `z.object({ courseId, waveNumber, payload })` literal from `wave.ts`'s `.input(...)` (verbatim, comments included). Update `wave.ts` to `.input(submitTurnInputSchema)`.

- [ ] **Step 3: Write the route handler**

Create `src/app/api/course/[courseId]/wave/[waveNumber]/turn/route.ts`:

```typescript
import { createUIMessageStream, createUIMessageStreamResponse } from "ai";
import { z } from "zod/v4";
import { resolveRequestUserId } from "@/server/requestUser";
import { submitTurnInputSchema } from "@/server/routers/waveTurnInput";
import { ensureUserProfile } from "@/db/queries";
import { userIdStore } from "@/lib/llm/userIdStore";
import { streamWaveTurn } from "@/lib/course/streamWaveTurn";
import type { WaveTurnUIMessage } from "@/lib/types/waveStream";

// A turn can span LLM retries + Cerebras pacing; keep the function alive
// well past the worst case (3 attempts × generation + slow-lane spacing).
export const maxDuration = 300;

/**
 * Streaming wave-turn transport (replaces tRPC `wave.submitTurn` on the
 * client; the mutation remains server-side as a rollback path for one
 * release). Protocol: AI SDK UI Message Stream (SSE) — text parts carry
 * teaching prose, transient `data-turn-result` carries the grading/XP
 * projection, transient `data-turn-reset` precedes a validation re-stream.
 * Docs: node_modules/ai/docs/04-ai-sdk-ui/20-streaming-data.mdx
 *       https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ courseId: string; waveNumber: string }> },
) {
  const userId = await resolveRequestUserId(req);
  if (!userId) return new Response("Unauthorized", { status: 401 });
  await ensureUserProfile(userId);

  const { courseId, waveNumber } = await params;
  // The body carries ONLY the payload — context is rebuilt from the DB
  // (LLM-stateless principle; client messages are never trusted/needed).
  const body: unknown = await req.json();
  const input = submitTurnInputSchema.safeParse({
    courseId,
    waveNumber: Number(waveNumber),
    payload: (body as { payload?: unknown }).payload,
  });
  if (!input.success) {
    return Response.json({ error: z.treeifyError(input.error) }, { status: 400 });
  }

  const stream = createUIMessageStream<WaveTurnUIMessage>({
    // Bind userId into ALS for the Cerebras rate limiter — same contract
    // as protectedProcedure (src/server/trpc.ts).
    execute: ({ writer }) =>
      userIdStore.run(userId, () =>
        streamWaveTurn(
          {
            userId,
            courseId: input.data.courseId,
            waveNumber: input.data.waveNumber,
            payload: input.data.payload,
          },
          writer,
        ),
      ),
    // Surfaced to useChat's onError. Keep messages generic; TRPCError codes
    // from the guards (PRECONDITION_FAILED etc.) map to their message text.
    onError: (error) => (error instanceof Error ? error.message : "turn failed"),
  });

  return createUIMessageStreamResponse({ stream });
}
```

Check Next.js 16.2 docs (`node_modules/next/dist/docs/`) for the `params`-as-Promise route signature — it changed in Next 15+ and may differ again in 16.2; align with what the docs say, not training data. Likewise verify `z.treeifyError` exists in the repo's zod version (it's the Zod v4 replacement for `.flatten()`); if the repo uses a different error-shaping helper elsewhere, match it.

- [ ] **Step 4: Typecheck + lint**

Run: `just typecheck && just lint`
Expected: clean. Common failure: `UIMessageStreamWriter` generic mismatch — re-check the data-part type keys (`"turn-result"`, not `"data-turn-result"`, in the `UIMessage` generic; the `data-` prefix appears only on the wire `type` field).

- [ ] **Step 5: Commit**

```bash
git add src/server/requestUser.ts src/server/routers/waveTurnInput.ts src/server/trpc.ts src/server/routers/wave.ts "src/app/api/course/[courseId]/wave/[waveNumber]/turn/route.ts"
git commit -m "feat(api): streaming wave-turn route on the UI message stream protocol"
```

---

## Task 8: Client — `useChat` for the in-flight turn

**Files:**

- Modify: `package.json` (add `@ai-sdk/react`)
- Modify: `src/hooks/useWaveState.ts`
- Modify: `src/components/chat/WaveSession.tsx`

- [ ] **Step 1: Install the React bindings**

Run: `bun add @ai-sdk/react`
Pin whatever version bun resolves; it must satisfy `ai@6.x` peer range.

- [ ] **Step 2: Rework `useWaveState`**

The shape of the change (read the current file fully first; the XP/closeResult logic moves, it doesn't change):

```typescript
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { WaveTurnUIMessage } from "@/lib/types/waveStream";

// Inside useWaveState:
const chat = useChat<WaveTurnUIMessage>({
  // One chat instance per wave — id remounts state on wave navigation.
  id: `wave-${courseId}-${waveNumber}`,
  transport: new DefaultChatTransport({
    api: `/api/course/${courseId}/wave/${waveNumber}/turn`,
    // The server rebuilds context from the DB; send ONLY the payload.
    // (messages would otherwise ship the whole transient history.)
    prepareSendMessagesRequest: ({ body }) => ({ body: { payload: body?.payload } }),
  }),
  onData: (part) => {
    if (part.type === "data-turn-reset") {
      // A validation retry is about to re-stream: drop the partial bubble.
      chat.setMessages((prev) => prev.filter((m) => m.role !== "assistant"));
      return;
    }
    if (part.type === "data-turn-result") {
      handleTurnResult(part.data); // exact body of the old submitTurn onSuccess
    }
  },
  onFinish: () => {
    // Committed state is server-derived; refetch then drop the transient
    // streaming messages so the bubble is replaced by the canonical turn.
    void qc.invalidateQueries({ queryKey: stateOpts.queryKey }).then(() => {
      chat.setMessages([]);
    });
  },
  onError: () => {
    toast.error("Couldn't submit that turn", {
      description: "Please try again.",
    });
    chat.setMessages([]);
  },
});
```

- `handleTurnResult(result)` is a function containing the existing `onSuccess` branches from the `submitTurn` mutation verbatim (mid-turn XP sum / close-turn `setCloseResult` + completion XP + tier toast). The `invalidateState()` call moves to `onFinish`.
- `submitChatText` becomes:

```typescript
const submitChatText = (text: string) => {
  void chat.sendMessage({ text }, { body: { payload: { kind: "chat-text", text } } });
};
```

- `submitQuestionnaireAnswers` mirrors it with the `questionnaire-answers` payload (same guard on `activeQuestionnaire`); the optimistic user bubble for answers comes from `sendMessage`'s text — pass a short summary text (e.g. `"Answers submitted"`) or keep the existing optimistic-bubble mechanism in `WaveSession` (check how it renders today and keep that path; the `onError` option per-call moves to a try/finally around `sendMessage` if WaveSession needs its reshow hook — `sendMessage` returns a promise).
- `isPending` becomes `state.isFetching || chat.status === "submitted" || chat.status === "streaming"`.
- Export new fields: `streamingText` (concatenated text parts of the last assistant message in `chat.messages`) and `streamStatus: chat.status` for the UI.
- DELETE the `useMutation(trpc.wave.submitTurn...)` block. Leave the server-side procedure untouched.

- [ ] **Step 3: Render the streaming bubble**

In `WaveSession.tsx`: where the pending state currently renders (spinner/typing indicator while `isPending`), render `streamingText` inside a standard assistant `MessageBubble` when non-empty, with the typing indicator before first token. Keep markup consistent with committed bubbles so the swap on invalidation is visually seamless. (Read the component first; match its existing structure — this step is intentionally described functionally because the component's internals are UI-specific; everything it consumes is defined above.)

- [ ] **Step 4: Manual verification**

Run: `just dev`, open a course with an active wave, submit a chat turn.
Expected: prose appears progressively; on completion the bubble persists (now from server state); XP badge pulses on graded answers; questionnaire card appears after invalidation; close turn shows the move-on CTA. Then run the Playwright suite if one covers the wave session: `bunx playwright test` (check `playwright.config.ts` for the project layout).

- [ ] **Step 5: Full check + commit**

Run: `just check`

```bash
git add package.json bun.lock src/hooks/useWaveState.ts src/components/chat/WaveSession.tsx
git commit -m "feat(ui): stream wave-turn prose via useChat; tRPC keeps state queries"
```

---

## Task 9: Docs, TODO, handoff

- [ ] **Step 1: Update `src/lib/course/CLAUDE.md` and `src/server/routers/CLAUDE.md`** — note the dual transport: tRPC for state/queries, the route handler for streamed turn dispatch; `prepareWaveTurn`/`persistWaveMidTurn` as the shared spine.

- [ ] **Step 2: Append to `TODO.md`:**

```markdown
- Streaming follow-ups (2026-06-10 plan): stream close-turn prose; resumable streams on reload (chatbot-resume-streams doc); remove tRPC wave.submitTurn after one stable release; consider full useChat message-state adoption with the tool-calling migration.
```

- [ ] **Step 3: `just check`, then live smoke (`just smoke`)** — the blocking path the smoke suite exercises must be untouched; if smoke is green and manual streaming verification passed, follow `superpowers:finishing-a-development-branch`.

---

## Self-review checklist (for the executing agent)

- [ ] `bug_001` resume block lives in `prepareWaveTurn` verbatim (diff the moved lines).
- [ ] `userIdStore.run` wraps the route's execute — without it the per-user fast lane silently degrades to anonymous pacing.
- [ ] Row sequences asserted identical between `executeTurn.test.ts` and `executeTurnStream.test.ts` (same kinds, same order).
- [ ] No component imports from `src/lib/course/` except types (boundary rule: UI never imports lib logic — `deriveWaveTurns` is the pre-existing exception, keep it as-is).
- [ ] `wave.submitTurn` procedure still exists and passes its integration tests (rollback path).
- [ ] Every new file has TSDoc on every export (warning-tier gate will fire otherwise).
