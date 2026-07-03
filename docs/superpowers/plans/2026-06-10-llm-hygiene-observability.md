# LLM Hygiene + Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the vestigial XML model→harness protocol layers, fix stale LLM-layer documentation, and add 2026-baseline observability (OpenTelemetry traces on every LLM call, AI SDK DevTools for local debugging) so the platform's LLM behavior is inspectable instead of inferred from stderr smoke banners.

**Architecture:** Three independent workstreams in one branch: (1) dead-code removal guided by knip + grep evidence, with `ValidationGateFailure` rehomed to `src/lib/turn/` where its only consumers live; (2) `experimental_telemetry` threaded through `generateChat`/`streamChat` with Next.js OTel registration, env-gated; (3) `devToolsMiddleware` wrapping the provider model in development only. Plus a written provider-strategy note (AI Gateway / `@ai-sdk/cerebras` evaluation) so the next provider decision starts from facts.

**Tech Stack:** `ai@6.0.158`, `@ai-sdk/devtools`, `@vercel/otel`, knip, Vitest.

**Branch:** create `chore/llm-hygiene-observability` off `main`.

**Prerequisites:** None hard — this plan is safe immediately after `2026-06-10-ai-sdk-output-object.md`. If the streaming/tool plans have landed, the grep evidence in Task 1 will simply show more callers; the method is the same. One exception: Task 5 (remove tRPC `wave.submitTurn`) requires `2026-06-10-streaming-wave-turns.md` to have been in production for one stable release — skip it otherwise and leave the TODO.

---

## Documentation manifest

| Topic                                                                                   | Local (version-matched)                                                      | Web                                                                                          |
| --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| AI SDK telemetry (`experimental_telemetry`, functionId, metadata, recordInputs/Outputs) | `node_modules/ai/docs/03-ai-sdk-core/60-telemetry.mdx`                       | https://ai-sdk.dev/docs/ai-sdk-core/telemetry                                                |
| AI SDK DevTools (middleware + viewer, dev-only)                                         | `node_modules/ai/docs/03-ai-sdk-core/65-devtools.mdx`                        | https://ai-sdk.dev/docs/ai-sdk-core/devtools                                                 |
| Middleware (`wrapLanguageModel` — DevTools attaches here)                               | `node_modules/ai/docs/03-ai-sdk-core/40-middleware.mdx`                      | https://ai-sdk.dev/docs/ai-sdk-core/middleware                                               |
| Next.js OpenTelemetry setup (`instrumentation.ts`)                                      | `node_modules/next/dist/docs/` (search "open-telemetry" / "instrumentation") | https://nextjs.org/docs/app/building-your-application/optimizing/open-telemetry              |
| Observability integration providers (if exporting beyond console)                       | —                                                                            | https://ai-sdk.dev/providers/observability                                                   |
| Provider management / custom providers (gateway evaluation input)                       | `node_modules/ai/docs/03-ai-sdk-core/45-provider-management.mdx`             | https://ai-sdk.dev/docs/ai-sdk-core/provider-management                                      |
| Vercel AI Gateway (failover/cost-tracking candidate)                                    | —                                                                            | https://vercel.com/docs/ai-gateway and https://ai-sdk.dev/providers/ai-sdk-providers/gateway |
| `@ai-sdk/cerebras` dedicated provider (vs current openai-compatible)                    | —                                                                            | https://ai-sdk.dev/providers/ai-sdk-providers/cerebras                                       |
| Cerebras platform docs (limits/models, for the strategy note)                           | —                                                                            | https://inference-docs.cerebras.ai                                                           |
| Doc search API                                                                          | —                                                                            | `https://ai-sdk.dev/api/search-docs?q=your_query`                                            |

## Background reading (repo)

- `src/lib/llm/CLAUDE.md` — currently describes the XML `parseAssistantResponse` gate as the live contract; it is not (the JSON `Output.object` path is). Fixing this file is part of Task 4.
- `src/lib/llm/parseAssistantResponse.ts` — production code imports ONLY its `ValidationGateFailure` class (verify with the Task 1 greps); the parser itself has no production caller.
- `src/lib/llm/tagVocabulary.ts` — model→harness half (`TEACHING_TURN_TAGS`, `comprehensionSignalSchema`(XML variant), `assessmentSchema`, `parseAssistantResponse` consumers) is superseded; harness→model half (`HARNESS_INJECTION_TAGS`) may still be referenced by `renderContext`/prompts — evidence decides.
- `src/lib/llm/extractTag.ts` — one production caller: `getLastAssessmentCard` in `src/db/queries/contextMessages.ts`, which itself appears caller-less. Evidence decides.
- `knip.json` + the repo's knip conventions (memory: fix or narrowly justify, never blanket-ignore).
- `AGENTS.md` workflow rule 4: never bypass hooks; deletions must keep the unit suite green at every commit.

## Task 1: Evidence pass — what is actually dead

No deletions in this task. Output: a table in the PR description (and pasted into Task 2's steps as you go).

- [ ] **Step 1: Run the greps and record results**

```bash
grep -rn "parseAssistantResponse(" src/ --include="*.ts" | grep -v "\.test\.\|parseAssistantResponse.ts"
grep -rn "ValidationGateFailure" src/ --include="*.ts" | grep -v "\.test\." | cut -d: -f1 | sort -u
grep -rn "TEACHING_TURN_TAGS\|HARNESS_INJECTION_TAGS" src/ --include="*.ts" | grep -v "\.test\."
grep -rn "from \"@/lib/llm/tagVocabulary\"\|from \"./tagVocabulary\"" src/ --include="*.ts" | grep -v "\.test\."
grep -rn "extractTag" src/ --include="*.ts" | grep -v "\.test\.\|extractTag.ts"
grep -rn "getLastAssessmentCard" src/ --include="*.ts" | grep -v "\.test\.\|contextMessages.ts"
```

- [ ] **Step 2: Run knip**

Run: `bunx knip` (or the `just` recipe if one exists — check `justfile`).
Record everything it flags under `src/lib/llm/` and `src/db/queries/`.

- [ ] **Step 3: Decide per symbol, using this rubric**

- Zero production callers + knip-flagged → delete (with its tests).
- Callers exist only in other dead code → delete the chain together, leaf-first.
- Callers exist in live code → NOT dead; leave it and correct any stale doc claiming otherwise.
- Anything ambiguous (e.g. runtime usage knip can't see) → keep, add the narrow per-file knip justification with a comment (never blanket-ignore; memory: knip usage).

Expected outcome as of 2026-06-10 (re-verify, don't trust): `parseAssistantResponse` (fn + `ParsedAssistantResponse` + `ParseOptions`) dead; `ValidationGateFailure` alive (consumers all in `src/lib/turn/`); `TEACHING_TURN_TAGS` + the XML-side schemas dead UNLESS `prompts/teaching.ts` or seeded fixtures still reference them; `HARNESS_INJECTION_TAGS` likely alive (envelope rendering); `extractTag`+`getLastAssessmentCard` dead as a pair — BUT check whether any seeded/legacy `context_messages` rows still carry `<assessment>` tags that a runtime path reads.

---

## Task 2: Deletions + `ValidationGateFailure` rehoming

**Files (adjust to Task 1 evidence):**

- Create: `src/lib/turn/validationGateFailure.ts`
- Modify: every importer of `ValidationGateFailure` (Task 1 grep output; expect `src/lib/turn/executeTurn.ts`, `executeTurnStream.ts`, `retryDirective.ts`, `formatTurn.ts`, `diagnoseFailure.ts`)
- Delete: `src/lib/llm/parseAssistantResponse.ts` + `.test.ts`
- Delete/trim: `src/lib/llm/tagVocabulary.ts` (+ test) per evidence
- Delete: `src/lib/llm/extractTag.ts` + `.test.ts` and `getLastAssessmentCard` per evidence

- [ ] **Step 1: Rehome the error class**

Create `src/lib/turn/validationGateFailure.ts` by MOVING the `ValidationGateFailure` class (and any reason-type union it uses) out of `parseAssistantResponse.ts`, verbatim including TSDoc. It belongs in `turn/` because every consumer is the turn machinery; it living in the (otherwise dead) parser file is a historical accident.

- [ ] **Step 2: Update imports**

Mechanical: `@/lib/llm/parseAssistantResponse` → `@/lib/turn/validationGateFailure` at every site from the grep. Run `just typecheck` — zero errors.

- [ ] **Step 3: Delete the dead chain, leaf-first, one commit per coherent unit**

For each deletion: remove file(s) + tests, run `bun run test`, commit. Suggested sequence (evidence permitting):

```bash
git rm src/lib/llm/parseAssistantResponse.ts src/lib/llm/parseAssistantResponse.test.ts
bun run test && git commit -m "chore(llm): delete dead XML parseAssistantResponse (Output.object path superseded it)"

git rm src/lib/llm/extractTag.ts src/lib/llm/extractTag.test.ts
# + remove getLastAssessmentCard + its AssessmentCard import from src/db/queries/contextMessages.ts
bun run test && git commit -m "chore(llm): delete dead extractTag + getLastAssessmentCard XML reader"

# tagVocabulary: delete the model→harness half (or whole file if HARNESS_INJECTION_TAGS proved dead too);
# any live schema it exported (e.g. blueprintSchema re-export) gets imported from its real home instead.
bun run test && git commit -m "chore(llm): retire XML tag vocabulary superseded by JSON/tool emissions"
```

- [ ] **Step 4: Full gate**

Run: `just check` — knip must report fewer issues than the Task 1 baseline, never new ones.

---

## Task 3: OpenTelemetry on every LLM call

**Files:**

- Create: `instrumentation.ts` (repo root or `src/` — check Next.js 16.2 docs for the expected location in this version)
- Modify: `src/lib/llm/generate.ts`, `src/lib/llm/streamChat.ts` (+ `streamToolChat.ts` if Phase 3 landed)
- Modify: `src/lib/config/tuning.ts` or env schema (`src/lib/config/`) — add `LLM_TELEMETRY` flag
- Test: extend `generate.test.ts`

- [ ] **Step 1: Register OTel for Next.js**

Run: `bun add @vercel/otel`
Create `instrumentation.ts` per the Next.js OTel guide (https://nextjs.org/docs/app/building-your-application/optimizing/open-telemetry — verify against `node_modules/next/dist/docs/` for 16.2 specifics):

```typescript
import { registerOTel } from "@vercel/otel";

/** Next.js instrumentation hook — registers the OTel SDK once per server boot. */
export function register() {
  registerOTel({ serviceName: "nalu" });
}
```

Without an exporter configured this is near-zero overhead; spans go nowhere until an OTLP endpoint is set (env-driven, deployment concern — link https://ai-sdk.dev/providers/observability in the code comment for exporter options).

- [ ] **Step 2: Add the env flag**

Add `LLM_TELEMETRY` (boolean, default false) to the env schema in `src/lib/config/` following the existing pattern there (read the file; mirror how `LLM_BASE_URL` etc. are declared).

- [ ] **Step 3: Thread `experimental_telemetry` through the LLM seam**

In `generateChat` (and the stream wrappers), add to every `generateText`/`streamText` call:

```typescript
    experimental_telemetry: {
      isEnabled: getEnv().LLM_TELEMETRY,
      functionId: opts.telemetryFunctionId ?? "generateChat",
      // Inputs/outputs contain learner content — keep them out of traces
      // by default; spans still carry timing, tokens, model, retries.
      recordInputs: false,
      recordOutputs: false,
    },
```

Add `telemetryFunctionId?: string` to the options interfaces; have `executeTurn`/`executeTurnStream` pass their `label` (e.g. `"wave-mid"`, `"clarify"`) so traces are stage-named. Unit-test via `MockLanguageModelV3`: assert the call options carry `experimental_telemetry` with the label when the flag is on (telemetry options are visible on the doGenerate call in the mock — if not, assert at the wrapper-input level instead; check `node_modules/ai/docs/03-ai-sdk-core/60-telemetry.mdx` for what's recordable).

- [ ] **Step 4: `just check`, commit**

```bash
git add instrumentation.ts src/lib/llm/ src/lib/config/ package.json bun.lock
git commit -m "feat(llm): OTel spans on every LLM call, env-gated, stage-labelled, content-redacted"
```

---

## Task 4: DevTools in development + CLAUDE.md truth pass

**Files:**

- Modify: `src/lib/llm/provider.ts`
- Modify: `src/lib/llm/CLAUDE.md`, `src/lib/prompts/CLAUDE.md`
- Modify: `package.json` (dev dependency)

- [ ] **Step 1: Install and wire DevTools (dev-only)**

Run: `bun add -d @ai-sdk/devtools`

In `src/lib/llm/provider.ts`:

```typescript
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { wrapLanguageModel } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import { getEnv } from "@/lib/config";

export function getLlmModel(): LanguageModelV3 {
  const env = getEnv();
  const provider = createOpenAICompatible({
    name: "nalu-llm",
    baseURL: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
    supportsStructuredOutputs: true,
  });
  const model = provider.chatModel(env.LLM_MODEL);
  // DevTools capture is development-only (the middleware writes run logs
  // for the local viewer; never ship it). Guarded by env so `just dev`
  // opts in explicitly rather than every dev server paying the overhead.
  // Docs: node_modules/ai/docs/03-ai-sdk-core/65-devtools.mdx
  //       https://ai-sdk.dev/docs/ai-sdk-core/devtools
  if (process.env.NODE_ENV === "development" && process.env.LLM_DEVTOOLS === "1") {
    // Lazy require keeps @ai-sdk/devtools out of production bundles.
    const { devToolsMiddleware } = require("@ai-sdk/devtools") as typeof import("@ai-sdk/devtools");
    return wrapLanguageModel({ model, middleware: devToolsMiddleware() });
  }
  return model;
}
```

(If the repo's lint forbids `require`, use a top-level static import — `@ai-sdk/devtools` is a devDependency and the `NODE_ENV` guard keeps it inert; verify `just build` succeeds either way. Check the DevTools doc for the viewer launch command — typically `npx @ai-sdk/devtools` or similar — and add a `just llm-devtools` recipe wrapping it.)

- [ ] **Step 2: Verify locally**

Run: `LLM_DEVTOOLS=1 just dev`, perform one scoping turn against the live model OR run `just smoke`; launch the viewer; confirm the call appears with request/response detail.

- [ ] **Step 3: CLAUDE.md truth pass**

`src/lib/llm/CLAUDE.md`: delete the `extractTag`/`parseAssistantResponse` bullets and the entire "Render & parse contract" section's references to deleted modules (keep the `renderContext` invariants — those are alive); add bullets for telemetry (env flag, redaction stance) and DevTools (`LLM_DEVTOOLS=1`). `src/lib/prompts/CLAUDE.md`: remove any reference to `OUTPUT_FORMATS_BLOCK`/tag vocabulary if Task 2 deleted them. Honor the terse-CLAUDE.md memory: draft, then cut 40-60%.

- [ ] **Step 4: `just check`, commit**

```bash
git add src/lib/llm/provider.ts src/lib/llm/CLAUDE.md src/lib/prompts/CLAUDE.md package.json bun.lock justfile
git commit -m "feat(llm): dev-gated AI SDK DevTools; CLAUDE.md truth pass for retired XML layers"
```

---

## Task 5: Remove tRPC `wave.submitTurn` (CONDITIONAL — see prerequisites)

Only if the streaming route has been the sole client transport for ≥ 1 stable release.

- [ ] **Step 1:** `grep -rn "submitTurn" src/ --include="*.ts*" | grep -v test` — confirm zero client callers.
- [ ] **Step 2:** Delete the procedure from `src/server/routers/wave.ts`; move any integration coverage worth keeping onto `streamWaveTurn`'s suite; keep `submitWaveTurn` the lib function ONLY if `streamWaveTurn` still composes it — otherwise it goes too (knip decides).
- [ ] **Step 3:** `just check` + `bun run test:integration src/`, commit:

```bash
git commit -am "chore(server): remove superseded blocking wave.submitTurn transport"
```

---

## Task 6: Provider strategy note (decision input, no code)

- [ ] **Step 1: Write `docs/status/2026-06-XX-provider-strategy.md`** answering, with sources fetched fresh:

1. **`@ai-sdk/cerebras` vs `@ai-sdk/openai-compatible`:** what the dedicated provider adds (https://ai-sdk.dev/providers/ai-sdk-providers/cerebras — check strict-mode/json-schema handling, tool-calling support, default headers) vs our generic adapter + hand-rolled `toCerebrasJsonSchema`. Recommend switch/stay with reasons.
2. **Vercel AI Gateway:** what failover + spend tracking would replace in `cerebrasRateLimit.ts` (https://vercel.com/docs/ai-gateway, https://ai-sdk.dev/providers/ai-sdk-providers/gateway); whether per-user fast-lane semantics survive a gateway hop; cost implications vs direct Cerebras (memory: API keys are tier-bound and the key is shared with STT — a gateway would decouple that).
3. **Recommendation + trigger conditions** (e.g. "switch to gateway when a second provider or a paid SLA is needed; until then keep direct + limiter").

- [ ] **Step 2: Commit**

```bash
git add docs/status/
git commit -m "docs(status): provider strategy note (cerebras provider vs gateway)"
```

---

## Self-review checklist (for the executing agent)

- [ ] Every deletion is backed by a grep + knip line recorded in the PR description — no vibes-based deletion.
- [ ] `ValidationGateFailure` import path updated everywhere; `git grep "llm/parseAssistantResponse"` returns nothing.
- [ ] Telemetry defaults: flag off, inputs/outputs NOT recorded (learner content stays out of traces until a deliberate decision).
- [ ] DevTools cannot activate in production (`NODE_ENV` + explicit env flag double gate).
- [ ] `renderContext` and its tests untouched (alive and load-bearing).
- [ ] CLAUDE.md files describe only code that exists after this branch.
