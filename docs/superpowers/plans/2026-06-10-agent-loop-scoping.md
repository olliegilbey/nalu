# Agent Loop (ToolLoopAgent + Harness Tools) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the teaching model bounded agency _within_ a turn — read-only harness tools it can call to pull learner state on demand (`getDueConcepts`, `getConceptHistory`) — and consolidate Nalu's per-stage LLM configuration into typed `ToolLoopAgent` definitions, while the harness keeps absolute control of Wave budgets, XP, SM-2, and stage sequencing.

**Architecture:** Nalu stays a _harness-controlled workflow_ (the deliberate, correct architecture per `AGENTS.md` — and the pattern the AI SDK's own workflow docs recommend starting from). What changes: each LLM-facing stage (wave mid-turn first; close-turn and scoping later) is defined as a `ToolLoopAgent` instance in a new `src/lib/agents/` directory — model + instructions + tools + `stopWhen` in one typed, reusable unit. The mid-turn agent's tool set grows beyond Phase 3's emission tools with read-only lookup tools, so the static context can stop carrying everything speculatively (today `<due_for_review>` and full history are injected wholesale at Wave boundaries). `executeToolTurnStream` (Phase 3) gains an agent-based entry point; persistence, retry, and pacing are unchanged.

**Tech Stack:** `ai@6.0.158` (`ToolLoopAgent`, `stopWhen`/`stepCountIs`/`hasToolCall`, `prepareStep`, `InferAgentUIMessage`), Zod v4, Drizzle queries (read-only), Vitest.

**Branch:** create `feat/agent-loop-harness-tools` off `main`.

**Prerequisites:**

1. `2026-06-10-tool-calling-turn-actions.md` merged — the tool channel, tool-row persistence, and `executeToolTurnStream` all exist; the Task 1 reliability gate there passed.
2. The cost gate below (Task 1) passes — agent loops multiply paced Cerebras calls.

---

## Why (and why NOT) an agent loop — context for zero-context agents

**The temptation:** "modern agentic platform" reads as "let the model loop freely with tools." For Nalu that would be wrong in three places: XP/SM-2/tier math (deterministic by design — the LLM must never influence scoring beyond the sanctioned qualityScore/startingTier signals), Wave/turn budgets (harness-enforced, the product's pacing spine), and stage sequencing in scoping (deliberately one append-only conversation with fixed stages). Anthropic's "building effective agents" (https://www.anthropic.com/research/building-effective-agents) and the SDK's workflow-patterns doc (`node_modules/ai/docs/03-agents/03-workflows.mdx`, https://ai-sdk.dev/docs/agents/workflows) both say: use the simplest structure that works; add agency only where the task is genuinely open-ended.

**Where agency genuinely pays in Nalu:**

1. **On-demand learner-state lookups during teaching.** Today everything the model might need is pushed into the context at Wave boundaries (static prompt + final-turn injections). That's append-only-cache-friendly but means the model reasons over stale or irrelevant detail and the context carries speculative weight. A `getDueConcepts` / `getConceptHistory` tool lets the model pull precise, current state when (and only when) a teaching decision needs it — e.g. choosing which weak concept to weave into an example. Read-only, harness-mediated, zero scoring authority.
2. **Configuration consolidation.** Model + instructions + tools + loop policy currently spread across `prompts/`, `tuning.ts`, and call sites. `ToolLoopAgent` is the SDK's unit for exactly this, and `InferAgentUIMessage<typeof agent>` gives the client end-to-end typed message parts for free (`node_modules/ai/docs/03-agents/02-building-agents.mdx`).

**Where agency is explicitly rejected (record this in CLAUDE.md when done):** no model-driven stage transitions in scoping; no write-capable tools; no unbounded loops (`isLoopFinished()` is banned here — always `stepCountIs`); no tool that exposes XP, scoring internals, or other users' data.

## Documentation manifest

**Read before writing code.** Local docs are version-matched to `ai@6.0.158`.

| Topic                                                                                                    | Local                                                               | Web                                                             |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------- |
| Agents overview                                                                                          | `node_modules/ai/docs/03-agents/01-overview.mdx`                    | https://ai-sdk.dev/docs/agents/overview                         |
| Building agents (`ToolLoopAgent`, instructions, output, generate/stream, `InferAgentUIMessage`)          | `node_modules/ai/docs/03-agents/02-building-agents.mdx`             | https://ai-sdk.dev/docs/agents/building-agents                  |
| Workflow patterns (why harness-controlled stays)                                                         | `node_modules/ai/docs/03-agents/03-workflows.mdx`                   | https://ai-sdk.dev/docs/agents/workflows                        |
| Loop control (`stopWhen`, `stepCountIs`, `hasToolCall`, `prepareStep` for per-step pacing/context edits) | `node_modules/ai/docs/03-agents/04-loop-control.mdx`                | https://ai-sdk.dev/docs/agents/loop-control                     |
| Call options / agent configuration                                                                       | `node_modules/ai/docs/03-agents/05-configuring-call-options.mdx`    | https://ai-sdk.dev/docs/agents/configuring-call-options         |
| Agent memory patterns                                                                                    | `node_modules/ai/docs/03-agents/06-memory.mdx`                      | https://ai-sdk.dev/docs/agents/memory                           |
| Subagents (future reference only)                                                                        | `node_modules/ai/docs/03-agents/06-subagents.mdx`                   | https://ai-sdk.dev/docs/agents/subagents                        |
| `ToolLoopAgent` reference                                                                                | —                                                                   | https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent   |
| Tool calling                                                                                             | `node_modules/ai/docs/03-ai-sdk-core/15-tools-and-tool-calling.mdx` | https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling      |
| MCP tools (explicit non-goal; for awareness)                                                             | `node_modules/ai/docs/03-ai-sdk-core/16-mcp-tools.mdx`              | https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools                   |
| Cerebras model/limits (pricing the loop)                                                                 | —                                                                   | https://inference-docs.cerebras.ai (models + rate limits pages) |
| Anthropic: building effective agents (pattern source)                                                    | —                                                                   | https://www.anthropic.com/research/building-effective-agents    |
| Doc search API                                                                                           | —                                                                   | `https://ai-sdk.dev/api/search-docs?q=your_query`               |

## Background reading (repo)

- `AGENTS.md` Core Design Principle + Turn principle — the constraints this plan must not violate.
- `src/lib/turn/executeToolTurnStream.ts` + `src/lib/llm/streamToolChat.ts` (Phase 3) — the loop infrastructure being given an agent-shaped front.
- `src/lib/course/waveTurnTools.ts` (Phase 3) — emission tools the new lookup tools join.
- `src/lib/spaced-repetition/` + `src/db/queries/` — where due-concept data actually lives (find the query the Wave-boundary injection uses today; search `due_for_review` and `dueConcepts` across `src/lib/` and `src/db/queries/`).
- `src/lib/prompts/teaching.ts` — the static system prompt that currently front-loads everything; lookup tools let later tasks trim it.
- `src/lib/config/tuning.ts` — loop budgets live here (`LLM.maxToolSteps` from Phase 3).
- `src/lib/llm/cerebrasRateLimit.ts` + memory note: per-user fast lane = 30 calls at ~200ms spacing, then 13s slow lane. THE loop math input.

## Task 1: Cost/latency gate (analysis, written, committed)

- [ ] **Step 1: Measure the current per-turn call profile**

From the Phase-3 smoke logs (or one fresh `just smoke` run), record: median LLM calls per mid-turn (expect 1-3 steps), median tokens/step, median wall-clock/turn.

- [ ] **Step 2: Model the lookup-tool overhead**

Each lookup tool call adds one full loop step (tool call → result → continuation), i.e. +1 paced Cerebras request and one more pass over the (cached) context. Compute, with the measured numbers: worst-case turn = `stepCountIs` budget × (generation + fast-lane spacing); a learner's 10-turn Wave under the 30-call fast lane (does a Wave now exhaust the fast lane mid-wave? at 3 calls/turn, yes by turn 10).

- [ ] **Step 3: Write the verdict into `docs/status/<date>-agent-loop-cost-gate.md`**

GO criteria: worst-case mid-turn wall clock ≤ 1.5× the Phase-3 median AND a full Wave stays inside acceptable fast-lane budget (state the numbers; if the fast lane needs raising — `LLM.fastLaneCallsPerUser` in `tuning.ts` — propose the new value and flag the daily token-cap implication; remember the Cerebras key is shared with the user's STT workload, so headroom is not free). NO-GO: stop, report, leave this plan parked until tier/provider changes the math.

```bash
git add docs/status/
git commit -m "docs(status): agent-loop cost gate verdict"
```

---

## Task 2: `src/lib/agents/` — agent definitions as the configuration unit

**Files:**

- Create: `src/lib/agents/waveMidTurnAgent.ts`
- Create: `src/lib/agents/CLAUDE.md`
- Test: `src/lib/agents/waveMidTurnAgent.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
import { describe, it, expect } from "vitest";
import { buildWaveMidTurnAgent } from "./waveMidTurnAgent";

describe("buildWaveMidTurnAgent", () => {
  it("binds emission + lookup tools and a bounded stop condition", () => {
    const { agent, collector } = buildWaveMidTurnAgent({
      waveId: "w1",
      courseId: "c1",
      model: undefined, // default provider model
    });
    // Tool surface is the contract the prompt + client rely on.
    expect(Object.keys(agent.tools).sort()).toEqual([
      "getConceptHistory",
      "getDueConcepts",
      "presentQuestionnaire",
      "recordComprehensionSignals",
    ]);
    expect(collector).toEqual({ questionnaire: null, signals: [] });
  });
});
```

(Verify `agent.tools` is exposed on `ToolLoopAgent` in the installed version — check `node_modules/ai/src/agent/`; if not public, assert via the builder's own returned tool map instead.)

- [ ] **Step 2: Implement**

```typescript
import { ToolLoopAgent, stepCountIs } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { getLlmModel } from "@/lib/llm/provider";
import { LLM } from "@/lib/config/tuning";
import { renderWaveSystemPrompt } from "@/lib/prompts/teaching"; // adapt to the actual export name — read teaching.ts
import { buildWaveMidTurnTools } from "@/lib/course/waveTurnTools";
import { buildWaveLookupTools } from "./waveLookupTools";

/** Inputs that scope one agent instance to one wave turn. */
export interface WaveMidTurnAgentParams {
  readonly waveId: string;
  readonly courseId: string;
  readonly model?: LanguageModelV3;
}

/**
 * The mid-Wave teaching agent: one typed unit holding model, instructions,
 * tools (emission + read-only lookups), and the loop bound. Built fresh per
 * turn — the collector and lookup tools close over this turn's wave/course
 * ids. The agent NEVER sees XP and owns no stage transitions: it can look
 * up learner state and stage emissions; deterministic code does the rest
 * (Core Design Principle, AGENTS.md).
 *
 * Docs: node_modules/ai/docs/03-agents/02-building-agents.mdx
 *       https://ai-sdk.dev/docs/agents/building-agents
 */
export function buildWaveMidTurnAgent(params: WaveMidTurnAgentParams) {
  const { tools: emissionTools, collector } = buildWaveMidTurnTools();
  const lookupTools = buildWaveLookupTools({ waveId: params.waveId, courseId: params.courseId });
  const agent = new ToolLoopAgent({
    model: params.model ?? getLlmModel(),
    // The static Wave system prompt remains the instructions source —
    // assembled by prompts/, not inline here (prompt-text boundary rule).
    instructions: renderWaveSystemPrompt(/* params per teaching.ts signature */),
    tools: { ...emissionTools, ...lookupTools },
    // Bounded ALWAYS. Lookup + grade + quiz + prose fits in 4; tune via
    // LLM.maxToolSteps, never isLoopFinished() (see plan's rejection list).
    stopWhen: stepCountIs(LLM.maxToolSteps),
  });
  return { agent, collector };
}

/** UIMessage type for client part rendering — see building-agents doc §Type Safety. */
export type WaveMidTurnUIMessage = import("ai").InferAgentUIMessage<
  ReturnType<typeof buildWaveMidTurnAgent>["agent"]
>;
```

The `instructions` wiring requires reading `src/lib/prompts/teaching.ts` for the real render signature — the agent builder passes through whatever seed/wave params that function needs; extend `WaveMidTurnAgentParams` accordingly. Prompt text itself stays in `prompts/` (boundary rule: no prompt text outside that directory).

- [ ] **Step 3: Create `src/lib/agents/CLAUDE.md`**

```markdown
# src/lib/agents

ToolLoopAgent definitions — one file per LLM-facing stage. An agent =
model + instructions (from src/lib/prompts/) + tools + stopWhen, built
fresh per turn with turn-scoped closures (collector, lookup ids).

Rules:

- Agents are configuration, not control flow. Stage sequencing, Wave
  budgets, XP, SM-2 live in src/lib/course/ + src/lib/{scoring,…}.
- Tools: emission tools stage into a collector (no DB writes); lookup
  tools are read-only and scoped to the current user's course. Never
  expose XP, scoring internals, or cross-user data.
- stopWhen is always stepCountIs(bounded). isLoopFinished() is banned.
- Prompt text lives in src/lib/prompts/ — agents import renderers.
```

- [ ] **Step 4: Run test, commit**

Run: `bun run test src/lib/agents/`

```bash
git add src/lib/agents/
git commit -m "feat(agents): waveMidTurnAgent — typed ToolLoopAgent unit for teaching turns"
```

---

## Task 3: Read-only lookup tools

**Files:**

- Create: `src/lib/agents/waveLookupTools.ts`
- Test: `src/lib/agents/waveLookupTools.test.ts`

- [ ] **Step 1: Find the data sources**

Search `src/db/queries/` for the queries behind the Wave-boundary `<due_for_review>` injection and concept state (`grep -rn "due" src/db/queries/ src/lib/spaced-repetition/`). The lookup tools wrap EXISTING queries — if a needed query doesn't exist, add it to `src/db/queries/` (DB-access boundary rule), never inline SQL in the tool.

- [ ] **Step 2: Write failing tests**

Test with mocked query modules (`vi.mock("@/db/queries/...")`): each tool returns a compact, model-readable projection; output is capped (e.g. ≤ 10 concepts) so a lookup can't blow the context; tool output contains NO ids the model shouldn't quote (use names, not UUIDs, where the model-facing vocabulary has names).

- [ ] **Step 3: Implement**

```typescript
import { tool } from "ai";
import { z } from "zod/v4";
// import the real query fns found in Step 1, e.g.:
// import { getDueConceptsForCourse, getConceptAssessmentHistory } from "@/db/queries/concepts";

/** Build read-only lookup tools scoped to one wave turn. */
export function buildWaveLookupTools(scope: {
  readonly waveId: string;
  readonly courseId: string;
}) {
  return {
    getDueConcepts: tool({
      description:
        "List concepts currently due for spaced-repetition review in this course (max 10, soonest first). Use when deciding what to weave into teaching or quiz next.",
      inputSchema: z.object({}),
      execute: async () => {
        const due = await getDueConceptsForCourse(scope.courseId, { limit: 10 });
        return {
          dueConcepts: due.map((c) => ({
            name: c.name,
            tier: c.tier,
            lastQuality: c.lastQualityScore,
          })),
        };
      },
    }),
    getConceptHistory: tool({
      description:
        "Fetch this learner's assessment history for one named concept (last 5 results). Use before re-teaching something they've struggled with.",
      inputSchema: z.object({ conceptName: z.string().min(1) }),
      execute: async ({ conceptName }) => {
        const rows = await getConceptAssessmentHistory(scope.courseId, conceptName, { limit: 5 });
        return {
          conceptName,
          attempts: rows.map((r) => ({
            verdict: r.verdict,
            qualityScore: r.qualityScore,
            agoTurns: r.agoTurns,
          })),
        };
      },
    }),
  } as const;
}
```

Adapt names/fields to the real queries found in Step 1 — the shape above is the contract pattern (compact, capped, name-keyed, read-only), not gospel field names.

- [ ] **Step 4: Persistence note (verify, don't assume)**

Lookup tool calls/results persist as the Phase-3 `assistant_tool_call`/`tool_result` rows automatically (they ride the same loop). Confirm the integration test in Task 4 shows them in `context_messages` — the replayed Context must include them or the model loses its own lookup memory mid-Wave.

- [ ] **Step 5: Run, commit**

```bash
git add src/lib/agents/waveLookupTools.ts src/lib/agents/waveLookupTools.test.ts
git commit -m "feat(agents): read-only due-concepts + concept-history lookup tools"
```

---

## Task 4: Dispatch mid-turns through the agent

**Files:**

- Modify: `src/lib/turn/executeToolTurnStream.ts` — accept `{ agent }` (a `ToolLoopAgent`) instead of raw `tools`+`model` params; internally call `agent.stream({ messages })` (same result surface as `streamText` — verify against `node_modules/ai/src/agent/`); keep `prepareStep` pacing, persistence, retry identical.
- Modify: `src/lib/course/streamWaveTurn.ts` — build the agent via `buildWaveMidTurnAgent`, pass it down; delete the now-internal tool wiring.
- Modify: `src/lib/types/waveStream.ts` — re-export `WaveMidTurnUIMessage` for the client.

Steps:

- [ ] **Step 1:** Update `executeToolTurnStream` unit tests: the mock seam moves from `streamToolChat` to a stub agent exposing `.stream()`; assert identical persisted row sequences as before (the contract tests carry over verbatim).
- [ ] **Step 2:** Implement; run `bun run test src/lib/turn/ src/lib/course/`.
- [ ] **Step 3:** Integration: extend `streamWaveTurn.integration.test.ts` with a turn whose scripted agent stream includes a `getDueConcepts` call — assert `assistant_tool_call` + `tool_result` rows land and the next turn's rendered context includes them.
      Run: `bun run test:integration src/lib/course/`
- [ ] **Step 4:** System prompt: add lookup-tool guidance to `src/lib/prompts/teaching.ts` ("you can call getDueConcepts/getConceptHistory; do so before choosing review material; never invent history"). Update prompt tests.
- [ ] **Step 5:** Commit:

```bash
git commit -am "feat(course): mid-turns dispatch via waveMidTurnAgent with lookup tools"
```

---

## Task 5: Trim the static injection (the payoff)

Only after Task 4 is verified live: the Wave-boundary `<due_for_review>` static injection can shrink to a one-line hint ("due concepts exist; call getDueConcepts for the list") instead of the full list — the model now pulls on demand.

- [ ] **Step 1:** Find the injection site (`grep -rn "due_for_review" src/`). Change the rendered block to the hint form behind a tuning flag `WAVE.dueReviewInjection: "full" | "hint"` (default `"full"` until the live comparison below).
- [ ] **Step 2:** Live A/B smoke: run `just smoke` once per flag value; compare (a) whether the model actually calls `getDueConcepts` under `"hint"`, (b) review-concept coverage in the emitted questionnaires. Record both in `docs/status/`.
- [ ] **Step 3:** Flip the default to `"hint"` ONLY if coverage holds; otherwise keep `"full"` and note the finding (the lookup tools still pay for `getConceptHistory` regardless).
- [ ] **Step 4:** Commit + update `src/lib/prompts/CLAUDE.md` and `AGENTS.md`'s Spaced-repetition flow note if the default flipped.

```bash
git commit -am "feat(prompts): due-review injection hint mode behind tuning flag"
```

---

## Task 6: Docs, TODO, handoff

- [ ] **Step 1:** Update `src/lib/agents/CLAUDE.md` (created in Task 2) with anything learned; add the "where agency is rejected" list from this plan's preamble verbatim.
- [ ] **Step 2:** Append to `TODO.md`:

```markdown
- Agent-loop follow-ups (2026-06-10 plan): close-turn agent (blueprint/summary tools); scoping clarify as adaptive agent (model decides clarification depth via askLearner/completeScoping emissions — design only, gated on product call); evaluate createAgentUIStreamResponse to replace the hand-rolled writer once full useChat message-state adoption lands; MCP tools explicitly out of scope until an external integration exists.
```

- [ ] **Step 3:** `just check` + `just smoke`, then `superpowers:finishing-a-development-branch`.

---

## Self-review checklist (for the executing agent)

- [ ] No write-capable tool exists; every lookup is scoped by `courseId` from the server-resolved user context, never from model input alone (a tool taking a raw courseId from the model would be cross-user read primitive — the closure scoping in Task 3 prevents this; keep it).
- [ ] `stopWhen` is `stepCountIs` everywhere; `isLoopFinished` appears nowhere.
- [ ] Per-step pacing (`prepareStep` → `awaitCerebrasCallSlot`) survived the agent refactor.
- [ ] Tool outputs are capped projections — no unbounded arrays into context.
- [ ] Cost-gate + A/B numbers are in `docs/status/` with dates.
- [ ] XP/SM-2/progression modules (`src/lib/{scoring,spaced-repetition,progression}/`) have zero diff in this branch.
