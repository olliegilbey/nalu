# AI SDK modernization — Phase 2 (streaming wave turns), Task 8 done, Task 9 next

## Task Overview

Implement the full five-phase AI SDK modernization plan sequence in `docs/superpowers/plans/` (dated 2026-06-10), phase by phase, each as its own branch + PR to `main`. All five plans are reviewed and approved as-is — do not re-litigate their decisions. Ollie authorized "get it all in": implement and land all phases, merging own PRs when CI is green.

- Phase 1 `2026-06-10-ai-sdk-output-object.md` — **DONE**, merged as PR #31 (main @ 2b9be6e).
- Phase 2 `2026-06-10-streaming-wave-turns.md` — **IN PROGRESS**, this handoff.
- Phase 3 `2026-06-10-tool-calling-turn-actions.md`, Phase 4 `2026-06-10-agent-loop-scoping.md`, Phase 5 `2026-06-10-llm-hygiene-observability.md` — pending, in that order, each cut off main after the prior merges.

**Signing constraint**: Ollie is AFK and commits need his signature. Work continues UNCOMMITTED; the commit plan lives in @docs/status/2026-07-04-phase2-commit-ledger.md (read it — it is the authoritative ledger of pending commits A/B, messages included, plus the pre-PR checklist).

Session task list (harness): #1 Phase 2 in_progress, #2–#4 Phases 3–5 pending.

## Reference Docs

- `docs/superpowers/plans/2026-06-10-streaming-wave-turns.md` — the Phase 2 plan. Tasks 1–8 done. Remaining: Task 8 Step 4 (manual verification, lines ~1215–1218), Task 9 (docs/TODO/smoke/PR, lines 1231–1242), self-review checklist (lines 1245–1253).
- @docs/status/2026-07-04-phase2-commit-ledger.md — pending-commit ledger (commit messages, file lists, dependency-pin rationale). Update it as work proceeds; delete or commit it at PR time.
- `docs/superpowers/plans/2026-06-10-tool-calling-turn-actions.md` — read in full before starting Phase 3.

## Current State

Branch `feat/streaming-wave-turns` (worktree `/Users/olliegilbey/code/nalu/.claude/worktrees/refactor+ai-sdk-output-object` — do not cd out; git stash is shared with other sessions, avoid bare stash).

**Committed (signed), Tasks 1–7**: d021248, 2078453, 632f3c2, fb49331, dfe29e4, beb9e9d, 4c353e8 — spike test pinning streamText+Output.object semantics; `src/lib/llm/streamChat.ts`; `src/lib/turn/contextAssembly.ts`; `src/lib/turn/executeTurnStream.ts`; `src/lib/course/{prepareWaveTurn,persistWaveMidTurn}.ts` split; `src/lib/course/streamWaveTurn.ts` + `src/lib/types/waveStream.ts`; route `src/app/api/course/[courseId]/wave/[waveNumber]/turn/route.ts` + `src/server/requestUser.ts` + `src/server/routers/waveTurnInput.ts`.

**Uncommitted (= pending commit A, Task 8)**: `package.json` + `bun.lock` (`@ai-sdk/react@3.0.160`), `src/hooks/useWaveState.ts` (rework onto useChat), `src/hooks/useWaveState.test.tsx` (rewritten, 10/10), `src/components/chat/WaveSession.tsx` (streaming bubble), plus untracked ledger file.

**Verification state**: typecheck clean, lint 0 errors (13 warnings, all legitimate boundary exceptions), full unit suite green, course integration suite green (needs Docker running — `open -a Docker` if down). Live smoke NOT yet run for Phase 2.

## Important Discoveries

1. **`@ai-sdk/react` version pairing (the big one)**: 4.x hard-depends on `ai@7`; mismatched 3.x pulls a nested second `ai` copy under `node_modules/@ai-sdk/react/node_modules/ai`, which makes `InferUIMessageData<WaveTurnUIMessage>` fall back to `Record<string, unknown>` (symptom: `part.data` is `unknown` in `onData`) and risks server/client stream-protocol drift. Fix: `@ai-sdk/react@3.0.160` pairs exactly with `ai@6.0.158`. Map: react `3.0.N` ↔ ai `6.0.(N-2)`. Never "bun add @ai-sdk/react" unpinned.
2. **Hybrid client model** (plan decision 1): `useChat` owns ONLY the in-flight turn; committed turns render from `wave.getState` → `deriveWaveTurns`. `onFinish` invalidates the query then clears `chat.setMessages([])`. Optimistic user bubble stays WaveSession-owned; the useChat user message is never rendered.
3. **Per-call questionnaire onError**: `useChat`'s onError is chat-level; `sendMessage`'s promise does NOT reject on stream errors. Solution: `questionnaireErrorRef` in `useWaveState` set before sendMessage, consumed once in onError, cleared in onFinish.
4. `result.output` on `streamText` is `PromiseLike` (no `.catch`) — pre-register rejection handling with `.then(undefined, () => undefined)` (done in `streamChat.ts`).
5. `LanguageModelUsage` requires `inputTokenDetails`/`outputTokenDetails` sub-objects; `FinishReason` is a plain string union — test fixtures need the full shape.
6. Integration tests skip-all + exit 1 when Docker is down. `open -a Docker`, wait for daemon, re-run.
7. Commit trailer must be exactly `Claude-Session: https://claude.ai/code/session_01RaZinbh9BsfTdrtX1hWuJ8` (one earlier commit was amended twice for a typo — verify with `git log --format='%B' -1 | grep Claude-Session` after committing).
8. One transient `fatal: failed to write commit object` occurred; plain retry succeeded.
9. Phase 1 fallout handled in Phase 1 (already merged): capability gate removal broke `scripts/probe-model.ts` not `executeTurn.ts`; `formatResponseBlock` usage param widened to `LlmUsage | undefined`.

## Next Steps

1. **Task 9 Step 1–2**: update `src/lib/course/CLAUDE.md` + `src/server/routers/CLAUDE.md` (dual transport: tRPC keeps state/queries + blocking submitTurn as rollback; streaming route is the client's turn dispatch; `prepareWaveTurn`/`persistWaveMidTurn` shared spine). Append TODO.md streaming follow-ups (exact text in plan lines 1237–1239). These files = pending commit B in the ledger.
2. **Task 8 Step 4 manual verification**: `just dev`, open a course with an active wave, submit a turn, watch prose stream. Chrome automation tools are available if Ollie still AFK. Client sends `x-dev-user-id` in dev? — verify how the dev stub header is injected client-side; the streaming fetch may need the same header the tRPC client sends (check `src/lib/trpc` client setup; if tRPC adds the header via a link, `DefaultChatTransport` may need `headers: { "x-dev-user-id": ... }`). THIS IS AN UNVERIFIED RISK — the route 401s without a resolvable user.
3. `just check` + `just smoke` (blocking scoping path must be unaffected; ≈$0.06).
4. Self-review checklist (plan lines 1245–1253).
5. When Ollie is back: sign commits A and B per the ledger, push, PR `feat/streaming-wave-turns` → main (body per Phase 1's PR pattern, include session link), merge on green CI.
6. Phase 3: `git checkout -b <branch per plan> origin/main` after merge; read the whole plan first; same execution discipline (verify SDK claims against installed source, TDD, green between tasks).

Where work stopped — most recent exchange, verbatim:

> **User**: "keep it going, I am afk, so trust you to execute, I can't sign committed for you though, so you'll need to work without committing right now for a bit. make notes of what you will commit when I'm back and can sign"
>
> **Assistant** (end of last turn): "Checkpoint reached, all state is on disk. […] ## Next / 1. Task 9 docs edits (small), 2. manual streaming verification via `just dev`, 3. `just check` + `just smoke`, 4. you sign commits A/B on return, PR to main, then Phases 3–5 (task list #2–4)."

## Context to Preserve

- **Never bypass git hooks**; pre-commit runs secrets/lint/typecheck/tests/knip. Knip: fix or narrowly justify, never blanket-ignore (deleted a speculative re-export in streamChat.ts rather than ignoring).
- **bun not npm**. Cerebras key in `.env.local` is shared with Ollie's STT work — never echo secret values; smoke ≈ $0.06/run.
- Plans are approved as-is; if installed SDK behavior diverges from a plan's claims, stop and report rather than silently adapting (twice so far the divergence was plan-prediction detail, resolved within locked decisions — note deviations in commit messages).
- Boundary lint warnings (`ai` imports outside `src/lib/llm/`, `drizzle-orm` outside `src/db/`) are warning-tier backstops: leave them as legitimate exceptions where the plan places transport/persistence code; Phase 5 revisits exemptions.
- TSDoc on every export (warning-tier gate); comments explain WHY; ~200-line files; Zod at all trust boundaries; the LLM never sees/emits XP.
- User is learning from this project — lead summaries with outcomes, explain load-bearing discoveries plainly.
- Subagent defaults if used: Opus 4.7, branches not worktrees, red→green TDD, controller verifies locally (memory files).

## Restart Hint

Working tree holds pending commit A (do NOT stash-pop roulette in this shared-stash worktree; if you must set it aside use a WIP commit — but simplest is to leave it in place and continue Task 9). Tests green; safe to resume directly: read the ledger + this file, then do Task 9 docs edits.
