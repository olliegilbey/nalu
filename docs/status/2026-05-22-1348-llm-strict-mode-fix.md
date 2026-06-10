# Status: LLM strict-mode fix — ready for subagent-driven execution

Branch: `chore/nalu-debug-skill` (do NOT branch off — see Context).

## Task Overview

Wire Cerebras strict-mode JSON-schema constrained decoding so structured LLM
turns send their schema to the provider as a real
`response_format: {type:"json_schema", strict:true}` payload. Currently the
schema never reaches the wire: every structured turn flies blind on attempt 1,
fails Zod, and recovers via the retry directive on attempt 2 — a guaranteed
retry tax confirmed in the production DB.

This is the last of three changes on branch `chore/nalu-debug-skill`, all
shipping as ONE PR (debugging skill + `conceptName` 500 fix + this strict-mode
fix). Earlier two are committed; see @docs/status/2026-05-22-1247-llm-strict-mode-fix.md
for what those commits did.

**Brainstorming + planning are DONE this session.** A spec and a full
implementation plan now exist. The next session is the coordinating PARENT
agent: execute the plan task-by-task via subagent-driven-development (the user
explicitly chose subagent-driven execution over inline).

Success criterion: structured LLM calls send the schema as a real strict
`response_format`; `executeTurn`'s parse/validate/retry loop is unchanged;
verified live.

## Reference Docs

- **`docs/superpowers/plans/2026-05-22-llm-strict-mode-fix.md`** — THE actionable
  plan. 5 tasks, every step has complete code + exact commands. Read it fully;
  it is self-contained. NOTE: this file is UNTRACKED (not committed yet).
- `docs/superpowers/specs/2026-05-22-llm-strict-mode-design.md` — design spec
  (committed, `3ee4fad`). Background/rationale only — the plan supersedes it for
  execution. Read if a subagent needs the "why" behind an approach.

## Current State

`git status`: `M .claude/settings.json` (pre-existing 1-line deletion, NOT from
this work — leave it), `?? docs/status/` (untracked dir — status files live
here), `?? docs/superpowers/plans/2026-05-22-llm-strict-mode-fix.md` (the plan,
uncommitted).

Done this session:

- Brainstormed the approach (A vs B vs C — see Important Discoveries).
- Wrote + committed the spec: `3ee4fad docs: add strict-mode wiring fix design spec`.
- Wrote the implementation plan (uncommitted).

NO code changes yet. The 4 prior commits on the branch (`0c36c47`, `e3d43ee`,
`5957ed8`, `604272e`) are the debugging skill + conceptName fix — already done.

Files the plan will touch (none touched yet): `src/lib/llm/generate.ts`,
`src/lib/llm/toCerebrasJsonSchema.ts`, `src/lib/llm/generate.test.ts` (rewrite),
`src/lib/llm/toCerebrasJsonSchema.test.ts` (add test), `src/lib/llm/CLAUDE.md`.

## Important Discoveries

All of this is already baked into the plan/spec — listed here so the next
session does NOT re-investigate.

### Approach chosen: B2 — `wrapLanguageModel` + `transformParams` middleware

`generateChat` wraps the model with a one-shot middleware that sets
`callOptions.responseFormat`. `generateText` is called with NO `output` param,
so it returns raw `.text` and `executeTurn` is untouched.

**Rejected — A (`output: Output.object`):** the docs-blessed path, but it makes
`generateText` parse `.text` and throw `NoObjectGeneratedError`, colliding with
`executeTurn`'s deliberately-owned parse/validate/retry-with-directive loop.
Using `Output.object` only for its `responseFormat` side effect and catching its
main feature as control flow is abstraction misuse.

**Rejected — C (provider-specific `providerOptions` body passthrough):** the
`@ai-sdk/openai-compatible` provider already translates `callOptions.responseFormat`
into the exact Cerebras envelope (`dist/index.mjs:517-523`, `strictJsonSchema`
defaults `true`). C would hand-reimplement that translation. No gain.

### Verified facts (do not re-check)

- AI SDK v6 `generateText` silently drops a top-level `responseFormat` arg — it
  only sets `callOptions.responseFormat` from `output`. That is the root bug.
- `LanguageModelV3CallOptions.responseFormat` json variant is
  `{type:"json"; schema?:JSONSchema7; name?:string; description?:string}` —
  `toCerebrasJsonSchema`'s return shape already matches it (just retype
  `.schema` from `Record<string,unknown>` to `JSONSchema7`).
- `LanguageModelV3Middleware.specificationVersion: "v3"` is REQUIRED — the inline
  middleware object must include it.
- Zod v4 `z.toJSONSchema(z.object(...), {target:"draft-7"})` already emits
  `additionalProperties:false` on every object + root `type:"object"`, and
  INLINES reused sub-schemas (no `$ref`/`$defs`/`$anchor`). Verified empirically.
  So `toCerebrasJsonSchema` needs NO new transform for Cerebras strict validity.
- `LlmModel = LanguageModel` (from `ai`) is wider than `wrapLanguageModel` needs
  (`LanguageModelV3`). The plan uses a single justified `as LanguageModelV3` cast
  in `generate.ts` rather than narrowing `LlmModel` in `types/llm.ts`.
- `JSONSchema7` is re-exported by `ai`; `LanguageModelV3` is NOT — import it from
  `@ai-sdk/provider`.
- `MockLanguageModelV3` (from `ai/test`) exposes `doGenerateCalls:
LanguageModelV3CallOptions[]` — the plan's `generate.test.ts` rewrite asserts
  on that to verify the schema reaches the wire in-process. `doGenerate` result
  shape is in the plan (copied from `node_modules/ai/docs/03-ai-sdk-core/55-testing.mdx`).
- `vercel/ai#8475` ("Cerebras Unsupported response_format") does NOT affect us —
  it concerns the `@ai-sdk/cerebras` first-party provider; Nalu uses generic
  `@ai-sdk/openai-compatible` with `supportsStructuredOutputs: true` already set.
- Cerebras strict mode IS genuine token-level constrained decoding ("invalid
  outputs impossible"). The memory `cerebras_strict_mode_not_enforced` is STALE
  (written under the broken state) — worth updating after this lands.

### Scope decision (user)

Minimal wiring fix only. The vestigial `honorsStrictMode` gate, inline
`<response_schema>` path, and `modelCapabilities` registry are LEFT IN PLACE;
a follow-up GitHub issue (body drafted in plan Task 5) tears them out later.

## Next Steps

In priority order:

1. **(Optional, user's call) Commit the plan doc.** It is untracked. The user
   was asked "commit the plan doc now, or fold it into Task 1's commit?" and has
   not answered — they asked to wrap-up first. Resolve this before/with Task 1.
2. **Execute the plan via subagent-driven-development.** Invoke the
   `superpowers:subagent-driven-development` skill. Dispatch a fresh subagent per
   task (5 tasks), review between tasks. The plan's tasks are TDD, each ends in a
   commit. Use Opus 4.7 for subagents.
3. **Task 5** ends with: local checks, user-run live verification (`just smoke`,
   `just probe-model gpt-oss-120b` — Touch ID, user runs these), the follow-up
   GH issue, and the combined PR. The GH issue and PR are outward-facing —
   confirm with the user before `gh issue create` / `gh pr create`.

Where work stopped — the user's most recent message, verbatim:

> "subagent, but first, we need to /wrap-up context to capture everything we've
> done and retain all context needed for the coordinating parent agent to
> continue in a fresh session."

So: the user chose subagent-driven execution; this wrap-up is the last step
before /clear. Next session resumes at Next Step 1.

## Context to Preserve

- **No em-dashes** in code/comment string literals (and rendered strings) — use
  colon/hyphen/period. Standing user preference.
- **TDD** for the implementation tasks: failing test first, watch it fail,
  implement, watch it pass. The plan's Task 2 is structured this way.
- **Never bypass git hooks** (`--no-verify`, `HUSKY=0`, hook deletion all
  forbidden). Pre-commit runs secrets/format/lint/typecheck/unit-tests (~38s).
- **Ask before commits / PRs / GH issues.** Conventional commits. Match existing
  code style.
- **Subagents: Opus 4.7, branches not worktrees** — check out the impl branch
  directly in the main repo (here, already on `chore/nalu-debug-skill`).
- **Subagent TDD + local verify:** implementers do red→green TDD; the controller
  verifies green LOCALLY, never defers to CI.
- **Simplification bias:** actively look for collapse opportunities at impl time.
- **knip:** fix or narrowly justify, never blanket-ignore.
- `just smoke` / `just dev` / `just probe-model` use `op run` + Touch ID — they
  hang for an AFK user. The USER runs all live verification.
- `just check` includes `test-int` (Docker, unavailable locally) — per-task use
  `just lint && just typecheck && just test`; CI runs the full gate.
- **Security:** `.env.local`'s `DATABASE_URL` is the PRODUCTION Supabase. Never
  echo secret values; never pipe `.env.local` through a redaction `sed`.

## Restart Hint

No code changes, tests green, safe to /clear. Resume on `chore/nalu-debug-skill`
(do NOT branch off). The plan doc is untracked — decide whether to commit it
(Next Step 1), then run subagent-driven-development on the 5-task plan.
