# src/lib/llm

Single LLM integration point for the entire application. Built on the Vercel AI SDK v5 (`ai` + `@ai-sdk/openai-compatible`); nothing outside this directory imports `ai` directly.

- `provider.ts` is the only swap-point for the underlying model. Env-driven (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`). Switching providers is a one-line change here.
- `generate.ts` wraps the SDK: `generateStructured` (Zod schema → `generateObject`) for wholly-structured calls, `generateChat` (→ `generateText`) for PRD §5 prose-with-embedded-XML turns. Applies `tuning.LLM` defaults; forwards `usage`.
- `extractTag.ts` — pure XML extractor for the prose+XML turns. Callers Zod-validate the extracted payload at that boundary (this is where the "no raw LLM output" rule is enforced for chat calls).
- Structured calls are validated by the SDK against the supplied Zod schema before returning; transport retries are bounded by `LLM.maxRetries`.
- Token usage is returned on every call — propagate it, don't drop it.
