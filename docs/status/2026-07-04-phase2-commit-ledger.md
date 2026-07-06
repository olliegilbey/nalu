# Phase 2 commit ledger — signing paused (Ollie AFK)

> **RESOLVED 2026-07-06**: commit A landed as 1161cf9, commit B is the commit
> containing this file. Manual streaming verification passed (browser +
> server log + DB); `just check` and `just smoke` green. Kept as history.

Session: https://claude.ai/code/session_01RaZinbh9BsfTdrtX1hWuJ8
Branch: `feat/streaming-wave-turns` (cut from origin/main @ 2b9be6e, Phase 1 merged as PR #31).
Plan: `docs/superpowers/plans/2026-06-10-streaming-wave-turns.md` (Tasks 1-9).

## Already committed (signed, Tasks 1-7)

f-series commits on this branch, all green when made:

1. `test(llm): pin streamText+Output.object streaming semantics` — streamChat.test.ts spike
2. `feat(llm): streamChat — streaming structured calls via streamText+Output.object` — + CLAUDE.md bullet
3. `refactor(turn): extract context assembly shared by blocking+streaming turn paths` — contextAssembly.ts
4. `feat(turn): executeTurnStream — streaming turn primitive with identical persistence`
5. `refactor(course): split wave-turn guards and persistence for streaming reuse` — prepareWaveTurn/persistWaveMidTurn
6. `feat(course): streamWaveTurn — UIMessage-stream transport over shared turn pipeline` — + waveStream.ts types
7. `feat(api): streaming wave-turn route on the UI message stream protocol` — route.ts, requestUser.ts, waveTurnInput.ts, trpc.ts, wave.ts

## PENDING COMMIT A (Task 8 — client)

Message:
```
feat(ui): stream wave-turn prose via useChat; tRPC keeps state queries

Claude-Session: https://claude.ai/code/session_01RaZinbh9BsfTdrtX1hWuJ8
```
Files:
- package.json + bun.lock (`@ai-sdk/react@3.0.160` added)
- src/hooks/useWaveState.ts (useChat hybrid: in-flight turn only; handleTurnResult = old onSuccess; onFinish invalidates then clears; questionnaireErrorRef carries per-call onError; submitTurn mutation deleted; DefaultChatTransport sends devUserHeaders())
- src/components/chat/WaveSession.tsx (streaming bubble replaces TypingBubble when streamingText non-empty)
- src/lib/trpc.ts + src/app/providers.tsx (2026-07-06: `devUserHeaders()` extracted — the streaming fetch was missing the `x-dev-user-id` dev-stub header the tRPC link sends, so every dev streaming request 401'd; helper now shared by both client transports. Verified in ai@6 source: prepareSendMessagesRequest returning no `headers` key falls back to transport-level baseHeaders.)

**Dependency pin (important):** `@ai-sdk/react` MUST be `3.0.160` — the release whose `ai` dep is exactly `6.0.158` (the repo's pinned SDK). The 4.x line hard-depends on `ai@7`, and any mismatched 3.x pulls a nested second `ai` copy under `node_modules/@ai-sdk/react/node_modules/ai`, which (a) breaks `InferUIMessageData` type identity (part.data becomes `unknown`) and (b) risks UI-stream protocol drift between server (v6) and client. Version map discovered via `npm view "@ai-sdk/react@>=3.0.150 <3.0.180" dependencies.ai`; react 3.0.N ↔ ai 6.0.(N-2). If Phase 5 bumps `ai`, bump `@ai-sdk/react` in lockstep.

Also in this commit: `src/hooks/useWaveState.test.tsx` — rewritten for the useChat flow (mocked `@ai-sdk/react` useChat; tests drive onData/onError by hand; 10/10 pass, includes new data-turn-reset coverage).

Status: typecheck clean, lint 0 errors, unit suite green (full run passed 2026-07-04), integration green. REMAINING before signing commit A:
1. Manual streaming verification (`just dev`, submit a wave turn, watch prose stream token-by-token) — plan Task 8 Step 4. Can be done with Chrome automation or by Ollie on return.
2. Optional: re-run `just check` as final gate.

## PENDING COMMIT B (Task 9 — docs/TODO)

Message:
```
docs(course): document dual transport + streaming follow-ups

Claude-Session: https://claude.ai/code/session_01RaZinbh9BsfTdrtX1hWuJ8
```
Files (to be written):
- src/lib/course/CLAUDE.md + src/server/routers/CLAUDE.md (dual transport: tRPC state/queries, route handler for streamed dispatch; prepareWaveTurn/persistWaveMidTurn shared spine)
- TODO.md append: "Streaming follow-ups (2026-06-10 plan): stream close-turn prose; resumable streams on reload (chatbot-resume-streams doc); remove tRPC wave.submitTurn after one stable release; consider full useChat message-state adoption with the tool-calling migration."
- docs/status/2026-07-04-phase2-commit-ledger.md (this file — or delete it before PR, either is fine)

## Before PR (Task 9 step 3)

- `just check` green; `just smoke` (blocking path must be untouched — smoke exercises scoping, ~$0.06)
- Playwright if a wave-session E2E exists (`bunx playwright test`)
- Self-review checklist (plan lines 1245-1253): bug_001 verbatim in prepareWaveTurn ✓ (moved verbatim); userIdStore.run wraps route execute ✓; row sequences identical between executeTurn/executeTurnStream tests ✓; wave.submitTurn procedure retained ✓; TSDoc on all new exports ✓
- PR: `feat/streaming-wave-turns` → main; then Phases 3-5 sequentially (task list #2-4)
