# src/lib/security

All user-supplied text must pass through `sanitiseUserInput` before entering a prompt. No exceptions.

- `sanitiseUserInput.ts`: HTML-encode `&`, `<`, `>` (in that order — `&` first to prevent double-decode resurrection), wrap in `<user_message>…</user_message>`. Pure.
- System prompts instruct the model to treat `<user_message>` contents as data, not directives.
- If you add a new prompt entry point, route untrusted input here first.
