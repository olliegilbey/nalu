# Design: wire Cerebras strict-mode JSON-schema decoding

Date: 2026-05-22
Branch: `chore/nalu-debug-skill`

## Problem

Structured LLM turns (`course.clarify`, `generateFramework`, `generateBaseline`,
`submitBaseline`, wave teaching turns) are supposed to use Cerebras strict-mode
constrained decoding so the model can only emit schema-conformant JSON. They do
not. The JSON schema never reaches the provider.

Root cause: `generateChat` in `src/lib/llm/generate.ts` builds a `responseFormat`
object and passes it as a **top-level argument** to `generateText`. AI SDK v6
(`ai@6.0.158`) `generateText` has no top-level `responseFormat` option — it sets
the model-call `responseFormat` only from its `output` parameter. The top-level
arg is silently dropped; it typechecks only because a conditional spread dodges
TypeScript's excess-property check.

Consequence: every structured turn's first attempt flies blind (no schema). The
model guesses the shape, usually fails Zod validation in `executeTurn`, and only
then does the retry directive embed the schema and the model recovers on attempt 2. A guaranteed retry tax on essentially every structured turn, confirmed in the
production DB.

## Goal & success criteria

Structured LLM calls send the schema to Cerebras as a real
`response_format: { type: "json_schema", json_schema: { ..., strict: true } }`
wire payload, so the model is constrained on the first attempt.

Success criteria:

- The schema reaches the provider as `callOptions.responseFormat` (verified
  in-process by a test using a mock model — see Testing).
- `toCerebrasJsonSchema` output is a valid Cerebras strict-mode schema for every
  real production response schema (verified by a static test).
- `executeTurn`'s parse / validate / retry-with-directive behaviour is
  unchanged.
- Live: `just smoke` and the `just probe-model` DESC probe confirm the schema
  reaches the model; post-deploy `inspect-db.ts` shows first attempts no longer
  failing-and-recovering.

## Scope

Minimal wiring fix only. The now-vestigial `honorsStrictMode` gate, the inline
`<response_schema>` prompt path, and the `modelCapabilities` registry are **left
in place** and torn out under a separate follow-up GitHub issue (see Follow-up).

## Chosen approach: `wrapLanguageModel` middleware

`generateChat` wraps the model with a one-shot language-model middleware whose
`transformParams` hook sets `callOptions.responseFormat`. `generateText` is
called with no `output` parameter, so it returns raw `.text` exactly as today
and `executeTurn` is untouched.

Two alternatives were considered and rejected:

- **`output: Output.object`** (the docs-blessed structured-output path): also
  makes `generateText` parse `.text` and throw `NoObjectGeneratedError` on
  failure. That collides with `executeTurn`, which is deliberately built to
  receive raw `.text` and own parse / validate / retry-with-directive itself.
  Using `Output.object` purely for its `responseFormat` side effect, then
  catching its main feature as control flow, is abstraction misuse.
- **Provider-specific options passthrough** (`providerOptions.<name>` raw body
  injection): the `@ai-sdk/openai-compatible` provider already translates
  `callOptions.responseFormat` into the exact Cerebras `response_format`
  envelope (`dist/index.mjs:517-523`, `strictJsonSchema` defaults `true`). The
  passthrough would hand-reimplement that translation and leak the Cerebras wire
  shape into `generate.ts`.

Both rejected alternatives and the chosen one produce the identical wire
payload, because the openai-compatible provider derives `response_format` from
`callOptions.responseFormat` and `callOptions.responseFormat` has exactly two
possible sources: the `output` param or middleware `transformParams`.

Note: `vercel/ai#8475` ("Cerebras Unsupported response_format parameter") does
not affect this work. That bug concerns the first-party `@ai-sdk/cerebras`
provider defaulting `supportsStructuredOutputs: false`. Nalu uses the generic
`@ai-sdk/openai-compatible` provider with `supportsStructuredOutputs: true`
explicitly set in `provider.ts` — already the correct configuration.

## Design

### `src/lib/llm/generate.ts`

`generateChat` keeps building `responseFormat` exactly as today (gated on
`opts.responseSchema` present AND `capabilities.honorsStrictMode`). The change is
how it reaches the model:

```ts
const baseModel = opts.model ?? getLlmModel();

// generateText silently drops a top-level `responseFormat` arg; a middleware
// transformParams hook is the supported way to set callOptions.responseFormat,
// which the openai-compatible provider then emits as a strict json_schema
// response_format on the wire.
const model =
  responseFormat !== undefined
    ? wrapLanguageModel({
        model: baseModel,
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

Removed: the dead top-level `responseFormat` arg and its conditional spread. The
comment above the `responseFormat` build is updated — its current second
sentence describes the dead path.

The middleware is inlined, not extracted to a factory: it is a single-use
one-line closure, and the rewritten `generate.test.ts` exercises it in place
through a real mock model (see Testing). A separate file would be a single-use
abstraction with no testability gain.

`provider.ts` is not touched — the provider swap-point stays decoupled from this
per-call concern. The `honorsStrictMode` gate stays as-is (see Scope).

### `src/lib/llm/toCerebrasJsonSchema.ts`

`CerebrasResponseFormat.schema` is retyped from `Record<string, unknown>` to
`JSONSchema7` so the object slots directly into `LanguageModelV3CallOptions`'s
`responseFormat` (whose `json` variant is
`{ type: "json"; schema?: JSONSchema7; name?: string; description?: string }`)
with no cast. The existing `stripForbidden(...) as Record<string, unknown>` cast
becomes a `JSONSchema7` cast. No behavioural change; no reshaping of the return
object — its shape already matches the `responseFormat` `json` variant.

Zod v4 `z.toJSONSchema(z.object(...), { target: "draft-7" })` already emits
`additionalProperties: false` on every object node and `type: "object"` at the
root, and inlines reused sub-schemas (no `$ref` / `$defs` / `$anchor`) — verified
empirically. `toCerebrasJsonSchema` therefore needs no new transform to satisfy
Cerebras's strict-mode requirements; `additionalProperties` is not in
`FORBIDDEN_KEYWORDS`, so it survives stripping.

### `src/lib/llm/CLAUDE.md`

Correct "Vercel AI SDK v5" to v6. Correct the `generate.ts` bullet: it currently
describes `responseFormat` being applied directly; update it to describe the
middleware mechanism.

## Files changed

| File                                       | Change                                                                                                       |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| `src/lib/llm/generate.ts`                  | Wrap model with `transformParams` middleware; drop the dead top-level `responseFormat` arg and stale comment |
| `src/lib/llm/toCerebrasJsonSchema.ts`      | Retype `CerebrasResponseFormat.schema` to `JSONSchema7`                                                      |
| `src/lib/llm/generate.test.ts`             | Rewrite (see Testing)                                                                                        |
| `src/lib/llm/toCerebrasJsonSchema.test.ts` | Add strict-mode validity test over real schemas (see Testing)                                                |
| `src/lib/llm/CLAUDE.md`                    | v5 to v6; correct the `responseFormat` mechanism description                                                 |

## Testing

### `generate.test.ts` (rewrite)

The current file mocks `generateText` and asserts the broken wiring (that
`generateText` receives a top-level `responseFormat`). It cannot see whether the
schema reaches the model. Replace that approach: do not mock `generateText`. Use
`MockLanguageModelV3` (from `ai/test`) as `opts.model`, let the real
`wrapLanguageModel` + `transformParams` run, and assert on the call options the
mock's `doGenerate` receives:

- Schema supplied + strict-mode-honouring model: `doGenerate` call options carry
  `responseFormat: { type: "json", schema, name }`.
- No schema supplied: `responseFormat` is absent from the `doGenerate` call
  options.
- Retained from the current file: `tuning.LLM` defaults are applied; token
  `usage` is propagated to the `ChatResult`.

This verifies the wiring end-to-end in-process, minus the live Cerebras call —
which is exactly the gap the old test could not cover.

### `toCerebrasJsonSchema.test.ts` (add)

Add a test that runs `toCerebrasJsonSchema` on every real production response
schema (`clarifySchema`, `frameworkSchema`, the baseline-generation schema, the
scoping-close schema, `waveMidTurnSchema`, the wave-close schema) and asserts
the output is a valid Cerebras strict-mode schema:

- root `type: "object"`,
- every object node has `additionalProperties: false`,
- no `$ref`, `$defs`, or `$anchor` anywhere,
- within the documented char and depth budgets (already asserted by
  `toCerebrasJsonSchema` itself — this test confirms it does not throw).

This is the static CI guard against shipping a schema that Cerebras strict mode
would reject with a 400 — a failure that would otherwise only surface live.

### Live verification (user-run; needs Touch ID via `op`)

- `just smoke` — live Cerebras structured turns succeed on first attempt.
- `just probe-model gpt-oss-120b` — the DESC probe (magic token lives only in a
  `.describe()`) returns the token once the schema reaches the model.
- Post-deploy: `inspect-db.ts --course <id>` on a fresh course — first
  structured attempts no longer fail-and-recover.

## Follow-up (out of scope)

Create a GitHub issue to tear out, once `llama3.1-8b` is deprecated
(2026-05-27), the now-vestigial strict-mode gating: the `honorsStrictMode` flag
and `modelCapabilities` registry, the inline `<response_schema>` prompt path
(`toSchemaJsonString`, the `responseSchema` seed string, the `<response_schema>`
prompt scaffolding), across all six lib steps. The retry directive's embedded
`<response_schema>` block is retained as the genuine fallback.

## Impl-time verifications

Settled by the compiler and tests during implementation, not design decisions:

- Exact import path for `wrapLanguageModel` (from `ai`) and for `JSONSchema7`
  (whatever `@ai-sdk/provider` sources it from).
- `MockLanguageModelV3` import path (`ai/test`) and the exact `doGenerate`
  result shape `generateText` expects.
- Confirm no production response schema uses `z.record()`, `.passthrough()`, or
  `.catchall()` (would weaken `additionalProperties: false`) — the
  `toCerebrasJsonSchema.test.ts` test makes any such case fail loudly.

## References

- `docs/status/2026-05-22-1247-llm-strict-mode-fix.md` — investigation handoff.
- AI SDK: `node_modules/ai/docs/03-ai-sdk-core/40-middleware.mdx`,
  `node_modules/ai/docs/03-ai-sdk-core/10-generating-structured-data.mdx`.
- Cerebras structured outputs:
  https://inference-docs.cerebras.ai/capabilities/structured-outputs
- `vercel/ai#8475` — Cerebras `response_format` provider-config bug (does not
  affect Nalu).
