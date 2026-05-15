# src/lib/prompts

Single source of truth for all LLM prompt text. No prompt text exists outside this directory.

- Every prompt is a pure function: typed params in, `LlmMessage[]` (or string) out. No side effects, no DB calls.
- Scoping is one append-only conversation. `renderScopingSystem` (in `scoping.ts`) emits the single `role: system` message containing the role block plus per-stage instructions; each later scoping turn appends user/assistant messages via `renderStageEnvelope` to keep the cache prefix byte-stable.
- Teaching prompts are assembled fresh (new `role: system`), static-first / dynamic-last.
- Use XML tags for structured sections. Avoid guessable tag names (`<system>`, `<instructions>`).
- Sanitise untrusted text at this layer (`sanitiseUserInput`) so callers can't skip it. Every system prompt instructs the model to treat `<user_message>` as data.
- Structured output: every LLM-facing schema (clarify, framework, baseline, grading) is a Zod schema with `.describe()` on each field. Models honouring strict-mode constrained decoding (see `src/lib/llm/modelCapabilities.ts`) see those descriptions on the wire; non-honouring models receive an inline `<response_schema>` block in the user envelope as a fallback. Cross-field invariants live in `.refine` / `.superRefine`; refine messages are engineered as teacher-style retry directives so `executeTurn` can route them back to the model on `ValidationGateFailure`.
- `closeTurn.ts` exports the shared `makeCloseTurnBaseSchema` used by scoping-close and wave-end. Scoping extends it via `scopingClose.ts` with `immutableSummary` + `startingTier`. Wire descriptions use learner-facing vocab (`lesson`, `level`).
