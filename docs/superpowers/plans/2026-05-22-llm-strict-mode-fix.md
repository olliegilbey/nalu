# Cerebras Strict-Mode Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make structured LLM calls send their JSON schema to Cerebras as a real `response_format: { type: "json_schema", strict: true }` wire payload, so the model is constrained on the first attempt instead of guessing and recovering on a retry.

**Architecture:** AI SDK v6 `generateText` ignores a top-level `responseFormat` argument — it only sets the model-call `responseFormat` from its `output` parameter. Rather than adopt `output` (which makes `generateText` parse and throw, colliding with `executeTurn`'s own retry loop), `generateChat` wraps the model with a `wrapLanguageModel` middleware whose `transformParams` hook sets `callOptions.responseFormat`. The `@ai-sdk/openai-compatible` provider then emits the strict `json_schema` envelope. `executeTurn` is untouched — it still receives raw `.text` and owns parse / validate / retry.

**Tech Stack:** TypeScript (strict), AI SDK v6 (`ai@6.0.158`, `@ai-sdk/openai-compatible@2.0.41`, `@ai-sdk/provider`), Zod v4, Vitest, bun, just.

**Spec:** `docs/superpowers/specs/2026-05-22-llm-strict-mode-design.md`

**Branch:** `chore/nalu-debug-skill` (do NOT branch off — this PR bundles three changes per the spec).

**Notes for the implementer:**

- This codebase is TypeScript strict, no `any`, functional style. Comments explain WHY (and, during MVP, WHAT). No em-dashes in code/comment string literals — use a colon or hyphen.
- `src/lib/llm/` is the one directory allowed to import the AI SDK packages directly.
- `just check` is the full CI gate but includes `test-int` (integration tests that need Docker, unavailable locally). Per-task verification here uses `just lint`, `just typecheck`, and `just test` (unit, fast). Pre-commit hooks also run secrets/format/lint/typecheck/unit-tests on every commit — never bypass them (`--no-verify` is forbidden).
- Targeted single-file test runs: `bunx vitest run <path>`.

---

## Task 1: Retype `CerebrasResponseFormat.schema` as `JSONSchema7`

`toCerebrasJsonSchema` returns `{ type, name, description?, schema }`. That shape already matches the `json` variant of `LanguageModelV3CallOptions.responseFormat` — except `schema` is typed `Record<string, unknown>` while the SDK field is `JSONSchema7`. Retype it so the object slots into the middleware (Task 2) with no cast. This is a type-only change with no runtime effect; the existing `toCerebrasJsonSchema.test.ts` and `just typecheck` are the verification.

**Files:**

- Modify: `src/lib/llm/toCerebrasJsonSchema.ts`

- [ ] **Step 1: Add the `JSONSchema7` type import**

Read `src/lib/llm/toCerebrasJsonSchema.ts`. Its first line is:

```ts
import { z } from "zod/v4";
```

Add a second import line directly below it (`JSONSchema7` is re-exported by the `ai` package):

```ts
import { z } from "zod/v4";
import type { JSONSchema7 } from "ai";
```

- [ ] **Step 2: Retype the `schema` field on `CerebrasResponseFormat`**

Find this interface field (inside `export interface CerebrasResponseFormat`):

```ts
  readonly schema: Record<string, unknown>;
```

Replace it with:

```ts
  readonly schema: JSONSchema7;
```

- [ ] **Step 3: Retype the return cast**

Find this line in the `return` block of `toCerebrasJsonSchema`:

```ts
    // Cast is safe: `raw` is always an object, so `stripForbidden(raw)` is too.
    schema: stripped as Record<string, unknown>,
```

Replace it with:

```ts
    // Cast is safe: `raw` is always an object, so `stripForbidden(raw)` is too.
    schema: stripped as JSONSchema7,
```

- [ ] **Step 4: Verify typecheck and existing tests pass**

Run: `just typecheck`
Expected: PASS (no errors).

Run: `bunx vitest run src/lib/llm/toCerebrasJsonSchema.test.ts`
Expected: PASS (all existing `toCerebrasJsonSchema` tests still green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm/toCerebrasJsonSchema.ts
git commit -m "refactor(llm): type CerebrasResponseFormat.schema as JSONSchema7"
```

---

## Task 2: Wire `response_format` via a `transformParams` middleware

This is the core fix. TDD: rewrite `generate.test.ts` first (one test fails against the current broken wiring), then implement the `generate.ts` change to make it pass.

The test does NOT mock `generateText`. It uses `MockLanguageModelV3` (the AI SDK's official test double) as the model, lets the real `wrapLanguageModel` + middleware run, and inspects `model.doGenerateCalls` — the call options the model actually received. That is the only way to verify the schema reaches the wire in-process.

**Files:**

- Modify: `src/lib/llm/generate.ts`
- Test (full rewrite): `src/lib/llm/generate.test.ts`

- [ ] **Step 1: Rewrite the test file**

Overwrite `src/lib/llm/generate.test.ts` with this complete content:

```ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod/v4";
import { MockLanguageModelV3 } from "ai/test";
import { generateChat } from "./generate";
import { LLM } from "@/lib/config/tuning";

// generateChat builds a Cerebras response_format only for models that honour
// strict-mode decoding (see modelCapabilities.ts). Pin a honouring model so
// the schema-wiring assertions are exercised. vi.stubEnv auto-restores.
beforeEach(() => {
  vi.stubEnv("LLM_MODEL", "gpt-oss-120b");
});

/**
 * A MockLanguageModelV3 that returns `text` and records every doGenerate
 * call into `.doGenerateCalls`. The assertions below inspect those recorded
 * call options: that is the real payload reaching the provider, after the
 * middleware has transformed the params. The doGenerate result shape follows
 * the AI SDK v6 language-model-v3 spec (see
 * node_modules/ai/docs/03-ai-sdk-core/55-testing.mdx).
 */
function mockModel(text: string): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      content: [{ type: "text", text }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 20, text: 20, reasoning: undefined },
      },
      warnings: [],
    }),
  });
}

describe("generateChat", () => {
  it("returns the model text and usage", async () => {
    const model = mockModel("hello");

    const result = await generateChat([{ role: "user", content: "hi" }], { model });

    expect(result.text).toBe("hello");
    expect(result.usage).toBeDefined();
  });

  it("applies the tuning default temperature to the model call", async () => {
    const model = mockModel("hello");

    await generateChat([{ role: "user", content: "hi" }], { model });

    expect(model.doGenerateCalls[0]?.temperature).toBe(LLM.defaultTemperature);
  });

  it("sends the schema to the model as a strict json response_format", async () => {
    const model = mockModel('{"x":"hi"}');

    await generateChat([{ role: "user", content: "hi" }], {
      model,
      responseSchema: z.object({ x: z.string() }),
      responseSchemaName: "test",
    });

    // The middleware must have set callOptions.responseFormat: this is the
    // value the openai-compatible provider turns into a strict json_schema.
    const responseFormat = model.doGenerateCalls[0]?.responseFormat;
    expect(responseFormat?.type).toBe("json");
    expect(responseFormat).toMatchObject({ type: "json", name: "test" });
    expect(responseFormat).toHaveProperty("schema");
  });

  it("sets no json response_format when no schema is supplied", async () => {
    const model = mockModel("plain text");

    await generateChat([{ role: "user", content: "hi" }], { model });

    // generateText may default responseFormat to {type:"text"} or leave it
    // unset; either way it must not be a json schema payload.
    expect(model.doGenerateCalls[0]?.responseFormat?.type).not.toBe("json");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails on the schema-wiring case**

Run: `bunx vitest run src/lib/llm/generate.test.ts`
Expected: 3 PASS, 1 FAIL. The failure is `"sends the schema to the model as a strict json response_format"` — `responseFormat` is `undefined` because the current `generate.ts` passes `responseFormat` as a top-level `generateText` arg, which AI SDK v6 silently drops before it reaches the model.

If a different test fails (e.g. a `MockLanguageModelV3` `doGenerate` result-shape type error surfaces at runtime), the result object in `mockModel` is missing a field required by `LanguageModelV3GenerateResult` — add it per that type in `@ai-sdk/provider`. The shape above is copied from the official AI SDK v6 testing docs and is expected to be complete.

- [ ] **Step 3: Implement the middleware wiring in `generate.ts`**

Read `src/lib/llm/generate.ts`. Make three edits.

**Edit 3a — imports.** The first line is:

```ts
import { generateText } from "ai";
```

Replace it with these two lines (`wrapLanguageModel` is exported from `ai`; `LanguageModelV3` is not, so it comes from `@ai-sdk/provider`, the foundational SDK package):

```ts
import { generateText, wrapLanguageModel } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
```

**Edit 3b — the comment above the `responseFormat` build.** Find:

```ts
// Build the responseFormat only when a schema is provided AND the model
// will actually honour it. Spreading undefined into generateText would
// send `responseFormat: undefined`, which some SDK versions treat as an error.
```

Replace it with:

```ts
// Build the Cerebras response_format only when a schema is provided AND the
// model honours strict-mode decoding. Weak models get the schema inline in
// the user envelope instead (handled at the prompt-assembly layer).
```

**Edit 3c — the `generateText` call.** Find:

```ts
const result = await generateText({
  model: opts.model ?? getLlmModel(),
  messages: [...messages],
  temperature: opts.temperature ?? LLM.defaultTemperature,
  maxRetries: opts.maxRetries ?? LLM.maxRetries,
  // Conditionally spread so the key is absent (not undefined) when unused.
  ...(responseFormat !== undefined ? { responseFormat } : {}),
});
```

Replace it with:

```ts
// generateText silently drops a top-level `responseFormat` arg; setting it
// via a middleware transformParams hook is the supported way to reach
// callOptions.responseFormat, which the openai-compatible provider then
// emits as a strict json_schema response_format on the wire.
const baseModel = opts.model ?? getLlmModel();
const model =
  responseFormat !== undefined
    ? wrapLanguageModel({
        // baseModel is always a constructed model instance here: getLlmModel
        // builds one, and every caller passes one. The LanguageModel union's
        // string-id member never occurs at runtime, so the V3 cast is safe.
        model: baseModel as LanguageModelV3,
        middleware: {
          specificationVersion: "v3",
          transformParams: async ({ params }) => ({ ...params, responseFormat }),
        },
      })
    : baseModel;

const result = await generateText({
  model,
  messages: [...messages],
  temperature: opts.temperature ?? LLM.defaultTemperature,
  maxRetries: opts.maxRetries ?? LLM.maxRetries,
});
```

- [ ] **Step 4: Run the test to verify all pass**

Run: `bunx vitest run src/lib/llm/generate.test.ts`
Expected: 4 PASS.

- [ ] **Step 5: Verify typecheck**

Run: `just typecheck`
Expected: PASS (no errors).

- [ ] **Step 6: Commit**

```bash
git add src/lib/llm/generate.ts src/lib/llm/generate.test.ts
git commit -m "fix(llm): wire Cerebras strict-mode response_format via middleware"
```

---

## Task 3: Guard `toCerebrasJsonSchema` strict-mode validity over real schemas

Add a regression-guard test. Once the schema reaches the wire, an invalid strict-mode schema (a dangling `$ref`, a missing `additionalProperties`, a non-object root) would make Cerebras reject every structured call with a 400. Zod v4 `z.toJSONSchema` already produces strict-valid output for the current schemas, so this test is expected to PASS on first run; it locks that in and catches a future schema change (e.g. an added `z.record()`) that would break it.

It covers the three directly-importable response schemas. Factory-built schemas (baseline, scoping-close, wave-close) reuse the same Zod construct vocabulary and are not separately enumerated to avoid factory-argument fixtures.

**Files:**

- Modify (test): `src/lib/llm/toCerebrasJsonSchema.test.ts`

- [ ] **Step 1: Add the schema imports**

Read `src/lib/llm/toCerebrasJsonSchema.test.ts`. Its top imports are:

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { toCerebrasJsonSchema, toSchemaJsonString } from "./toCerebrasJsonSchema";
```

Add three schema imports below them:

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { toCerebrasJsonSchema, toSchemaJsonString } from "./toCerebrasJsonSchema";
import { clarifySchema } from "@/lib/prompts/clarify";
import { frameworkSchema } from "@/lib/prompts/framework";
import { waveMidTurnSchema } from "@/lib/prompts/waveTurn";
```

- [ ] **Step 2: Add the guard test inside the existing `describe` block**

In `toCerebrasJsonSchema.test.ts`, find the final test in the `describe("toCerebrasJsonSchema", ...)` block (`it("error message includes schema name and actual depth", ...)`). Immediately after that test's closing `});`, and before the `describe` block's own closing `});`, insert:

```ts
// --- Cerebras strict-mode validity over real production schemas ---
// Guards against a schema construct that z.toJSONSchema would turn into
// something Cerebras strict mode rejects with a 400: a dangling $ref, a
// missing additionalProperties, or a non-object root.

/**
 * Recursively assert a JSON Schema node satisfies Cerebras strict mode:
 * no $ref / $defs / $anchor anywhere, and every object node declares
 * `additionalProperties: false`.
 */
function assertCerebrasStrictValid(node: unknown, path = "$"): void {
  if (Array.isArray(node)) {
    node.forEach((child, i) => assertCerebrasStrictValid(child, `${path}[${i}]`));
    return;
  }
  if (typeof node !== "object" || node === null) return;
  const obj = node as Record<string, unknown>;
  for (const forbidden of ["$ref", "$defs", "$anchor"]) {
    expect(obj, `${path}: "${forbidden}" is forbidden in Cerebras strict mode`).not.toHaveProperty(
      forbidden,
    );
  }
  if (obj["type"] === "object") {
    expect(
      obj["additionalProperties"],
      `${path}: every object node needs additionalProperties:false`,
    ).toBe(false);
  }
  for (const [key, value] of Object.entries(obj)) {
    assertCerebrasStrictValid(value, `${path}.${key}`);
  }
}

it.each<[string, z.ZodType<unknown>]>([
  ["clarify", clarifySchema],
  ["framework", frameworkSchema],
  ["wave_mid_turn", waveMidTurnSchema],
])("produces a Cerebras-strict-valid schema for %s", (name, schema) => {
  const out = toCerebrasJsonSchema(schema, { name });
  // Cerebras strict mode requires an object at the root.
  expect(out.schema).toMatchObject({ type: "object" });
  assertCerebrasStrictValid(out.schema);
});
```

- [ ] **Step 3: Run the test to verify it passes**

Run: `bunx vitest run src/lib/llm/toCerebrasJsonSchema.test.ts`
Expected: PASS (all tests, including the 3 new `it.each` cases).

If a new case FAILS, a real production schema produces Cerebras-invalid output — that must be fixed (likely by inlining a `z.record()`/`.passthrough()` or restructuring) before this fix can ship, because it would 400 live. Do not weaken the assertion.

- [ ] **Step 4: Verify typecheck**

Run: `just typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm/toCerebrasJsonSchema.test.ts
git commit -m "test(llm): guard toCerebrasJsonSchema Cerebras strict-mode validity"
```

---

## Task 4: Update `src/lib/llm/CLAUDE.md`

The directory guide says "Vercel AI SDK v5" (it is v6) and describes `responseFormat` being applied directly (it now goes through a middleware).

**Files:**

- Modify: `src/lib/llm/CLAUDE.md`

- [ ] **Step 1: Correct the SDK version**

Read `src/lib/llm/CLAUDE.md`. Find:

```text
Single LLM integration point for the entire application. Built on the Vercel AI SDK v5 (`ai` + `@ai-sdk/openai-compatible`); nothing outside this directory imports `ai` directly.
```

Replace `v5` with `v6`:

```text
Single LLM integration point for the entire application. Built on the Vercel AI SDK v6 (`ai` + `@ai-sdk/openai-compatible`); nothing outside this directory imports `ai` directly.
```

- [ ] **Step 2: Correct the `generate.ts` bullet**

Find:

```text
- `generate.ts` wraps the SDK: `generateChat` (→ `generateText`) for all LLM calls. When `responseSchema` is supplied, enables Cerebras strict-mode constrained decoding via `responseFormat: { type: "json_schema", strict: true }`; otherwise plain text. Applies `tuning.LLM` defaults; forwards `usage`.
```

Replace it with:

```text
- `generate.ts` wraps the SDK: `generateChat` (→ `generateText`) for all LLM calls. When `responseSchema` is supplied (and the model honours strict-mode), wraps the model with a `transformParams` middleware that sets `callOptions.responseFormat`, so the openai-compatible provider emits a strict `json_schema` `response_format`; otherwise plain text. Applies `tuning.LLM` defaults; forwards `usage`.
```

- [ ] **Step 3: Commit**

```bash
git add src/lib/llm/CLAUDE.md
git commit -m "docs(llm): update llm CLAUDE.md for AI SDK v6 and middleware wiring"
```

---

## Task 5: Finalize — full check, follow-up issue, PR

- [ ] **Step 1: Run the local check suite**

Run: `just lint && just typecheck && just test`
Expected: all PASS (the full unit suite, ~366+ tests).

Note: `just check` additionally runs `format-check`, `test-int`, and `deadcode`. `test-int` needs Docker (unavailable locally) and runs in CI. `format-check` and `deadcode` (knip) also run in CI; pre-commit hooks have already covered format/lint/typecheck/unit-tests on each commit. If `knip` flags anything in CI, fix or narrowly justify it — do not blanket-ignore.

- [ ] **Step 2: Live verification (run by the user — needs Touch ID via `op`)**

These cannot run unattended. Hand them to the user:

- `just smoke` — live Cerebras structured turns; they should now succeed on the first attempt.
- `just probe-model gpt-oss-120b` — the DESC probe (the magic token lives only in a `.describe()`) should return the token now that the schema reaches the model.
- After deploy: `bun .claude/skills/debugging-nalu-llm-pipeline/inspect-db.ts --course <id>` on a fresh course — first structured attempts should no longer fail-and-recover.

- [ ] **Step 3: Create the follow-up GitHub issue (confirm with the user before running)**

This is outward-facing. Confirm with the user, then run:

```bash
gh issue create \
  --title "Tear out vestigial strict-mode gating after llama3.1-8b deprecation" \
  --body "Once \`llama3.1-8b\` is deprecated (2026-05-27), the strict-mode capability gating is vestigial: \`gpt-oss-120b\` (the floor) honours strict mode, and the wire \`response_format\` now works (PR for spec docs/superpowers/specs/2026-05-22-llm-strict-mode-design.md).

Remove:
- \`src/lib/llm/modelCapabilities.ts\` and every \`getModelCapabilities\` / \`honorsStrictMode\` reference (\`generate.ts\`, \`executeTurn.ts\`, and the six lib steps: \`clarify\`, \`generateFramework\`, \`generateBaseline\`, \`submitBaseline\`, \`executeWaveMid\`, \`executeWaveClose\`).
- The inline \`<response_schema>\` prompt path: \`toSchemaJsonString\`, the \`responseSchema\` seed string, and the \`<response_schema>\` prompt scaffolding.

Keep: the retry directive's embedded \`<response_schema>\` block (\`buildRetryDirective\`) as the genuine fallback when a turn fails validation."
```

- [ ] **Step 4: Open the PR (confirm with the user before running)**

This is outward-facing. The branch `chore/nalu-debug-skill` bundles three changes (per the spec's decision to minimise CodeRabbit rate-limit pressure). Confirm with the user, then create the PR with a description covering all three:

1. **Debugging skill + DB inspector** (`debugging-nalu-llm-pipeline`) — committed earlier on this branch.
2. **`conceptName` 500 fix** — `waveMidTurnSchema` superRefine; committed earlier on this branch.
3. **Strict-mode wiring fix** — this plan: `response_format` now reaches Cerebras via a `transformParams` middleware.

---

## Self-Review

**Spec coverage:**

- "schema reaches the provider as `callOptions.responseFormat`" → Task 2 (test: "sends the schema to the model as a strict json response_format").
- "`toCerebrasJsonSchema` output is a valid Cerebras strict-mode schema" → Task 3.
- "`executeTurn` behaviour unchanged" → Task 2 touches only `generate.ts`; `executeTurn.ts` is not modified by any task.
- "`CerebrasResponseFormat.schema` → `JSONSchema7`" → Task 1.
- "`generate.ts`: wrap model, drop dead arg" → Task 2.
- "`CLAUDE.md` v5→v6 + mechanism" → Task 4.
- "follow-up GitHub issue" → Task 5 Step 3.
- "live verification" → Task 5 Step 2.

One file beyond the spec's files-changed list is touched: none — the spec did not anticipate the `LanguageModelV3` cast, but that lives inside `generate.ts` (already in scope). `src/lib/types/llm.ts` is deliberately NOT changed: narrowing `LlmModel` was considered and rejected in favour of a single localised, commented cast, keeping the change surface to the spec's file list.

**Placeholder scan:** No TBD/TODO; every code step shows complete code; every command shows expected output. The one conditional instruction (Task 2 Step 2, missing `doGenerate` field) gives a concrete fallback action, not a placeholder.

**Type consistency:** `CerebrasResponseFormat.schema: JSONSchema7` (Task 1) is consumed by the middleware in Task 2 (`responseFormat` assigned into `callOptions.responseFormat`, whose `json` variant is `{ type: "json"; schema?: JSONSchema7; name?: string; description?: string }`). `MockLanguageModelV3`, `wrapLanguageModel`, `generateChat`, `doGenerateCalls`, `responseFormat` are used consistently across Tasks 2 and 3.
