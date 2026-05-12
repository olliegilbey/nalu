# src/lib/llm

Single LLM integration point for the entire application. Built on the Vercel AI SDK v5 (`ai` + `@ai-sdk/openai-compatible`); nothing outside this directory imports `ai` directly.

- `provider.ts` is the only swap-point for the underlying model. Env-driven (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`). Switching providers is a one-line change here.
- `generate.ts` wraps the SDK: `generateStructured` (Zod schema → `generateObject`) for wholly-structured calls, `generateChat` (→ `generateText`) for PRD §5 prose-with-embedded-XML turns. Applies `tuning.LLM` defaults; forwards `usage`.
- `extractTag.ts` — pure XML extractor for the prose+XML turns. Callers Zod-validate the extracted payload at that boundary (this is where the "no raw LLM output" rule is enforced for chat calls).
- Structured calls are validated by the SDK against the supplied Zod schema before returning; transport retries are bounded by `LLM.maxRetries`.
- Token usage is returned on every call — propagate it, don't drop it.

## Render & parse contract

- `tagVocabulary.ts` is the single source of truth for the harness ↔ model
  XML-tag contract (spec §6.5). Any new tag requires editing this file +
  `src/lib/prompts/teaching.ts`'s `OUTPUT_FORMATS_BLOCK` together.
- `renderContext.ts` is pure: same `(seed, messages)` → byte-identical
  output. The cache prefix is preserved when rows are appended. Tests
  assert both invariants — never weaken them.
- `parseAssistantResponse.ts` enforces the validation gate:
  `<response>` required every turn, `<next_lesson_blueprint>` +
  `<course_summary_update>` required on a Wave's final turn. Optional
  tags that fail their inner Zod schema are dropped silently; the rest
  of the turn proceeds. `raw` is preserved verbatim for persistence.
- The retry policy described in spec §9.2 lives in the harness loop
  (next milestone) and uses the gate exposed here.
- `renderContext` applies a per-turn retry filter: rows are grouped by `turn_index`; within a group containing an `assistant_response`, any `failed_assistant_response` + `harness_retry_directive` rows are dropped (they were intermediate retry exhaust). Terminal-exhaust groups (no `assistant_response`) keep every row so the model can see the failure context. This preserves cache-prefix stability — a recovered turn renders to the same bytes as a non-retry turn.
