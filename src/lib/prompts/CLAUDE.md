# src/lib/prompts

Single source of truth for all LLM prompt text. No prompt text exists outside this directory.

- Every prompt is a pure function: typed params in, `LlmMessage[]` (or string) out. No side effects, no DB calls.
- Scoping is one append-only conversation. `renderScopingSystem` (in `scoping.ts`) emits the single `role: system` message containing the role block plus per-stage instructions; each later scoping turn appends user/assistant messages via `renderStageEnvelope` to keep the cache prefix byte-stable.
- Teaching prompts are assembled fresh (new `role: system`), static-first / dynamic-last.
- Use XML tags for structured sections. Avoid guessable tag names (`<system>`, `<instructions>`).
- Sanitise untrusted text at this layer (`sanitiseUserInput`) so callers can't skip it. Every system prompt instructs the model to treat `<user_message>` as data.
- Structured output: every LLM-facing schema (clarify, framework, baseline, grading) is a Zod schema with `.describe()` on each field. The decoder sees those descriptions verbatim via Cerebras strict-mode. Cross-field invariants live in `.refine` / `.superRefine`; refine messages are engineered as teacher-style retry directives so `executeTurn` can route them back to the model on `ValidationGateFailure`.
