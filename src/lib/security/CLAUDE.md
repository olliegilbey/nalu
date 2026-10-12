# src/lib/security

All user-supplied text must be escaped before it enters a prompt. Wave learner replies and custom instructions pass through `sanitiseUserInput`. Scoping input is escaped by `escapeXmlText` inside `renderStageEnvelope`, without the wrapper (see `src/lib/course/clarify.ts`).

- `sanitiseUserInput.ts`: HTML-encode `&`, `<`, `>` (in that order — `&` first to prevent double-decode resurrection), wrap in `<user_message>…</user_message>`. Pure.
- `escapeXmlText.ts`: the encoding alone, no wrapper. Use it for text whose tag the prompt author fixes (topic, framework JSON, concept names).
- The teaching system prompt instructs the model to treat user-envelope contents as learner input, not directives. The scoping system prompt carries no such instruction (issue #98).
- If you add a new prompt entry point, route untrusted input here first.
- `obfuscateCorrect.ts`: Casual base64 obfuscation of MC correct-index, bound to `questionId`. NOT cryptographic. Used by the Wave MC instant-feedback path; client decodes locally for the answer-card feedback and XP badge, server re-derives correctness independently.
