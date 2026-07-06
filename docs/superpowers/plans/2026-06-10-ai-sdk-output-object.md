# AI SDK `Output.object` Adoption Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Nalu's hand-rolled structured-output pipeline (transformParams middleware + manual `JSON.parse` + manual `safeParse`) with the AI SDK's first-class `output: Output.object()` mechanism, with zero behavior change to retry semantics, persisted rows, or wire bytes.

**Architecture:** `generateChat` stops wrapping the model in a `wrapLanguageModel` middleware and instead passes `output: Output.object({ schema })` to `generateText`. The schema handed to `Output.object` is the SDK's `jsonSchema()` wrapper around our existing Cerebras-cleaned wire schema, with Zod `safeParse` plugged in as the validator — so the wire bytes stay byte-identical to today AND the SDK runs our full Zod validation (including `.refine`/`.superRefine`) before returning. Validation failures surface as the SDK's `NoObjectGeneratedError`; `executeTurn` converts them to the existing `ValidationGateFailure` so the persisted retry-directive machinery is untouched.

**Tech Stack:** `ai@6.0.158` (`generateText`, `Output.object`, `jsonSchema`, `NoObjectGeneratedError`, `MockLanguageModelV3`), Zod v4, Vitest.

**Branch:** create `refactor/ai-sdk-output-object` off `main`.

---

## Documentation manifest

This is Phase 1 of the AI SDK modernization sequence (see the assessment summary at the top of `2026-06-10-streaming-wave-turns.md` for the full sequence). **Read these before writing code.** Prefer the local copies in `node_modules/ai/docs/` — they are version-matched to the installed SDK (`ai@6.0.158`). The web URLs are the same docs for the latest version; use them if the local file is missing or you need a linked page.

| Topic                                                    | Local (version-matched)                                                                                               | Web                                                                             |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Structured output (`Output.object`, error handling)      | `node_modules/ai/docs/03-ai-sdk-core/10-generating-structured-data.mdx`                                               | https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data                  |
| `generateText` reference (incl. `output` param)          | —                                                                                                                     | https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text                     |
| `Output` reference                                       | —                                                                                                                     | https://ai-sdk.dev/docs/reference/ai-sdk-core/output                            |
| `jsonSchema()` helper (custom validate fn)               | `node_modules/@ai-sdk/provider-utils/src/schema.ts` (source of truth)                                                 | https://ai-sdk.dev/docs/reference/ai-sdk-core/json-schema                       |
| Error handling / `NoObjectGeneratedError`                | `node_modules/ai/docs/03-ai-sdk-core/50-error-handling.mdx`, `node_modules/ai/src/error/no-object-generated-error.ts` | https://ai-sdk.dev/docs/ai-sdk-core/error-handling                              |
| Testing with `MockLanguageModelV3`                       | `node_modules/ai/docs/03-ai-sdk-core/55-testing.mdx`                                                                  | https://ai-sdk.dev/docs/ai-sdk-core/testing                                     |
| Middleware (what we're deleting)                         | `node_modules/ai/docs/03-ai-sdk-core/40-middleware.mdx`                                                               | https://ai-sdk.dev/docs/ai-sdk-core/middleware                                  |
| OpenAI-compatible provider (`supportsStructuredOutputs`) | `node_modules/@ai-sdk/openai-compatible/` source                                                                      | https://ai-sdk.dev/providers/openai-compatible-providers                        |
| Doc search API (any other question)                      | —                                                                                                                     | `https://ai-sdk.dev/api/search-docs?q=your_query` (returns `.md` URLs to fetch) |

**Key SDK facts verified against `ai@6.0.158` source (re-verify if the version has changed):**

- `Output.object({ schema, name })` resolves `responseFormat: { type: 'json', schema: <jsonSchema>, name }` and hands it to the model call (`node_modules/ai/src/generate-text/output.ts:114`). This is _exactly_ what our `transformParams` middleware does today — the comment in `generate.ts` saying "generateText silently drops a top-level responseFormat arg" is true, but `output` is the supported way in.
- On completion, `Output.object` JSON-parses the text, then runs the schema's `validate` function. Either failure throws `NoObjectGeneratedError` carrying `{ text, usage, response, finishReason, cause }` (`node_modules/ai/src/generate-text/output.ts:122-157`).
- `jsonSchema(wireSchema, { validate })` lets us supply arbitrary JSON Schema bytes for the wire while plugging Zod in as the validator (`node_modules/@ai-sdk/provider-utils/src/schema.ts:95`). `validate` returns `{ success: true, value } | { success: false, error }`.
- `NoObjectGeneratedError.isInstance(err)` is the supported type guard; it's exported from `ai`.
- `generateText`'s result with `output` set exposes `result.output` (the validated, typed object) alongside `result.text` (the raw string — which we still persist verbatim).

## Background reading (repo)

- `src/lib/llm/CLAUDE.md` and `src/lib/turn/CLAUDE.md` — directory contracts (both get updated in this plan).
- `src/lib/llm/generate.ts` — the function being rewritten. Note the middleware block (lines ~111-122) and the capability gate (lines ~95-100).
- `src/lib/llm/toCerebrasJsonSchema.ts` — wire-schema builder being extended. The Cerebras strict-mode budgets (5000 chars, depth ≤ 10) and `cleanForCerebras` transforms stay.
- `src/lib/turn/executeTurn.ts` — the retry loop being re-seated. `parseAndValidate` (lines 291-307) is deleted; everything else stays.
- `src/lib/llm/modelCapabilities.ts` — the `honorsStrictMode` gate. After this plan it is no longer consulted in `generate.ts` (see "Decisions" below) but is STILL consulted at the prompt-assembly layer (`executeWaveMid.ts:80`, `generateBaseline.ts`, etc.) for inline-schema fallback. Do not delete it.
- `src/lib/llm/generate.test.ts` and `src/lib/turn/executeTurn.test.ts` — the test files being updated; read their mock patterns first.
- Memory/context: Cerebras `response_format` is **soft guidance** — the API accepts it but does not hard-constrain decoding; Zod validation + the `executeTurn` retry loop is the real safety net. This is why behavior-preservation of the retry machinery is the non-negotiable invariant of this plan.

## Decisions locked in by this plan

1. **The capability gate moves out of `generate.ts`.** Today weak models (those with `honorsStrictMode: false`) get _no_ `response_format` and rely on an inline `<response_schema>` block in the envelope. After this plan, `response_format` is sent whenever a schema is supplied, for every model. Rationale: (a) Cerebras treats it as soft guidance, so sending it to a model that ignores it is harmless; (b) the model floor is now `gpt-oss-120b` (llama3.1-8b sunset 2026-05-27), which honours it; (c) one code path instead of two. The inline-envelope fallback at the prompt-assembly layer is untouched — it's a separate mechanism and still gated by `modelCapabilities`.
2. **`GenerateOptions.modelName` is deleted.** Its only purpose was capability lookup inside `generateChat`; with the gate gone it is dead. (Knip will flag it otherwise.)
3. **Wire bytes stay identical.** We do NOT let the SDK derive JSON Schema from Zod (its conversion does not apply our Cerebras strict-mode cleaning — `oneOf`→`anyOf` rewrite, forbidden-keyword stripping, budget assertions). We feed `Output.object` our existing cleaned schema via `jsonSchema()`.
4. **Retry directive strings stay identical.** On `NoObjectGeneratedError`, `executeTurn` re-derives the directive by re-running `JSON.parse` + `schema.safeParse` on the error's `text` — same code that produced the strings today, so persisted `harness_retry_directive` rows are byte-compatible with existing data and prompts.

## File touch list

- **Modify:** `src/lib/llm/toCerebrasJsonSchema.ts` — add `toOutputSchema()`.
- **Modify:** `src/lib/llm/toCerebrasJsonSchema.test.ts` — tests for `toOutputSchema`.
- **Modify:** `src/lib/llm/generate.ts` — replace middleware with `output:`; drop capability gate + `modelName`; add `parsed` to result.
- **Modify:** `src/lib/llm/generate.test.ts` — update wire assertions; add parsed/error tests.
- **Modify:** `src/lib/turn/executeTurn.ts` — consume `parsed`; catch `NoObjectGeneratedError`; delete `parseAndValidate`.
- **Modify:** `src/lib/turn/executeTurn.test.ts` — update `generateChat` mocks.
- **Modify:** `src/lib/llm/CLAUDE.md`, `src/lib/turn/CLAUDE.md` — document the new mechanism.
- **No changes:** routers, course steps, prompts, DB. Callers of `executeTurn` see an identical interface.

---

## Task 1: `toOutputSchema` — SDK schema wrapper preserving Cerebras wire bytes

**Files:**

- Modify: `src/lib/llm/toCerebrasJsonSchema.ts`
- Test: `src/lib/llm/toCerebrasJsonSchema.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/llm/toCerebrasJsonSchema.test.ts`:

```typescript
describe("toOutputSchema", () => {
  const zodSchema = z.object({ x: z.string() }).refine((v) => v.x !== "bad", {
    message: "x must not be 'bad'",
  });

  it("exposes the same cleaned wire schema bytes as toCerebrasJsonSchema", async () => {
    const sdkSchema = toOutputSchema(zodSchema, { name: "test" });
    const wire = toCerebrasJsonSchema(zodSchema, { name: "test" });
    // `jsonSchema` exposes the wrapped JSON Schema via `.jsonSchema`.
    expect(await sdkSchema.jsonSchema).toEqual(wire.schema);
  });

  it("validates via Zod, surfacing refine failures", async () => {
    const sdkSchema = toOutputSchema(zodSchema, { name: "test" });
    const ok = await sdkSchema.validate!({ x: "fine" });
    expect(ok).toEqual({ success: true, value: { x: "fine" } });
    const bad = await sdkSchema.validate!({ x: "bad" });
    expect(bad.success).toBe(false);
    // The error must be the ZodError so issue messages reach retry directives.
    if (!bad.success) expect(bad.error.message).toContain("x must not be 'bad'");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test src/lib/llm/toCerebrasJsonSchema.test.ts`
Expected: FAIL — `toOutputSchema` is not exported.

- [ ] **Step 3: Implement `toOutputSchema`**

In `src/lib/llm/toCerebrasJsonSchema.ts`, add to the imports:

```typescript
import { jsonSchema, type Schema } from "ai";
```

Append after `toSchemaJsonString`:

```typescript
/**
 * Wrap a Zod schema as an AI SDK `Schema` whose wire shape is the
 * Cerebras-cleaned JSON Schema and whose validator is Zod `safeParse`.
 *
 * WHY: `Output.object({ schema })` would otherwise derive JSON Schema from
 * Zod itself, bypassing `cleanForCerebras` (keyword stripping, oneOf→anyOf,
 * the 5000-char/depth-10 budget asserts). Feeding the SDK this wrapper keeps
 * the wire bytes identical to the pre-Output implementation while letting
 * the SDK run our full Zod validation — refines included — and throw
 * `NoObjectGeneratedError` with the ZodError as `cause` on failure.
 */
export function toOutputSchema<T>(
  schema: z.ZodType<T>,
  opts: CerebrasJsonSchemaOptions,
): Schema<T> {
  const wire = toCerebrasJsonSchema(schema, opts);
  return jsonSchema<T>(wire.schema, {
    validate: (value) => {
      const result = schema.safeParse(value);
      return result.success
        ? { success: true, value: result.data }
        : { success: false, error: result.error };
    },
  });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun run test src/lib/llm/toCerebrasJsonSchema.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/llm/toCerebrasJsonSchema.ts src/lib/llm/toCerebrasJsonSchema.test.ts
git commit -m "feat(llm): add toOutputSchema wrapping Cerebras wire schema for Output.object"
```

---

## Task 2: Rewrite `generateChat` on `Output.object`

**Files:**

- Modify: `src/lib/llm/generate.ts`
- Test: `src/lib/llm/generate.test.ts`

- [ ] **Step 1: Update existing tests + add new ones**

In `src/lib/llm/generate.test.ts`:

(a) The test `"sends the schema to the model as a strict json response_format"` keeps its assertions — `Output.object` produces the same `{ type: "json", name, schema }` callOption the middleware did. Update only its inline comment:

```typescript
// Output.object resolves callOptions.responseFormat from toOutputSchema:
// this is the value the openai-compatible provider turns into a strict
// json_schema response_format on the wire.
```

(b) Delete the `beforeEach`/`afterEach` `LLM_MODEL` stubs and their comments — the capability gate is gone, so the model name no longer affects `generateChat`.

(c) Add new tests at the end of the `describe`:

```typescript
it("returns the validated object as `parsed` when a schema is supplied", async () => {
  const model = mockModel('{"x":"hi"}');

  const result = await generateChat([{ role: "user", content: "hi" }], {
    model,
    responseSchema: z.object({ x: z.string() }),
  });

  expect(result.parsed).toEqual({ x: "hi" });
  // Raw text is still returned verbatim — executeTurn persists it.
  expect(result.text).toBe('{"x":"hi"}');
});

it("throws NoObjectGeneratedError carrying the raw text on schema violation", async () => {
  const model = mockModel('{"x":42}'); // wrong type for x

  await expect(
    generateChat([{ role: "user", content: "hi" }], {
      model,
      responseSchema: z.object({ x: z.string() }),
    }),
  ).rejects.toSatisfy((err: unknown) => {
    if (!NoObjectGeneratedError.isInstance(err)) return false;
    return err.text === '{"x":42}';
  });
});

it("sends response_format regardless of model capability (gate removed)", async () => {
  // Pre-Output behavior gated response_format on honorsStrictMode; the gate
  // is gone — Cerebras treats response_format as soft guidance, so sending
  // it universally is harmless and keeps one code path.
  vi.stubEnv("LLM_MODEL", "llama3.1-8b"); // a non-honouring model name
  const model = mockModel('{"x":"hi"}');

  await generateChat([{ role: "user", content: "hi" }], {
    model,
    responseSchema: z.object({ x: z.string() }),
  });

  expect(model.doGenerateCalls[0]?.responseFormat?.type).toBe("json");
  vi.unstubAllEnvs();
});
```

Add to imports: `import { NoObjectGeneratedError } from "ai";`

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `bun run test src/lib/llm/generate.test.ts`
Expected: new tests FAIL (`parsed` undefined / no error thrown); pre-existing wire test still passes against the middleware implementation.

- [ ] **Step 3: Rewrite `generate.ts`**

Replace the full contents of `src/lib/llm/generate.ts` with:

```typescript
import { generateText, Output, NoObjectGeneratedError } from "ai";
import type { LanguageModelV3 } from "@ai-sdk/provider";
import type { z } from "zod/v4";
import { LLM } from "@/lib/config/tuning";
import { getLlmModel } from "./provider";
import { toOutputSchema } from "./toCerebrasJsonSchema";
import { awaitCerebrasCallSlot, recordCerebrasRateLimitHeaders } from "./cerebrasRateLimit";
import type { LlmMessage, LlmUsage } from "@/lib/types/llm";

/**
 * Options common to the chat wrapper. All optional — `tuning.LLM`
 * supplies defaults. Callers override per-flow (e.g. a creative framing
 * prompt may raise temperature).
 */
export interface GenerateOptions {
  /** 0–1. Lower → more consistent. Default: `LLM.defaultTemperature`. */
  readonly temperature?: number;
  /** Transport-level retries on transient errors. Default: `LLM.maxRetries`. */
  readonly maxRetries?: number;
  /** Override the model for a single call (testing, capability routing). */
  readonly model?: LanguageModelV3;
}

/**
 * Chat-call extension: when `responseSchema` is provided, the call sends a
 * strict `json_schema` response_format (soft guidance on Cerebras) AND the
 * SDK validates the response against the Zod schema before returning.
 * `responseSchemaName` is the JSON Schema `name` field on the wire
 * (defaults to "response").
 */
export interface ChatOptions<T = unknown> extends GenerateOptions {
  readonly responseSchema?: z.ZodType<T>;
  readonly responseSchemaName?: string;
}

/**
 * Successful chat result. When `responseSchema` was supplied, `parsed` is
 * the schema-validated object and `text` is the raw JSON string it was
 * parsed from (persisted verbatim by executeTurn); otherwise `parsed` is
 * absent and `text` is raw model prose.
 */
export interface ChatResult<T = unknown> {
  /** Raw model output (JSON string or prose). */
  readonly text: string;
  /** Schema-validated object; present iff `responseSchema` was supplied. */
  readonly parsed?: T;
  /** Provider-reported token usage for this call. */
  readonly usage: LlmUsage;
}

/**
 * Chat call. When `responseSchema` is supplied, the AI SDK's
 * `Output.object` mechanism is used: `toOutputSchema` preserves the
 * Cerebras-cleaned wire bytes, and the SDK runs Zod validation (refines
 * included) on the response. Validation or JSON-parse failure throws the
 * SDK's `NoObjectGeneratedError` (carrying `text` + `usage`); transport
 * errors propagate as before. `executeTurn` converts
 * `NoObjectGeneratedError` into its `ValidationGateFailure` retry flow.
 *
 * Docs: node_modules/ai/docs/03-ai-sdk-core/10-generating-structured-data.mdx
 *       (https://ai-sdk.dev/docs/ai-sdk-core/generating-structured-data)
 *
 * Rate limiting: `awaitCerebrasCallSlot()` paces every call to stay under
 * the Cerebras PER-MINUTE limits via request spacing plus header-driven
 * token-budget backoff (see `cerebrasRateLimit.ts`). It runs in production
 * AND live smoke, including across `executeTurn`'s validation retries.
 * After the call returns — including the NoObjectGeneratedError path,
 * where the HTTP call itself succeeded — the `x-ratelimit-*` response
 * headers are recorded for the next call to consult. Both are a complete
 * no-op in mocked unit/integration suites.
 */
export async function generateChat<T>(
  messages: readonly LlmMessage[],
  opts: ChatOptions<T> & { responseSchema: z.ZodType<T> },
): Promise<ChatResult<T> & { parsed: T }>;
export async function generateChat(
  messages: readonly LlmMessage[],
  opts?: ChatOptions,
): Promise<ChatResult>;
export async function generateChat<T>(
  messages: readonly LlmMessage[],
  opts: ChatOptions<T> = {},
): Promise<ChatResult<T>> {
  // Cerebras rate-limit gate. Blocks until this call is cleared under the
  // per-minute limits. No-op in mocked test suites.
  await awaitCerebrasCallSlot();

  const model = opts.model ?? getLlmModel();
  const common = {
    model,
    messages: [...messages],
    temperature: opts.temperature ?? LLM.defaultTemperature,
    maxRetries: opts.maxRetries ?? LLM.maxRetries,
  };

  // Plain-text path: no schema, no output wrapper.
  if (opts.responseSchema === undefined) {
    const result = await generateText(common);
    recordCerebrasRateLimitHeaders(result.response.headers);
    return { text: result.text, usage: result.usage };
  }

  // Structured path: Output.object sets callOptions.responseFormat from
  // toOutputSchema (Cerebras-cleaned wire bytes) and validates the response
  // with the Zod schema before returning.
  const name = opts.responseSchemaName ?? "response";
  try {
    const result = await generateText({
      ...common,
      output: Output.object({
        schema: toOutputSchema(opts.responseSchema, { name }),
        name,
      }),
    });
    recordCerebrasRateLimitHeaders(result.response.headers);
    return { text: result.text, parsed: result.output, usage: result.usage };
  } catch (err) {
    // Validation failure still means the HTTP call succeeded — record the
    // rate-limit headers the error carries so the next call backs off
    // correctly, then let executeTurn translate the error.
    if (NoObjectGeneratedError.isInstance(err)) {
      recordCerebrasRateLimitHeaders(err.response?.headers);
    }
    throw err;
  }
}
```

Note: if `err.response?.headers` does not typecheck (`LanguageModelResponseMetadata` may not carry headers in this SDK version), drop that line and the comment — header recording on the failure path is an improvement, not a requirement. Check the type in `node_modules/ai/src/error/no-object-generated-error.ts` first.

- [ ] **Step 4: Run tests**

Run: `bun run test src/lib/llm/generate.test.ts`
Expected: PASS. If the wire-assertion test fails on `name` placement, inspect `model.doGenerateCalls[0]?.responseFormat` with `console.dir` once, align the assertion with what `Output.object` actually resolves (`{ type: "json", schema, name }` per `node_modules/ai/src/generate-text/output.ts:114`), and remove the debug output.

- [ ] **Step 5: Typecheck the repo to find broken callers**

Run: `just typecheck`
Expected: errors ONLY in `src/lib/turn/executeTurn.ts` (next task) and possibly `modelCapabilities`-related unused imports in `generate.test.ts`. Anything else: stop and investigate before proceeding.

- [ ] **Step 6: Commit**

```bash
git add src/lib/llm/generate.ts src/lib/llm/generate.test.ts
git commit -m "refactor(llm): generateChat on Output.object, drop transformParams middleware"
```

---

## Task 3: Re-seat `executeTurn` on the SDK error

**Files:**

- Modify: `src/lib/turn/executeTurn.ts`
- Test: `src/lib/turn/executeTurn.test.ts`

- [ ] **Step 1: Update the test mocks**

`executeTurn.test.ts` mocks `generateChat` via `vi.mock("@/lib/llm/generate")`. Two mechanical changes across the file:

(a) Every success-path mock gains `parsed` (the object the old code derived by parsing `text`). Example — a mock that today reads:

```typescript
vi.mocked(generateChat).mockResolvedValueOnce({
  text: '{"ok":true}',
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});
```

becomes:

```typescript
vi.mocked(generateChat).mockResolvedValueOnce({
  text: '{"ok":true}',
  parsed: { ok: true },
  usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
});
```

(b) Every failure-path mock (where `text` is invalid JSON or fails the schema) becomes a rejection with the SDK error. Add to imports:

```typescript
import { NoObjectGeneratedError } from "ai";
```

and a local helper near the top of the file:

```typescript
/** Builds the error generateChat now throws on parse/validation failure. */
function noObjectError(text: string): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
    message: "No object generated: response did not match schema.",
    text,
    response: { id: "test", timestamp: new Date(0), modelId: "mock" },
    usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    finishReason: "stop",
  });
}
```

then replace e.g. `mockResolvedValueOnce({ text: "not json", usage: ... })` with `mockRejectedValueOnce(noObjectError("not json"))`. (If the `NoObjectGeneratedError` constructor signature differs, check `node_modules/ai/src/error/no-object-generated-error.ts` — all fields are in its constructor object.)

Assertions about persisted rows (`failed_assistant_response` content = raw text, `harness_retry_directive` content) DO NOT change — behavior is preserved.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun run test src/lib/turn/executeTurn.test.ts`
Expected: FAIL — executeTurn still calls `parseAndValidate` and doesn't catch the rejection.

- [ ] **Step 3: Rewrite the attempt body**

In `src/lib/turn/executeTurn.ts`:

(a) Imports: add `NoObjectGeneratedError` from `ai`; keep `ValidationGateFailure` and `JSON_PARSE_RETRY_DIRECTIVE` imports.

(b) Inside `attempt()`, replace the block from `const t0 = Date.now();` through the end of the `try/catch` with:

```typescript
const t0 = Date.now();
try {
  // generateChat now JSON-parses AND Zod-validates via Output.object;
  // `parsed` is the typed result and `text` the raw string we persist.
  const result = await generateChat(llmMessages, {
    responseSchema: params.responseSchema,
    responseSchemaName: params.responseSchemaName ?? params.seed.kind,
  });
  const dt = Date.now() - t0;
  if (live && !quiet) {
    process.stderr.write(formatResponseBlock(result.text, dt, result.usage));
  }
  if (live) {
    const summary = params.successSummary
      ? params.successSummary(result.parsed)
      : `chars=${result.text.length}`;
    process.stderr.write(formatParseSuccess(label, summary));
  }
  const successRow: AppendMessageParams = {
    parent: params.parent,
    turnIndex,
    seq: batch.length,
    kind: "assistant_response",
    role: "assistant",
    content: result.text,
  };
  await appendMessages([...batch, successRow]);
  return { parsed: result.parsed, usage: result.usage };
} catch (err) {
  // Only the SDK's structured-output failure enters the retry flow;
  // transport-class errors propagate without persisting — the batch
  // never commits (same contract as before).
  if (!NoObjectGeneratedError.isInstance(err)) throw err;
  const dt = Date.now() - t0;
  const raw = err.text ?? "";
  const gate = toValidationGateFailure(raw, params.responseSchema);
  // Failure observability: flush the prompt + response trail (verbose
  // already printed the prompt; quiet retroactively flushes both).
  if (live) {
    if (quiet) {
      process.stderr.write(formatPromptBlock(llmMessages, liveSchemaJson));
    }
    process.stderr.write(formatResponseBlock(raw, dt, err.usage));
    const diagnosis = diagnoseFailure(gate, raw);
    process.stderr.write(formatParseFailure(label, gate, diagnosis));
  }
  const failedRow: AppendMessageParams = {
    parent: params.parent,
    turnIndex,
    seq: batch.length,
    kind: "failed_assistant_response",
    role: "assistant",
    content: raw,
  };
  if (i + 1 >= totalAttempts) {
    // Terminal exhaust: persist failure trail without trailing directive.
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
```

Note the verbose-mode response block now prints inside the branches (success/failure) rather than once before parsing — the response text comes from either `result.text` or `err.text`. Net stderr output for the smoke reader is unchanged in content.

(c) Replace the `parseAndValidate` function (lines ~291-307) with the directive re-derivation helper:

```typescript
/**
 * Rebuild the legacy retry directive from a NoObjectGeneratedError's raw
 * text. Re-runs the same JSON.parse + safeParse the old in-harness gate
 * ran, so directive strings (and therefore persisted
 * `harness_retry_directive` rows and replayed prompts) are byte-identical
 * to the pre-Output implementation. The double-parse only happens on the
 * failure path — rare, and trivially cheap next to the LLM call.
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
  // safeParse succeeding here means the SDK rejected for a reason our
  // re-parse can't see (e.g. secure-JSON prototype-pollution guard) —
  // treat as a JSON-shape failure rather than inventing a directive.
  return new ValidationGateFailure(
    "missing_response",
    safe.success ? JSON_PARSE_RETRY_DIRECTIVE : safe.error.message,
  );
}
```

(d) Update the `ExecuteTurnParams.responseSchema` TSDoc: the "(2) post-decode via `schema.safeParse(...)`" sentence becomes "(2) post-decode by the SDK's `Output.object` validate hook, which runs this schema's `safeParse` (refines included)".

- [ ] **Step 4: Run the unit suite**

Run: `bun run test src/lib/turn/ src/lib/llm/`
Expected: PASS.

- [ ] **Step 5: Run integration tests**

Run: `just test-int`
Expected: PASS — integration suites mock at the same `generateChat` seam or use testcontainers with mocked LLM; any failure here means a mock shape was missed (search for `mockResolvedValue` on `generateChat` across `src/lib/course/*.integration.test.ts`).

- [ ] **Step 6: Commit**

```bash
git add src/lib/turn/executeTurn.ts src/lib/turn/executeTurn.test.ts
git commit -m "refactor(turn): executeTurn consumes Output.object results, deletes parseAndValidate"
```

---

## Task 4: Documentation + full verification + live smoke

**Files:**

- Modify: `src/lib/llm/CLAUDE.md`
- Modify: `src/lib/turn/CLAUDE.md`

- [ ] **Step 1: Update `src/lib/llm/CLAUDE.md`**

Replace the `generate.ts` bullet (line 6) with:

```markdown
- `generate.ts` wraps the SDK: `generateChat` (→ `generateText`) for all LLM calls. When `responseSchema` is supplied, the call uses `output: Output.object({ schema: toOutputSchema(...) })` — the SDK sets the strict `json_schema` `response_format` on the wire (Cerebras-cleaned bytes preserved) and Zod-validates the response (refines included) before returning `parsed`. Parse/validation failure throws the SDK's `NoObjectGeneratedError`; `executeTurn` converts it to `ValidationGateFailure`. Applies `tuning.LLM` defaults; forwards `usage`.
```

- [ ] **Step 2: Update `src/lib/turn/CLAUDE.md`**

Replace the "Validation now lives inside `executeTurn` itself" bullet with:

```markdown
- Validation: callers supply a `responseSchema` (Zod). `generateChat`
  validates via the SDK's `Output.object` (JSON-parse + `safeParse`,
  refines included) and throws `NoObjectGeneratedError` on failure;
  `executeTurn` converts that to
  `ValidationGateFailure("missing_response", <directive>)`, where the
  directive is re-derived from the raw text so its strings are identical
  to the pre-SDK implementation. Zod's error message includes field
  paths, issue codes, and refine `.message` strings — that JSON becomes
  the retry directive.
```

- [ ] **Step 3: Full check**

Run: `just check`
Expected: lint, typecheck, unit tests all green. Knip must not flag new dead exports — if it flags `getModelCapabilities` usage drop in `generate.ts`, that's expected only if no other caller remains (there are callers in `src/lib/course/`; if knip still complains, investigate rather than ignore).

- [ ] **Step 4: Live smoke (requires `.env.local` with Cerebras key — coordinate with Ollie if budget is a concern; ≈ $0.06/run)**

Run: `just smoke`
Expected: all live scoping + wave turns pass; the stderr banners show identical schema JSON to previous runs. This is the only step that proves the wire bytes truly match — do not skip it; do not defer it to CI (CI has no live key).

- [ ] **Step 5: Commit + hand off**

```bash
git add src/lib/llm/CLAUDE.md src/lib/turn/CLAUDE.md
git commit -m "docs(llm): document Output.object structured-output mechanism"
```

Then follow `superpowers:finishing-a-development-branch` (PR to `main`; CI re-runs everything).

---

## Self-review checklist (for the executing agent)

- [ ] `git grep wrapLanguageModel src/` returns nothing (middleware deleted) — except any DevTools usage added later by the hygiene plan.
- [ ] `git grep "modelName" src/lib/llm/generate.ts` returns nothing.
- [ ] `git grep parseAndValidate src/` returns nothing.
- [ ] Persisted-row content in executeTurn tests asserts raw `err.text` lands in `failed_assistant_response` — unchanged from before.
- [ ] `getModelCapabilities` still imported by `src/lib/course/executeWaveMid.ts` and the baseline/framework steps (inline-envelope gate) — NOT deleted.
