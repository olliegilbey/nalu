# src/lib/llm

Single LLM integration point for the entire application. Built on the Vercel AI SDK v6 (`ai` + `@ai-sdk/openai-compatible`); nothing outside this directory imports `ai` directly.

- `provider.ts` is the only swap-point for the underlying model. Env-driven (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`). Switching providers is a one-line change here.
- `generate.ts` wraps the SDK: `generateChat` (→ `generateText`) for all LLM calls. When `responseSchema` is supplied, the call uses `output: Output.object({ schema: toOutputSchema(...) })` — the SDK sets the strict `json_schema` `response_format` on the wire (Cerebras-cleaned bytes preserved) and Zod-validates the response (refines included) before returning `parsed`. Parse/validation failure throws the SDK's `NoObjectGeneratedError`; `executeTurn` converts it to `ValidationGateFailure`. Applies `tuning.LLM` defaults; forwards `usage`.
- `streamChat.ts` — streaming sibling of `generateChat` for structured turns: `streamText` + `Output.object`, same rate-limit gate and wire bytes. Yields display-only `partialOutputStream` partials; `final()` resolves the validated object or rejects with `NoObjectGeneratedError`.
- `cerebrasToolLoopPrepareStep.ts` — shared per-step `prepareStep` for tool loops (fast-lane pacing + assistant `reasoning`-part strip); consumed by the `ToolLoopAgent` definitions in `src/lib/agents/`, which pair it with an `onStepFinish` recording rate-limit headers. Tool-loop DISPATCH lives there + `src/lib/turn/executeToolTurnStream.ts`, not here.
- Structured calls are validated by the SDK against the supplied Zod schema before returning; transport retries are bounded by `LLM.maxRetries`.
- Token usage is returned on every call — propagate it, don't drop it.

## Render contract

- `renderContext.ts` is pure: same `(seed, messages)` → byte-identical
  output. The cache prefix is preserved when rows are appended. Tests
  assert both invariants — never weaken them.
- `renderContext` applies a per-turn retry filter: rows are grouped by `turn_index`; within a group containing an `assistant_response`, any `failed_assistant_response` + `harness_retry_directive` rows are dropped (they were intermediate retry exhaust). Terminal-exhaust groups (no `assistant_response`) keep every row so the model can see the failure context. This preserves cache-prefix stability — a recovered turn renders to the same bytes as a non-retry turn.
- The legacy XML model→harness protocol (`parseAssistantResponse`, `extractTag`, `tagVocabulary`) was deleted 2026-07-16 (Phase 5) — validation gates live in `src/lib/turn/` (`validationGateFailure.ts`) and the Zod schemas in `src/lib/prompts/`.
