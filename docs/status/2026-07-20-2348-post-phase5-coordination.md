# Post-Phase-5 coordination — backlog triaged, all PRs merged; NEXT: pick from TODO.md session backlog

Self-contained handoff for a COORDINATING session: nothing is in flight, main is current, the next work is a fresh pick from a triaged backlog.

## Task Overview

The AI SDK modernization (Phases 1-5) is COMPLETE and merged. This session's arc: merged PR #37 (Phase 5 hygiene+observability), #39 (`reasoning_effort: high`), #40 (Composer ungraded-MC neutral feedback), #41 (TODO.md backlog). Success criteria for the next session: pick one backlog item (Ollie chooses), run it with the subagent-driven flow described below, land it via PR. **HARD RULE: only Ollie merges to main — stop at green CI + PR link.**

## Reference Docs

- `TODO.md` — "Session backlog (2026-07-20)" section (bottom of file): the four candidate next tasks with full context baked in. This is the primary work queue.
- `TODO.md` — "Deferred findings from CodeRabbit CLI review (2026-07-18)" section (just above): 9 triaged pre-existing findings; the scoping-wire-grading-keys item needs a product decision from Ollie before any code.
- `docs/status/2026-07-16-provider-strategy.md` — provider/gateway decision inputs + trigger conditions (read only if provider work comes up).

## Current State

All merged to main (worktree detached at `6e018a7` = PR #41 merge, tree clean except this file):

- **#37 Phase 5**: dead XML layer deleted, `ValidationGateFailure` → `src/lib/turn/`, OTel spans (`LLM_TELEMETRY=true` gate, `recordInputs/Outputs` pinned false, NO OTLP endpoint yet), DevTools capture (`just dev-devtools` / `just llm-devtools`, double-gated dev-only), Turn/Step/ChatEntry nomenclature, provider strategy note, `freetextRubric` stripped from wave client wire, `containsResponseJsonBlob` fails closed >20k.
- **#39**: `LLM.reasoningEffort: "high"` in tuning.ts, sent on every call via `llmProviderOptions()` (`src/lib/llm/provider.ts`, key `"nalu-llm"` — the openai-compatible adapter maps it to `reasoning_effort`; verified live, 102 reasoning tokens on a trivial prompt). Root cause it fixed: 2026-07-18 Japanese course showed medium-effort constraint failures (3-attempt baseline, tier-scope violation, relabel-not-rethink).
- **#40**: `deriveMcFeedback()` pure three-state helper in `adaptQuestionnaire.ts`; Composer no longer marks ungraded (preference) MC selections wrong. Built via spec-brief → Opus implementer subagent → controller-verified `just check` → blind Opus task reviewer (double PASS).
- Local hygiene done: stale merged branches deleted, main checkout (`~/code/nalu`) fast-forwarded, remote refs pruned. Other worktrees `ui-fixes-reference-merge` + `visitor-forensics` (locked) belong to other work — do not touch.

## Important Discoveries

1. **Subagent flow that worked (repeat it)**: write a self-contained task brief to scratchpad (contract + TDD order + scope discipline + report format + commit trailer), dispatch Opus implementer via Agent tool IN THIS WORKTREE (no cd — the branches-not-worktrees memory is about not making subagents cd elsewhere), controller re-runs `just check` locally, then blind Opus task reviewer with diff file + brief, fix loop if findings, then push + PR. Ollie explicitly wants reviews at every completion point, using superpowers skills when he says so.
2. **fugu-review skill now has CLI lanes**: `cli_reviewers: true` in the Workflow args adds CodeRabbit/Codex (and now gemini — Ollie extended it) CLI reviewers as extra blind lanes. Use for implementation reviews only (needs a git diff). The CodeRabbit CLI lane found the freetextRubric leak that 4 model reviewers missed — it earns its keep.
3. **CodeRabbit bot skips PRs >50 files**; the local CLI (`coderabbit review --agent --type committed --base main`, ~10 min) covers the gap. **Codex CLI**: free-tier quota exhausted until ~Jul 25; config fixed (model pin removed, CLI upgraded via `bun install -g @openai/codex` — brew formula is stale).
4. **DB forensics**: `debugging-nalu-llm-pipeline` skill's `inspect-db.ts` / `dump-chat.ts` read prod. The 2026-07-20 transformers course (`e53a2d2b-…`) proved the Composer bug was client-side — always check the DB emission before blaming the model.
5. **`gh pr update-branch <n>`** resolves the "merge without waiting" button — never bypass; repo requires branches current with main.

## Next Steps (Ollie picks; suggested priority)

0. **PR #38 (`feat(skills): visitor forensics skill`, branch `feat/visitor-forensics`) is awaiting Ollie's merge.** It was BEHIND main (never conflicted); this session ran `gh pr update-branch 38` (server-side merge of main, 2026-07-20) and CI was re-running at handoff time — verify green (`gh pr checks 38`), then Ollie merges. AFTER merge: the LOCKED worktree `.claude/worktrees/visitor-forensics` still has the pre-update branch checked out — whoever owns that worktree should `git pull` there (or remove the worktree once merged); do NOT push from it without pulling first (non-ff).

1. **OTLP endpoint + `LLM_TELEMETRY=true` in Vercel env** — highest value: `reasoning_effort: high` latency is the live open question and spans currently export nowhere. Pick Axiom or Grafana Cloud via Vercel OTel drain.
2. **TODO.md → public GitHub Issues** — Ollie has NOT yet said yes; recommendation (public issues; TODO.md is already public; private GH Project only if needed later) is recorded in TODO.md. Get the yes, then migrate mechanically.
3. **Streaming-renders-incrementally check** via `just dev-devtools` (docs/TODO.md item).
4. **Cosmetic**: neutral freeze color for confirmed ungraded MC selections (PR #40 reviewer Minor 2).

Where work stopped — most recent exchange, verbatim:

> **User**: "merged, branch deleted, will you sync local. What do we need to do next?"
>
> **Assistant**: "Synced — worktree detached at `6e018a7` (the #41 merge), `chore/todo-backlog` deleted, remote pruned, and the main checkout fast-forwarded too. Everything from this session is on main; nothing is in flight. … **Recommend `/clear`** — all threads are closed and the next task is a fresh start."
>
> **User**: "/handoff remember what's needed for picking up the next tasks as a coordinating agent"

## Context to Preserve

- **Never bypass git hooks** (no `--no-verify`, no `HUSKY=0`). **bun not npm.** Commit subjects lowercase. Trailer for THIS session's commits was `Claude-Session: https://claude.ai/code/session_01F87wUziAM8oFNx2RhHUzDm` — a new session uses its own.
- **Never echo secret values**; `.env.local` names only (`rg -o '^[A-Z_]+=' .env.local`). Cerebras key shared with Ollie's STT work; paid tier — constraint is token cost + latency, not RPM.
- Security invariants (verbatim from prior handoffs): questionnaire `correct`/`freetextRubric` never reach the client pre-submission — the wave flow now enforces this on FOUR surfaces (stream allowlist, dropped `tool-input-delta`, text-channel leak guard, static-wire `redactWaveChatLog`); preserve all four. NOTE: the SCOPING wire still ships plaintext `correct` + rubric by design (instant feedback) — product decision pending, in TODO.md. Lookup tools stay read-only capped projections with courseId from closure; LLM never sees XP; `recordInputs/recordOutputs` stay false in `llmTelemetry`; DevTools stays double-gated dev-only.
- Ollie is PM-learner: outcome-first summaries, plain language, teach when asked. He wants specs + subagents for implementation work and reviews throughout (superpowers patterns when he invokes them).
- Watch item promised to Ollie: if wave mid-turn latency degrades under `reasoningEffort: "high"`, the fallback is `"medium"` or per-stage split — one line in `tuning.ts`.
- This worktree (`refactor+ai-sdk-output-object`) is disposable after this handoff merges; remove from the main checkout when convenient.

## Restart Hint

Tree clean, everything merged; safe to /clear. Resume: read this file + TODO.md "Session backlog (2026-07-20)", ask Ollie which item, then spec → subagent → review → PR.
