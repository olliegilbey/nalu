# src/lib/llm

Single LLM integration point for the entire application.

- `client.ts` is the only file that calls the LLM provider API. Everything else imports from here.
- Provider-agnostic: targets OpenAI Chat Completions API. No provider-specific SDKs. Provider configured via env vars (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`).
- `parsers.ts` extracts tagged XML blocks from responses, validates with Zod, retries on failure (max 3). On retry, append the parse error so the model can self-correct.
- Track estimated token count (input + output) on every call. Return alongside response.
- All responses validated with Zod before returning. Never trust raw LLM output.
- Handle errors explicitly: rate limits, timeouts, malformed responses. No swallowed errors.
