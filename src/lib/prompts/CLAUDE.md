# src/lib/prompts

Single source of truth for all LLM prompt text. No prompt text exists outside this directory.

- Every prompt is a pure function: typed params in, `LlmMessage[]` (or string) out. No side effects, no DB calls.
- Scoping is one append-only conversation. Only `clarification.ts` emits `role: system`; each later scoping prompt appends user/assistant messages to keep the cache prefix byte-stable.
- Teaching prompts are assembled fresh (new `role: system`), static-first / dynamic-last.
- Use XML tags for structured sections. Avoid guessable tag names (`<system>`, `<instructions>`).
- Sanitise untrusted text at this layer (`sanitiseUserInput`) so callers can't skip it. Every system prompt instructs the model to treat `<user_message>` as data.

Scoping prompts (current flow): the system prompt — assembled by `renderScopingSystem(inputs)` — contains the role block plus the per-stage instruction constants (`FRAMEWORK_TURN_INSTRUCTIONS`, `BASELINE_TURN_INSTRUCTIONS`). Per-turn user messages are minimal envelopes (`<answers>...</answers>`, `<request>generate baseline</request>`) and are assembled inline in `src/lib/course/`. The `build*Prompt` builders (`buildClarificationPrompt`, `buildFrameworkPrompt`, `buildBaselinePrompt`) are retained only because `src/lib/course/gradeBaseline.ts` still reconstructs the scoping conversation history via `buildBaselineEvaluationPrompt` in `src/lib/prompts/baselineEvaluation.ts`. Once `gradeBaseline` migrates to `executeTurn` (see `docs/TODO.md`), the builders and their tests can be deleted.
