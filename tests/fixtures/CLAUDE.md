# tests/fixtures

Mock LLM responses for every structured output type the application expects.

- One file per response type: `framework-response.ts`, `assessment-response.ts`, `evaluation-response.ts`, `comprehension-signal-response.ts`, `summary-response.ts`
- Each fixture must pass the corresponding Zod schema in `src/lib/llm/parsers.ts`
- Include at least one malformed fixture per type for testing retry logic (missing tags, invalid JSON, extra text)
- Use realistic topic examples ("South African Wines", "Python Programming")
