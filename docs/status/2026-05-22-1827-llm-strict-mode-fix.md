# Status: Cerebras strict-mode wiring — `allOf` fix still open (PR #24)

Branch: `chore/nalu-debug-skill` (do NOT branch off). PR: **#24**, open.
HEAD: `e6c3565`. Working tree clean, all work pushed.

## Task Overview

PR #24 bundles three changes from one debugging thread, shipping as ONE PR
(fewer PRs = less CodeRabbit rate-limit pressure):

1. LLM-pipeline debugging skill (`.claude/skills/debugging-nalu-llm-pipeline/`).
2. Wave `conceptName` 500 fix.
3. **Cerebras strict-mode wiring** — the active, blocked work.

The strict-mode wiring (a 5-task plan) was implemented, reviewed, and CI-green.
Then the user tested the PR #24 Vercel preview and hit a 500 on `course.clarify`.
Root cause: **the strict-mode `response_format` Nalu now sends contains JSON
Schema keywords Cerebras strict mode rejects with HTTP 400.** Two found:

- `oneOf` — **FIXED** (`e6c3565`).
- `allOf` — **NOT FIXED. This is the one open task.**

**Success criterion:** every structured LLM call (`course.clarify`,
`generateFramework`, `submitBaseline`, wave mid + close) succeeds against live
Cerebras with the strict `response_format`; `just smoke` passes (a 429 capacity
blip on the heavy wave test is acceptable); PR #24 mergeable.

## Reference Docs

- `docs/superpowers/plans/2026-05-22-llm-strict-mode-fix.md` — the original
  5-task plan (executed; commits `8b61233`..`3ac3401`).
- `docs/superpowers/specs/2026-05-22-llm-strict-mode-design.md` — design spec.
- `.claude/skills/debugging-nalu-llm-pipeline/SKILL.md` — the debugging playbook;
  use it (+ `inspect-db.ts`) for any further hosted-failure debugging.
- @docs/status/2026-05-22-1348-llm-strict-mode-fix.md — pre-implementation
  handoff (plan/spec rationale, the original "why" behind the wiring approach).

**The plan/spec contain a now-DISPROVEN assumption:** they state
`z.toJSONSchema` output is Cerebras-strict-valid as-is and `toCerebrasJsonSchema`
needs "NO new transform". That is WRONG — see Important Discoveries.

## Current State

Branch `chore/nalu-debug-skill`, pushed, HEAD `e6c3565`. `git status`: clean
except untracked `docs/status/*.md` (status files, harmless). `git diff HEAD`:
empty. **All work is committed.**

Commit history on the branch (atop `main` `2bfc40b`):

- `a79317a` `7a56874` `4358850` `ab3bb16` — debugging skill + conceptName 500 fix
- `d67e7ae` `7190c17` — strict-mode spec + plan docs
- `8b61233` `fb54fac` `5fb2d8e` `21eaf2e` `3ac3401` — strict-mode plan Tasks 1-5
- `6bd314c` — knip CI fix (`@ai-sdk/provider` dep + `inspect-db.ts` knip entry)
- `c61b7c7` — PR review feedback (CodeRabbit + Codex), all 8 threads resolved
- `e6c3565` — **`oneOf`→`anyOf` fix** (this session)

CI is **GREEN** on `e6c3565` (`Check` + `Commitlint` pass). NOTE: CI mocks the
LLM, so it CANNOT catch Cerebras strict-mode rejections — `just smoke` / the
preview are the only real verification.

The Vercel preview deploy for `e6c3565` **FAILED** (`dpl_EyspTpB3q1xa2VfjvZHHkucQVZbi`)
— not yet investigated. Earlier commits' previews succeeded.

`just smoke` result on `e6c3565`: **3/5 live tests pass.** The `oneOf` fix works.
2 failures: the `allOf` 400 (open task) and a 429 TPM (capacity, not a bug).

## Important Discoveries

### THE OPEN TASK: Cerebras rejects `allOf`

Exact Cerebras error (HTTP 400):

```
{"message":"Extra top level keys found in JSON schema: {'allOf'}.","type":"invalid_request_error","param":"response_format","code":"wrong_api_format"}
```

- **Source:** `src/lib/prompts/waveClose.ts:33` and `src/lib/prompts/scopingClose.ts:19`
  both build their schema as `makeCloseTurnBaseSchema(params).and(z.object({…}).superRefine(…))`.
  `base.and(extra)` → `z.intersection` → `z.toJSONSchema` emits `{ allOf: [base, extra] }`.
- **Why `.and()` and not `.extend()`:** `makeCloseTurnBaseSchema`
  (`src/lib/prompts/closeTurn.ts:112-202`) returns `z.object({…}).superRefine(…)`
  — a _refined_ schema (ZodEffects). Zod v4 does NOT allow `.extend()` on a
  refined schema, only on a plain `ZodObject`. Hence `.and()`.
- **User-approved fix direction:** flatten `allOf` inside
  `toCerebrasJsonSchema.ts`'s `cleanForCerebras` function — merge the intersected
  object schemas into ONE flat object (`properties` combined, `required` unioned,
  `type:"object"`, `additionalProperties:false`). Same central place as the
  `oneOf` rewrite. Does NOT require the risky refactor of the shared refined base.
  For Nalu, every `allOf` is `[objectWithProps, objectWithProps]` with disjoint
  properties, so a plain merge is safe; do not over-engineer for impossible cases.

### Cerebras strict-mode incompatibilities (the recurring theme)

The plan assumed `z.toJSONSchema` output was strict-valid. THREE incompatibilities
have surfaced; `toCerebrasJsonSchema` is effectively now the Cerebras-strict-compat
transform layer:

1. **5000-char schema budget** — handled in Task 3 (`waveMidTurnSchema` describes
   trimmed, `5fb2d8e`). `toCerebrasJsonSchema` throws over `MAX_CHARS`.
2. **`oneOf`** — Cerebras 400 `wrong_api_format`,
   `"Unsupported JSON schema fields in schema with keys: dict_keys(['oneOf'])."`.
   `z.discriminatedUnion` (e.g. `questionSchema`) → `oneOf`. **FIXED** in `e6c3565`:
   `cleanForCerebras` rewrites `oneOf`→`anyOf` (exact: discriminated-union branches
   have a literal discriminator, so mutually exclusive either way).
3. **`allOf`** — see above. OPEN.

### `toCerebrasJsonSchema.ts` current shape (post-`oneOf`-fix)

- `cleanForCerebras(node)` (~line 153) — recursive: drops `FORBIDDEN_KEYWORDS`
  (line 12: `$schema`, `minItems`, `maxItems`, `pattern`, `minLength`, `maxLength`,
  `minimum`, `maximum`, `exclusiveMinimum`, `exclusiveMaximum`, `format`, `$ref`),
  and renames `oneOf`→`anyOf`. **Add `allOf` flattening here.**
- `MAX_CHARS = 5000`, `MAX_DEPTH = 10` (Cerebras documented limits, verified
  against https://inference-docs.cerebras.ai/capabilities/structured-outputs —
  these are universal, NOT model-dependent).

### The guard test has gaps

`src/lib/llm/toCerebrasJsonSchema.test.ts` `assertCerebrasStrictValid` (~line 203)
checks `$ref`/`$defs`/`$anchor`/`oneOf` + `additionalProperties` + object root. It
must ALSO forbid `allOf`. Critically, its `it.each` (~line 227) covers
`clarify`/`framework`/`waveMidTurnSchema` only — NOT the close schemas
(`makeWaveCloseSchema`/`makeScopingCloseSchema`), which is exactly where `allOf`
lives. The next agent MUST add close-schema coverage (they are factory functions
needing params — build minimal fixtures; the plan deliberately skipped them and
that is precisely why `allOf` shipped undetected).

### Diagnostic methods that worked (reuse these)

- `debugging-nalu-llm-pipeline` skill + `bun .claude/skills/debugging-nalu-llm-pipeline/inspect-db.ts --minutes 60`
  confirmed transport failure (`msgs=0` on the failed scoping passes).
- `just probe-model gpt-oss-120b` proved `gpt-oss-120b` strict mode WORKS for
  simple flat schemas (so the model is fine; the SCHEMA shape is the problem).
- To capture an exact Cerebras error for a specific schema: temporarily add a
  probe block to `scripts/probe-model.ts` that calls `generateChat` with the real
  schema (`clarifySchema` etc.), `modelName: model`, and prints
  `err.responseBody` / `err.statusCode`; run `just probe-model gpt-oss-120b`;
  revert. (Done this session for `oneOf`, reverted.)
- `just smoke` runs the live test suite end to end — best full verification.

### Other findings

- **`just smoke` no longer needs `op`/1Password** (user changed it 2026-05-22).
  Runs fully unattended, no Touch ID. `just probe-model` and `just dev` still
  need `op`/Touch ID. (Memory updated this session.)
- `just smoke` needs **Docker** (Postgres testcontainer) — the user must have
  Docker Desktop running, else the live suite skips with
  "Could not find a working container runtime".
- `just smoke` hit a **429 "Tokens per minute limit exceeded"** on the heavy wave
  test — the 30k TPM Cerebras free-tier cap. Capacity, NOT a code bug; the wave
  live test is inherently flaky under the free tier. Re-run if it 429s.
- The Splash.tsx "systemthat" thing the user reported is **NOT a bug** —
  investigated; `Splash.tsx:37` `</strong> that` already renders a space.
  Prettier collapsed an attempted `{" "}` change to an empty diff, confirming
  equivalence. No fix needed; if seen rendered joined, it was a stale deploy.
- **1Password commit signing is flaky** — `git commit` intermittently fails with
  `error: 1Password: failed to fill whole buffer` / `failed to write commit
object`. Pre-commit checks pass; only the signing step fails. Retry, or ask the
  user to unlock the 1Password app.

### Failed approaches (do not repeat)

- Adding `{" "}` to `Splash.tsx` — prettier reverts it; it was a non-bug.
- Running `just smoke` while it still op-wrapped — timed out twice on 1Password
  authorization. (Now moot: `just smoke` is op-free.)

## Next Steps

In priority order:

1. **Implement the `allOf` flatten in `src/lib/llm/toCerebrasJsonSchema.ts`.** TDD
   (it is a pure function — project norm is red→green):
   - RED: extend `assertCerebrasStrictValid` (`toCerebrasJsonSchema.test.ts` ~203)
     to also forbid `allOf`; add `makeWaveCloseSchema` + `makeScopingCloseSchema`
     to the guard `it.each` (~227) with minimal param fixtures; add a focused unit
     test (a `base.and(extra)` schema → output has no `allOf`, properties merged).
     Run `bunx vitest run src/lib/llm/toCerebrasJsonSchema.test.ts` — confirm RED.
   - GREEN: in `cleanForCerebras`, when a node has `allOf` that is an array of
     object-schemas, merge them into the node (combine `properties`, union
     `required`, set `type:"object"` + `additionalProperties:false`, drop
     `allOf`). Re-run — confirm GREEN. `just typecheck`. `bun run deadcode` (knip).
2. **Re-run `just smoke`** — verify the live tests pass. A 429 on the wave test is
   acceptable (re-run). Watch for a possible FOURTH incompatibility (if Cerebras
   400s again on another keyword, repeat the diagnose→fix loop).
3. **Investigate the failed Vercel preview deploy** for `e6c3565`:
   `npx vercel inspect dpl_EyspTpB3q1xa2VfjvZHHkucQVZbi --logs`, or the Vercel
   dashboard. May be unrelated/transient.
4. **Commit + push the `allOf` fix** (ask the user first — conventional commit,
   e.g. `fix(llm): flatten allOf for Cerebras strict-mode response_format`).
5. Final authentic verification: once the preview redeploys, retry the
   "cooking for dummies" scoping flow on the PR #24 preview UI.
6. When `just smoke` is green and the preview works → PR #24 is mergeable.

Where work stopped — the user's most recent message, VERBATIM:

> "yeah, but we need a complete output to the /wrap-up to allow a fresh agent to
> take over. Store everything helpful in its entirety in the wrap-up"

This followed the assistant asking, verbatim: "Shall I implement the `allOf`
flatten?" — so the `allOf` flatten is APPROVED; the user wants a fresh session to
do it. Next session resumes at Next Step 1.

## Context to Preserve

- **No em-dashes** in code/comment/user-facing string literals — colon/hyphen/period.
- **TDD** for pure functions (`toCerebrasJsonSchema` is pure): red→green.
- **Never bypass git hooks** (`--no-verify`, `HUSKY=0` forbidden). Pre-commit runs
  secrets/format/lint/typecheck/unit-tests (~30s). knip (`deadcode`) is CI-only,
  not pre-commit — run `bun run deadcode` locally before pushing.
- **Ask before commits / PRs / pushes / force-push.** Conventional commits. Match
  existing code style. knip: fix or narrowly justify, never blanket-ignore.
- **`just smoke` is op-free and unattended** — use it freely for live verification.
  `just probe-model` / `just dev` still need `op` + Touch ID (user runs those, or
  must be present).
- **Per-task local checks:** `just lint && just typecheck && just test`. Note
  repo-wide `just lint` reports ~1982 errors — ALL from the gitignored 1.1GB
  `.claude/worktrees/` dir; CI's fresh checkout is clean. Lint only the changed
  files: `bunx eslint <files>`.
- **Security:** `.env.local`'s `DATABASE_URL` is the PRODUCTION Supabase (pooled
  PgBouncer). `inspect-db.ts` is read-only (SELECT only) by design. Never echo
  secret values; never pipe `.env.local` through a redaction `sed`.
- **Cerebras free tier:** 5 RPM / 30k TPM / 1M TPD. Heavy `just smoke` runs WILL
  hit 429s — capacity, not bugs. The API key is shared with the user's STT work.
- The PR #24 description already covers all three bundled changes; all 8 CodeRabbit
  - Codex review comments are addressed and their threads resolved (`c61b7c7`).
- The stale memory `cerebras_strict_mode_not_enforced` should be revisited once
  strict mode demonstrably works end to end — `gpt-oss-120b` DOES honour strict
  mode (probe-verified this session); the constraint is schema-shape, not the model.

## Restart Hint

All work committed + pushed (`e6c3565`); working tree clean; CI green. Safe to
/clear. Resume on `chore/nalu-debug-skill` (do NOT branch off): implement the
`allOf` flatten in `toCerebrasJsonSchema.ts` (Next Step 1), then `just smoke`.
