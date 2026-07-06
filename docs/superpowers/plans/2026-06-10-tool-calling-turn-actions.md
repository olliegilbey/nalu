# Tool Calling for Turn Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the mid-Wave "mega-schema" (one JSON object forced to carry teaching prose + grading verdicts + questionnaire in a single emission) with standard AI SDK tool calls: prose becomes plain streamed text; structured actions become typed tools the model invokes when appropriate.

**Architecture:** A mid-Wave turn becomes a short `streamText` tool loop (`stopWhen: stepCountIs(...)`): the model may call `recordComprehensionSignals` (grading the learner's prior answers) and/or `presentQuestionnaire` (dropping new concept-check questions), then writes teaching prose as ordinary text. Tool `execute` functions do NOT touch the DB — they validate and stage results into a per-turn collector; the existing post-loop transaction (`persistWaveMidTurn`) consumes the collector exactly as it consumed the mega-schema fields. Persistence of the conversation gains two new `context_messages` kinds (`assistant_tool_call`, `tool_result`) so the replayed Context reproduces the tool loop faithfully. The client renders tool parts via `useChat` (questionnaire cards stream in as typed tool-input parts — generative UI).

**Tech Stack:** `ai@6.0.158` (`streamText`, `tool()`, `inputSchema`, `stopWhen`/`stepCountIs`, `toolChoice`, UIMessage tool parts), `@ai-sdk/react`, Zod v4, Drizzle migration, Vitest.

**Branch:** create `feat/tool-calling-turn-actions` off `main`.

**Prerequisites:**

1. `2026-06-10-ai-sdk-output-object.md` — merged.
2. `2026-06-10-streaming-wave-turns.md` — merged (this plan extends `streamWaveTurn`, the route, and the `useChat` client).
3. **The Task 1 reliability gate below passes.** If it fails, STOP after Task 1 and report — everything else is conditional on the model.

---

## Why this change (context for zero-context agents)

Today `waveMidTurnSchema` (`src/lib/prompts/waveTurn.ts`) forces every model response into one object: `userMessage` (prose) + optional `comprehensionSignals` + optional `questionnaire`, papered over with `superRefine` cross-field rules whose failure messages double as retry directives. This works, but:

- **It fights the grain of 2026 models.** Models are heavily post-trained on native tool calling; "emit one giant JSON blob with optional sub-objects" gets less training signal than "call `presentQuestionnaire` with these args".
- **Prose quality suffers inside JSON.** Teaching text trapped in a JSON string field can't stream as readable tokens without the partial-JSON projection machinery Phase 2 built, and models write measurably stiffer prose inside string literals (escaping, no newline freedom).
- **Per-action schemas beat one mega-schema.** Each tool's `inputSchema` validates independently; a malformed questionnaire doesn't invalidate an otherwise good teaching turn. The SDK feeds schema-validation failures back to the model as tool-error results natively (see "Tool Call Repair" in the tool-calling doc) instead of our whole-turn retry loop.
- **It unlocks the platform direction.** UIMessage tool parts give the client typed, streaming generative UI; later phases (agent loop, harness→model tools like `getDueConcepts`) require the tool channel to exist.

What does NOT change: the Core Design Principle (`AGENTS.md`) — deterministic code owns XP, SM-2, progression. Tools are _emission channels_, not authority transfers. The model still never sees XP.

## Documentation manifest

**Read before writing code.** Local copies are version-matched to `ai@6.0.158`.

| Topic                                                                                        | Local                                                                 | Web                                                                                                                     |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Tool calling (tool(), inputSchema, execute, toolChoice, strict mode, repair, errors)         | `node_modules/ai/docs/03-ai-sdk-core/15-tools-and-tool-calling.mdx`   | https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling                                                              |
| Tools foundations                                                                            | `node_modules/ai/docs/02-foundations/04-tools.mdx`                    | https://ai-sdk.dev/docs/foundations/tools                                                                               |
| `tool()` reference                                                                           | —                                                                     | https://ai-sdk.dev/docs/reference/ai-sdk-core/tool                                                                      |
| Loop control (`stopWhen`, `stepCountIs`, `prepareStep`)                                      | `node_modules/ai/docs/03-agents/04-loop-control.mdx`                  | https://ai-sdk.dev/docs/agents/loop-control                                                                             |
| Agents overview (single-call-with-tools vs loops)                                            | `node_modules/ai/docs/03-agents/01-overview.mdx`                      | https://ai-sdk.dev/docs/agents/overview                                                                                 |
| Chatbot tool usage (client rendering of tool parts, `addToolResult`)                         | `node_modules/ai/docs/04-ai-sdk-ui/03-chatbot-tool-usage.mdx`         | https://ai-sdk.dev/docs/ai-sdk-ui/chatbot-tool-usage                                                                    |
| Generative user interfaces (rendering tool parts as components)                              | `node_modules/ai/docs/04-ai-sdk-ui/04-generative-user-interfaces.mdx` | https://ai-sdk.dev/docs/ai-sdk-ui/generative-user-interfaces                                                            |
| Prompts incl. tool messages in `ModelMessage` (assistant tool-call parts, tool-role results) | `node_modules/ai/docs/02-foundations/03-prompts.mdx`                  | https://ai-sdk.dev/docs/foundations/prompts                                                                             |
| Cerebras tool-calling capability + caveats                                                   | —                                                                     | https://inference-docs.cerebras.ai/capabilities/tool-calling (verify path; start at https://inference-docs.cerebras.ai) |
| Stream protocol (tool-input-start/delta/available chunks)                                    | `node_modules/ai/docs/04-ai-sdk-ui/50-stream-protocol.mdx`            | https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol                                                                       |
| Testing                                                                                      | `node_modules/ai/docs/03-ai-sdk-core/55-testing.mdx`                  | https://ai-sdk.dev/docs/ai-sdk-core/testing                                                                             |
| Doc search API                                                                               | —                                                                     | `https://ai-sdk.dev/api/search-docs?q=your_query`                                                                       |

## Background reading (repo)

- `docs/PRD.md` §3.3, §4.3, §6.5 — turn lifecycle, grading semantics, and the (legacy) tag contract this supersedes.
- `src/lib/prompts/waveTurn.ts` — the mega-schema being decomposed; its `.describe()` strings and superRefine messages are the raw material for tool descriptions.
- `src/lib/prompts/teaching.ts` — the Wave system prompt; its output-format instructions get rewritten for tools.
- `src/lib/course/streamWaveTurn.ts`, `src/lib/course/persistWaveMidTurn.ts`, `src/lib/turn/executeTurnStream.ts` — the Phase-2 pipeline being extended.
- `src/lib/turn/contextAssembly.ts` — where the `tool` role currently throws; this plan implements it.
- `src/db/schema.ts` + `src/db/queries/contextMessages.ts` — row kinds and the append/read API gaining tool rows.
- `src/lib/llm/renderContext.ts` + its tests — the byte-stability invariants you MUST preserve (cache prefix). Read the test file before touching anything.
- `scripts/probe-model.ts` — the model probe harness Task 1 extends.
- Memory/context: Cerebras free-tier reliability varies by model; `response_format` is soft. The per-user rate limiter (`cerebrasRateLimit.ts`) paces EVERY call — a 3-step tool loop is 3 paced calls. Cost/latency math lives in the Decision Gate below.

## Decision gate (Task 1 output)

Tool calling multiplies request count: a turn that was 1 LLM call becomes 1-4 (text → tool call → tool result → continuation). Under the per-user fast lane (200ms spacing) this adds ~1s overhead worst-case; under the slow lane (13s spacing) it adds up to ~40s. The gate criteria:

- **GO** if the probe shows ≥ 95% valid tool-call rate (correct tool name + schema-valid args over 20 trials) AND median loop depth for the scripted teaching scenario ≤ 3 steps.
- **NO-GO** if tool-call rate < 95% (the model emits malformed/hallucinated calls — retry burn would erase the UX win) or the provider rejects `tools` for the configured model. On NO-GO: file findings in `docs/status/`, stop, and re-evaluate the model choice (paid-tier model list: https://inference-docs.cerebras.ai/models/overview) before resuming.

## Target tool surface (mid-turn)

| Tool                         | Replaces                                 | inputSchema source                                                 |
| ---------------------------- | ---------------------------------------- | ------------------------------------------------------------------ |
| `recordComprehensionSignals` | `waveMidTurnSchema.comprehensionSignals` | `comprehensionSignalSchema` array, moved from `waveTurn.ts`        |
| `presentQuestionnaire`       | `waveMidTurnSchema.questionnaire`        | `questionnaireSchema` + the conceptName/correct superRefine, moved |
| _(plain text)_               | `waveMidTurnSchema.userMessage`          | — prose is just text now                                           |

Close turns keep the Phase-2 blocking path in this plan (their `makeCloseTurnBaseSchema` decomposition into `proposeNextLessonBlueprint` + `updateCourseSummary` + `gradeFinalAnswers` tools follows the identical recipe and is deferred — note it in TODO.md at the end).

## File touch list

- **Create:** `src/lib/llm/streamToolTurn.ts` (+ test) — tool-loop sibling of `streamChat`.
- **Create:** `src/lib/course/waveTurnTools.ts` (+ test) — tool definitions + per-turn collector.
- **Create:** `drizzle/00XX_tool_call_rows.sql` (via drizzle-kit) — new `context_messages.kind` values.
- **Modify:** `src/db/schema.ts`, `src/db/queries/contextMessages.ts` — kinds + append support.
- **Modify:** `src/lib/llm/renderContext.ts` (+ tests) — render tool rows into `ModelMessage` tool parts.
- **Modify:** `src/lib/turn/contextAssembly.ts` — implement the `tool` role branch.
- **Create:** `src/lib/turn/executeToolTurnStream.ts` (+ test) — tool-loop turn primitive (persists tool rows).
- **Modify:** `src/lib/course/streamWaveTurn.ts` — dispatch mid-turns through the tool loop.
- **Modify:** `src/lib/prompts/teaching.ts` (+ test) — system prompt rewritten for tools.
- **Modify:** `src/lib/prompts/waveTurn.ts` — mega-schema dismantled (envelope renderer stays).
- **Modify:** `src/lib/types/waveStream.ts` — tool parts join the UIMessage type.
- **Modify:** `src/hooks/useWaveState.ts` + `src/components/chat/WaveSession.tsx` — questionnaire renders from streamed tool parts.
- **Modify:** `scripts/probe-model.ts` — tool-call reliability probe.

---

## Task 1: Tool-call reliability probe (THE GATE)

> **VERDICT (2026-07-06): GO.** 95.0% / 100.0% valid-call rate on consecutive
> runs, median 2 steps — with the wire/validator-split schema. Full numbers +
> three binding findings (reasoning_content stripping, wire/validator split
> for tool schemas, invalid-input surfacing) in
> `docs/status/2026-07-06-tool-call-probe-verdict.md`.

**Files:**

- Modify: `scripts/probe-model.ts` (read it first; follow its existing structure for model/env handling)

- [x] **Step 1: Add a `--tools` probe mode**

Add a function that runs N=20 trials of a scripted teaching turn against the live model with two tools defined (no DB, no app code — pure SDK):

```typescript
import { generateText, tool, stepCountIs } from "ai";
import { z } from "zod/v4";

/** One trial: ask for a teach+quiz turn; count valid/invalid tool behavior. */
async function probeToolCalling(model: LanguageModelV3): Promise<{
  validCalls: number;
  invalidCalls: number;
  noCallWhenRequired: number;
  steps: number[];
}> {
  const tally = { validCalls: 0, invalidCalls: 0, noCallWhenRequired: 0, steps: [] as number[] };
  for (let trial = 0; trial < 20; trial++) {
    const result = await generateText({
      model,
      stopWhen: stepCountIs(4),
      tools: {
        presentQuestionnaire: tool({
          description:
            "Present a short concept-check quiz to the learner. Call at most once per turn, AFTER your teaching prose.",
          inputSchema: z.object({
            questions: z
              .array(
                z.object({
                  id: z.string(),
                  conceptName: z.string(),
                  type: z.enum(["multiple_choice", "free_text"]),
                  question: z.string(),
                  options: z.record(z.string(), z.string()).optional(),
                  correct: z.enum(["A", "B", "C", "D"]).optional(),
                }),
              )
              .min(1)
              .max(3),
          }),
          // Staging-only execute — the probe just acknowledges.
          execute: async () => ({ accepted: true }),
        }),
        recordComprehensionSignals: tool({
          description: "Record grading verdicts for answers the learner just gave.",
          inputSchema: z.object({
            signals: z.array(
              z.object({
                questionId: z.string(),
                verdict: z.enum(["correct", "partial", "incorrect"]),
              }),
            ),
          }),
          execute: async () => ({ recorded: true }),
        }),
      },
      system:
        "You are a tutor. Teach the requested concept in under 120 words, then call presentQuestionnaire with 1-2 questions checking it.",
      prompt: `Teach trial #${trial}: the difference between let and const in JavaScript.`,
    });
    tally.steps.push(result.steps.length);
    const calls = result.steps.flatMap((s) => s.toolCalls);
    if (calls.length === 0) tally.noCallWhenRequired++;
    for (const c of calls) {
      // The SDK already schema-validated successful calls; invalid ones
      // surface as tool-error parts in step content.
      if (c.toolName === "presentQuestionnaire" || c.toolName === "recordComprehensionSignals") {
        tally.validCalls++;
      } else {
        tally.invalidCalls++;
      }
    }
    const errors = result.steps.flatMap((s) => s.content.filter((p) => p.type === "tool-error"));
    tally.invalidCalls += errors.length;
  }
  return tally;
}
```

Wire it behind a CLI flag following the script's existing arg parsing, printing the tally + a GO/NO-GO line against the criteria in the Decision Gate section. Check `result.steps` field shapes against `node_modules/ai/docs/03-ai-sdk-core/15-tools-and-tool-calling.mdx` ("Multi-Step Calls" + "Tool Errors" sections) — adjust property names to the installed version if they differ.

- [x] **Step 2: Run the probe (live; uses real Cerebras budget — ~20-80 calls)**

Run: `just probe-model gpt-oss-120b -- --tools` (match the justfile's probe recipe syntax — read `justfile`).
Expected: a tally + GO/NO-GO verdict.

- [x] **Step 3: Record the verdict**

Write the numbers into `docs/status/` as a dated note AND into this plan file under this task. **If NO-GO: stop here, commit the probe, report.**

- [x] **Step 4: Commit**

```bash
git add scripts/probe-model.ts docs/status/
git commit -m "feat(scripts): tool-call reliability probe + gate verdict"
```

---

## Task 2: Persistence — tool rows in `context_messages`

The Context is append-only and replayed verbatim (LLM-stateless principle, `AGENTS.md`). A tool loop produces: assistant text+tool-call step(s), tool results, final assistant text. All of it must persist and re-render byte-stably.

**Files:**

- Modify: `src/db/schema.ts` (the `kind` CHECK / enum for `context_messages`)
- Create: migration via `bunx drizzle-kit generate` (check `package.json`/`justfile` for the repo's migration command)
- Modify: `src/db/queries/contextMessages.ts`

- [ ] **Step 1: Add the kinds**

In `src/db/schema.ts`, extend the `context_messages.kind` allowed values with `"assistant_tool_call"` and `"tool_result"`. Row content contracts (document next to the schema):

- `assistant_tool_call`: `role='assistant'`, `content` = JSON `{ "text": string, "toolCalls": [{ "toolCallId": string, "toolName": string, "input": unknown }] }` — one row per assistant step that contained tool calls (text may be empty).
- `tool_result`: `role='tool'`, `content` = JSON `{ "results": [{ "toolCallId": string, "toolName": string, "output": unknown }] }` — one row per step's results batch.

Generate + apply the migration with the repo's drizzle workflow.

- [ ] **Step 2: Append-path support**

`appendMessages` in `src/db/queries/contextMessages.ts` is kind-agnostic (verify — it takes `kind`/`role`/`content` as given); if any switch narrows kinds, extend it. Add the two kinds to whatever Zod row-guard validates reads.

- [ ] **Step 3: Tests**

Extend the existing `contextMessages` query tests (or integration tests) with an insert+read round-trip for both kinds. Run: `bun run test:integration src/db/`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/db/ drizzle/
git commit -m "feat(db): assistant_tool_call + tool_result context row kinds"
```

---

## Task 3: Render tool rows into `ModelMessage`s

**Files:**

- Modify: `src/lib/llm/renderContext.ts`
- Modify: `src/lib/turn/contextAssembly.ts`
- Test: `src/lib/llm/renderContext.test.ts`

- [ ] **Step 1: Write failing render tests**

Read `renderContext.test.ts` first — REUSE its fixtures and byte-stability assertion helpers. Add cases:

```typescript
it("renders an assistant_tool_call row as assistant text+tool-call parts and tool_result as a tool message", () => {
  const rows = [
    row({ kind: "user_message", role: "user", content: "hi", turnIndex: 0, seq: 0 }),
    row({
      kind: "assistant_tool_call",
      role: "assistant",
      content: JSON.stringify({
        text: "Let me check that.",
        toolCalls: [
          { toolCallId: "c1", toolName: "presentQuestionnaire", input: { questions: [] } },
        ],
      }),
      turnIndex: 0,
      seq: 1,
    }),
    row({
      kind: "tool_result",
      role: "tool",
      content: JSON.stringify({
        results: [
          { toolCallId: "c1", toolName: "presentQuestionnaire", output: { accepted: true } },
        ],
      }),
      turnIndex: 0,
      seq: 2,
    }),
    row({
      kind: "assistant_response",
      role: "assistant",
      content: "Here's your quiz.",
      turnIndex: 0,
      seq: 3,
    }),
  ];
  const rendered = renderContext(seed, rows);
  // Structured messages now — renderContext's message entries gain a
  // `parts` representation for these kinds (see Step 2 design note).
  expect(rendered.messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
});

it("tool rows preserve cache-prefix byte stability when later rows append", () => {
  // Mirror the existing prefix-stability test's structure with tool rows included.
});
```

- [ ] **Step 2: Implement**

Design note: `renderContext` today returns `{ system, messages: { role, content: string }[] }`. Tool messages need structured content (`ModelMessage`'s assistant tool-call parts and tool-role `ToolContent` arrays — shapes documented in `node_modules/ai/docs/02-foundations/03-prompts.mdx`). Change the rendered message type to carry an optional `parts` payload:

```typescript
/** Rendered message: plain string content, or structured tool payloads for the two tool kinds. */
export type RenderedMessage =
  | { readonly role: "user" | "assistant" | "system"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly kind: "tool-call";
      readonly text: string;
      readonly toolCalls: readonly { toolCallId: string; toolName: string; input: unknown }[];
    }
  | {
      readonly role: "tool";
      readonly results: readonly { toolCallId: string; toolName: string; output: unknown }[];
    };
```

Parsing the row JSON happens here with a Zod guard (trust boundary — DB reads are validated, per `AGENTS.md`). Byte-stability: the JSON in `content` was serialized once at write time and is parsed (not re-serialized) at render — the prompt-cache prefix depends on the final `ModelMessage` array the provider serializes; determinism holds because the stored bytes are the source. Preserve the per-turn retry-filter behavior for the new kinds (tool rows belong to the turn group of their `turnIndex` — they ride along with whatever the filter decides for that group).

Then in `src/lib/turn/contextAssembly.ts`, replace the `tool`-role throw with mapping to real `ModelMessage`s:

```typescript
if (m.role === "tool") {
  return {
    role: "tool",
    content: m.results.map((r) => ({
      type: "tool-result" as const,
      toolCallId: r.toolCallId,
      toolName: r.toolName,
      output: { type: "json" as const, value: r.output },
    })),
  };
}
if (m.role === "assistant" && "kind" in m && m.kind === "tool-call") {
  return {
    role: "assistant",
    content: [
      ...(m.text ? [{ type: "text" as const, text: m.text }] : []),
      ...m.toolCalls.map((c) => ({
        type: "tool-call" as const,
        toolCallId: c.toolCallId,
        toolName: c.toolName,
        input: c.input,
      })),
    ],
  };
}
```

Verify the exact `ToolContent`/`ToolCallPart` property names against `node_modules/ai/src/` (search `ToolCallPart` and `ToolResultPart`) — `input`/`output` vs `args`/`result` naming changed across SDK majors; trust the installed source.

- [ ] **Step 3: Run tests**

Run: `bun run test src/lib/llm/renderContext.test.ts src/lib/turn/`
Expected: PASS, including ALL pre-existing byte-stability tests untouched.

- [ ] **Step 4: Commit**

```bash
git add src/lib/llm/renderContext.ts src/lib/llm/renderContext.test.ts src/lib/turn/contextAssembly.ts
git commit -m "feat(llm): render persisted tool rows as ModelMessage tool parts"
```

---

## Task 4: Tool definitions + per-turn collector

**Files:**

- Create: `src/lib/course/waveTurnTools.ts`
- Test: `src/lib/course/waveTurnTools.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
import { describe, it, expect } from "vitest";
import { buildWaveMidTurnTools } from "./waveTurnTools";

describe("buildWaveMidTurnTools", () => {
  it("stages a valid questionnaire into the collector", async () => {
    const { tools, collector } = buildWaveMidTurnTools();
    const result = await tools.presentQuestionnaire.execute!(
      {
        questions: [
          {
            id: "q1",
            conceptName: "ownership",
            type: "multiple_choice",
            question: "?",
            options: { A: "a", B: "b", C: "c", D: "d" },
            correct: "A",
          },
        ],
      },
      { toolCallId: "c1", messages: [] },
    );
    expect(result).toEqual({ accepted: true, questionCount: 1 });
    expect(collector.questionnaire?.questions).toHaveLength(1);
  });

  it("rejects a second questionnaire in the same turn with a model-readable error", async () => {
    const { tools, collector } = buildWaveMidTurnTools();
    const q = {
      questions: [{ id: "q1", conceptName: "x", type: "free_text" as const, question: "?" }],
    };
    await tools.presentQuestionnaire.execute!(q, { toolCallId: "c1", messages: [] });
    const second = await tools.presentQuestionnaire.execute!(q, { toolCallId: "c2", messages: [] });
    expect(second).toMatchObject({ accepted: false });
    expect(collector.questionnaire?.questions).toHaveLength(1); // first one kept
  });

  it("stages comprehension signals", async () => {
    const { tools, collector } = buildWaveMidTurnTools();
    await tools.recordComprehensionSignals.execute!(
      { signals: [{ kind: "mc-index", questionId: "q1", rationale: "Two sentences. Here." }] },
      { toolCallId: "c1", messages: [] },
    );
    expect(collector.signals).toHaveLength(1);
  });
});
```

(Verify `execute`'s second-arg shape — `ToolCallOptions` — in the tool() reference; adjust the test stub accordingly.)

- [ ] **Step 2: Implement**

```typescript
import { tool } from "ai";
import { z } from "zod/v4";
// Move these schemas out of waveTurn.ts (Task 6 deletes the mega-schema):
import { comprehensionSignalSchema } from "@/lib/prompts/waveTurn";
import { questionnaireSchema } from "@/lib/prompts/questionnaire";

/** Mutable per-turn staging area filled by tool executes, drained by persistWaveMidTurn. */
export interface WaveTurnCollector {
  questionnaire: z.infer<typeof tightQuestionnaireSchema> | null;
  signals: z.infer<typeof comprehensionSignalSchema>[];
}

// The conceptName/correct tightening that lived in waveMidTurnSchema's
// superRefine moves here, onto the TOOL's inputSchema — the SDK feeds a
// schema violation back to the model as a tool error it can correct in
// the next step, replacing the whole-turn retry directive for this case.
const tightQuestionnaireSchema = questionnaireSchema.superRefine((val, ctx) => {
  val.questions.forEach((q, idx) => {
    if (!q.conceptName?.trim()) {
      ctx.addIssue({
        code: "custom",
        path: ["questions", idx, "conceptName"],
        message: `question ${q.id} is missing required conceptName. Every quiz question must name the concept it assesses; for an ungraded reflective question, ask it in your teaching prose instead.`,
      });
    }
    if (q.type === "multiple_choice" && q.correct === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["questions", idx, "correct"],
        message: `MC question ${q.id} is missing required correct key (A, B, C, or D).`,
      });
    }
  });
});

/**
 * Build the mid-turn tool set bound to a fresh collector. Executes are
 * STAGING ONLY — no DB access, no XP, no SM-2 (Core Design Principle:
 * deterministic code consumes the collector after the loop ends).
 * Descriptions reuse the .describe() guidance from the old mega-schema.
 */
export function buildWaveMidTurnTools() {
  const collector: WaveTurnCollector = { questionnaire: null, signals: [] };
  const tools = {
    recordComprehensionSignals: tool({
      description:
        "Record your grading of answers the learner just submitted. Call once, before teaching, when the learner answered questions last turn. Omit for pure teaching turns.",
      inputSchema: z.object({ signals: z.array(comprehensionSignalSchema).min(1) }),
      execute: async ({ signals }) => {
        collector.signals.push(...signals);
        return { recorded: signals.length };
      },
    }),
    presentQuestionnaire: tool({
      description:
        "Present a graded concept-check quiz (1-3 questions) to the learner. Call at most once per turn, after your teaching prose. Every question carries conceptName; every multiple-choice question carries correct.",
      inputSchema: tightQuestionnaireSchema,
      execute: async (questionnaire) => {
        if (collector.questionnaire !== null) {
          // Model-readable refusal — comes back as the tool result so the
          // model self-corrects within the loop instead of a harness retry.
          return { accepted: false, reason: "a questionnaire was already presented this turn" };
        }
        collector.questionnaire = questionnaire;
        return { accepted: true, questionCount: questionnaire.questions.length };
      },
    }),
  } as const;
  return { tools, collector };
}
```

- [ ] **Step 3: Run tests, then commit**

Run: `bun run test src/lib/course/waveTurnTools.test.ts`

```bash
git add src/lib/course/waveTurnTools.ts src/lib/course/waveTurnTools.test.ts
git commit -m "feat(course): mid-turn tool definitions with staging collector"
```

---

## Task 5: `executeToolTurnStream` — tool-loop turn primitive

**Files:**

- Create: `src/lib/turn/executeToolTurnStream.ts`
- Test: `src/lib/turn/executeToolTurnStream.test.ts`

- [ ] **Step 1: Design contract (write as the module TSDoc, then tests)**

Same skeleton as `executeTurnStream` (reserve turnIndex, load priors, assemble messages, persist one atomic batch) with these differences:

- Calls `streamText` directly (via a thin `streamToolChat` wrapper in `src/lib/llm/` mirroring `streamChat`'s rate-limit/headers handling — same pattern, `tools` + `stopWhen: stepCountIs(LLM.maxToolSteps)` instead of `output`; add `maxToolSteps: 4` to `tuning.ts` with a WHY comment).
- **Pacing:** the rate limiter must gate EVERY step, not just the first call. `streamText` exposes `prepareStep` (loop-control doc) — await `awaitCerebrasCallSlot()` inside `prepareStep` so steps 2..N queue through the same gate.
- Streams text deltas to `onTextDelta` from the `fullStream`'s text-delta parts (prose is plain text now — no partial-JSON projection needed; this DELETES the monotonic-prefix workaround for tool turns).
- Forwards tool-call lifecycle to the writer via `onToolEvent` callbacks (input streaming → the client's generative UI).
- Persists per step: `assistant_tool_call` + `tool_result` rows for tool steps, final `assistant_response` row for the closing text (use `result.steps` after completion to build the batch — one pass, same atomic `appendMessages`).
- Post-loop validation: the caller supplies `validateTurn(collector, finalText)` returning `ValidationGateFailure | null` (e.g. "free-text answers were submitted but recordComprehensionSignals was never called"). On failure: persist the exhaust trail + directive rows and re-attempt, same budget as ever (`SCOPING.maxParseRetries`).

Write tests mirroring `executeTurnStream.test.ts`'s structure: happy path row sequence (`user_message`, `assistant_tool_call`, `tool_result`, `assistant_response`), validation-retry sequence, delta forwarding. Mock the `streamToolChat` seam with canned step streams.

- [ ] **Step 2: Implement, run, commit**

Run: `bun run test src/lib/turn/`

```bash
git add src/lib/llm/streamToolChat.ts src/lib/turn/executeToolTurnStream.ts src/lib/turn/*.test.ts src/lib/config/tuning.ts
git commit -m "feat(turn): executeToolTurnStream — tool-loop primitive with per-step pacing + tool-row persistence"
```

---

## Task 6: Rewire the mid-turn pipeline + prompts

**Files:**

- Modify: `src/lib/course/streamWaveTurn.ts` — mid-turn dispatch via `executeToolTurnStream` + `buildWaveMidTurnTools`; `persistWaveMidTurn` consumes `{ userMessage: finalText, comprehensionSignals: collector.signals, questionnaire: collector.questionnaire }` (its input type is exactly the old parsed shape — adapt at the call site, do not change the persistence module).
- Modify: `src/lib/prompts/teaching.ts` — system prompt: delete JSON-emission instructions; add tool-usage guidance (when to grade, when to quiz, prose style now free text). Update its tests' golden strings.
- Modify: `src/lib/prompts/waveTurn.ts` — delete `waveMidTurnSchema` + its superRefine (now on the tool), keep + export `comprehensionSignalSchema`, keep `renderWaveTurnEnvelope` (drop its `responseSchema` param — the inline-schema fallback for non-strict models is obsolete for tool turns; tool definitions ARE the schema channel).
- Modify: `src/lib/types/waveStream.ts` — `WaveTurnUIMessage` gains the tool set generic so tool parts are typed on the client (see `InferUITools` in the chatbot-tool-usage doc; the questionnaire card can render from the `tool-presentQuestionnaire` part's input).

Steps: update integration tests for `streamWaveTurn` (parts now include `tool-*` chunks; DB rows include tool kinds), run `bun run test:integration src/lib/course/`, commit:

```bash
git commit -am "feat(course): mid-turns dispatch through the tool loop; prompts rewritten for tools"
```

---

## Task 7: Client — render tool parts (generative UI)

**Files:**

- Modify: `src/hooks/useWaveState.ts`, `src/components/chat/WaveSession.tsx`, `src/components/chat/Composer.tsx` (read each first)

- [ ] **Step 1:** The streaming assistant message now contains `text` parts AND `tool-presentQuestionnaire` parts. Render the questionnaire card from the tool part's `input` as soon as `state === "input-available"` (chatbot-tool-usage doc lists the part states: `input-streaming` → `input-available` → `output-available`). The card becomes interactive only after `data-turn-result` arrives (it carries the server-assigned `questionnaireId` the Composer needs — the same reconciliation as today, where committed state comes from `getState`).
- [ ] **Step 2:** Manual verification per Phase-2 Task 8 Step 4, plus: a turn with a questionnaire shows the card streaming in before the turn result lands.
- [ ] **Step 3:** `just check` + commit:

```bash
git commit -am "feat(ui): questionnaire cards render from streamed tool parts"
```

---

## Task 8: Live smoke + docs + TODO

- [ ] **Step 1:** Extend the live smoke (`course.live.test.ts` / `wave.live.test.ts` pattern — read them) with one tool-loop teaching turn against the real model; assert collector outcomes, not prose.
      Run: `just smoke`
- [ ] **Step 2:** Update `src/lib/course/CLAUDE.md`, `src/lib/turn/CLAUDE.md`, `src/lib/prompts/CLAUDE.md`, `src/lib/llm/CLAUDE.md` — tool channel is now the structured-emission mechanism for mid-turns; mega-schema remains only on scoping + close turns.
- [ ] **Step 3:** Append to `TODO.md`:

```markdown
- Tool-calling follow-ups (2026-06-10 plan): decompose close-turn (blueprint/summary/grading) into tools using the mid-turn recipe; consider harness→model tools (getDueConcepts, getLearnerHistory) to shrink rendered context; full useChat message-state adoption; remove inline-schema fallback once scoping also moves to tools.
```

- [ ] **Step 4:** `just check`, then `superpowers:finishing-a-development-branch`.

---

## Self-review checklist (for the executing agent)

- [ ] No tool `execute` touches the DB, XP, or SM-2 — staging only (Core Design Principle).
- [ ] Every Cerebras call (including loop steps 2..N) passes through `awaitCerebrasCallSlot`.
- [ ] renderContext byte-stability tests pass UNMODIFIED (only added, never edited).
- [ ] `persistWaveMidTurn` is unchanged — the collector adapts to its existing input shape.
- [ ] The Task 1 gate verdict is recorded in `docs/status/` with raw numbers.
- [ ] Old mega-schema superRefine messages survive verbatim as tool-schema refine messages (they were prompt-engineered; don't paraphrase them).
