# Teaching Loop — PR #12 review fixes

## Task Overview

PR **#12** (`feat/teaching-loop` → `main`) is open — the AI wave teaching loop feature (scoping handoff → Waves, `waves.chat_log` JSONB UI store, prompt/UX polish). 57 commits, 107 files.

`/ultrareview 12` ran and found **5 `normal`-severity bugs**. All 5 were triaged and confirmed **valid — no false positives**. They all sit in the new wave-loop code this PR adds; 4 of them produce a 500 or data corruption on _ordinary model behaviour_.

**Success criteria:** fix all 5 bugs, commit + push to `feat/teaching-loop`, checks green (`just check` minus smoke, or the constituents), PR #12 mergeable. Re-run `just smoke` if touching turn logic (Touch ID — user's call).

The 5 bugs MUST be fixed before merge — the ultrareview output does not persist, so they are captured in full below.

## Reference Docs

- `docs/superpowers/plans/2026-05-20-wave-chat-log-mirror-scoping.md` — the chat_log refactor plan (Plan Tasks 1-17, all complete).
- `docs/ARCHITECTURE.md:17-36` — replay-log invariant + "system prompt is recomputed, never persisted" (added this session).
- `docs/TODO.md` (last entry) — un-park: strict-mode constrained decoding not enforced.
- `AGENTS.md` / `CLAUDE.md` / `KARPATHY.md` — project + agent guides. Subdir `CLAUDE.md` files auto-load.
- `docs/PRD.md` — full product spec; `docs/UBIQUITOUS_LANGUAGE.md` — glossary (Wave, Tier, Context, harness).

## Current State

- Branch `feat/teaching-loop`, HEAD `4b32871`, 57 commits ahead of `main`. PR: https://github.com/olliegilbey/nalu/pull/12
- **All checks green at HEAD**: unit 315, integration, tsc, eslint, live smoke 5/5. Manual UI walkthrough done (scoping → Wave 1 → Wave 2).
- **Working tree clean** except: `.claude/settings.json` (user's `/plugin` toggle — DO NOT commit or revert) and `MISSION.md` (pre-existing untracked stale template — DO NOT touch; it breaks `just check` if staged).
- This session landed: chat_log refactor T11-17 (`115cd8a`, `7ae484e`), flaky-test fix (`8299c60`), desc-following probe (`3450337`), UI column (`b5575be`), prompt fixes (`746f7f2`), inspect-wave + docs (`4b32871`).
- `scripts/inspect-wave.ts` — DB inspection tool: `bun --env-file=.env.local scripts/inspect-wave.ts <courseId> [waveNumber]`. Dumps `context_messages`, `chat_log`, course XP/concepts/assessments. DB-only, no `op`/Touch ID. Test course used this session: `116244c7-8fa2-41b4-96d1-14c54f1b568d`.

## The 5 bugs to fix (all valid, all `normal`)

> Distilled below (file/line · cause · trigger · effect · fix). The **complete** ultrareview output — full reasoning, "why existing code doesn't prevent it", impact analysis, and step-by-step proofs — is preserved verbatim in `@docs/status/2026-05-21-1309-ultrareview-findings.md`. Read that before fixing if the summary leaves any doubt.

### bug_001 — non-idempotent pre-LLM `chat_log` append corrupts wave on retry

- **Where:** `src/lib/course/submitWaveTurn.ts` (~lines 136-164).
- **Cause:** `submitWaveTurn` calls `appendWaveChatLog(db, ctx.wave.id, learnerEntry)` (~line 163, pre-LLM) before the fallible `executeWaveMid`/`executeWaveClose` dispatch. `appendWaveChatLog` (`src/db/queries/waves.ts`) is a non-idempotent JSONB `||` concat — no transaction, no dedup. Scoping's equivalent pre-persist writes to _overwrite_ columns, so it is idempotent for free; the wave append is not.
- **Trigger:** LLM dispatch throws (retry exhaustion / transport / post-LLM tx error) → learner entry committed + orphaned → learner retries → a 2nd copy is appended.
- **Effect:** chat-text turn → `consumed` (~line 136) inflated → `turnsRemaining` one too low → wave can close a full turn early. questionnaire-answers turn → orphan `{role:user,kind:answers,questionnaireId}` makes `findOpenQuestionnaire` return `null` → retry throws `PRECONDITION_FAILED "no open questionnaire"` → questionnaire permanently un-resubmittable, its placeholder assessments stay ungraded, XP lost.
- **Fix:** make the pre-LLM append resume-aware — no-op if the trailing `chat_log` entry already represents this exact submission (same kind / questionnaireId / content). Retries must not double-append.

### bug_003 — close turn cannot grade an MC question posed on the final mid-turn

- **Where:** `src/lib/course/persistWaveClose.helpers.ts` (~lines 52-61, `applyCloseGradings`).
- **Cause:** `applyCloseGradings` throws a plain `Error` on any `mc-index` close-grading, on the false premise that MC is always graded mid-turn. A questionnaire posed on the final mid-turn (turn 9) is answered on the close turn (turn 10).
- **Trigger:** model drops an MC-containing questionnaire on turn 9 (`waveMidTurnSchema.questionnaire` is optional, unconstrained by `turnsRemaining`). `executeWaveClose` calls `findOpenQuestionnaire(ctx.wave.chatLog)` — `ctx` snapshot is stale (taken before the close-turn answer is appended), so the turn-9 questionnaire reads as still-open → its MC ids feed `makeWaveCloseSchema`'s coverage `superRefine` → model emits a schema-valid `{kind:"mc-index"}` grading → `applyCloseGradings` throws inside `persistWaveClose`'s tx → uncaught 500. No valid grading path exists: omitting the id fails the coverage refine.
- **Fix:** grade close-turn `mc-index` mechanically — mirror `executeWaveMid.grade.ts` (compute correctness from the stored questionnaire's correct index; `applyAssessmentGrading` accepts `{kind:"mc-index", correct}`) instead of throwing. (Rejecting `mc-index` at parse-time does NOT fix it — converts 500 → retry-exhaustion.)

### bug_004 — model-reused question ids collide with the assessments unique index

- **Where:** `src/lib/course/executeWaveMid.insert.ts` (~lines 107-122, `insertNewQuestionnaire`).
- **Cause:** writes one assessment row per question with `questionId = q.id` (model-generated). The partial unique index `assessments_wave_question_unique` is keyed `(wave_id, question_id)` — no `turn_index`. Nothing enforces per-wave id uniqueness; no schema refine; the model is never told ids must be wave-unique.
- **Trigger:** model reuses `q1`/`q2` across questionnaires in one wave (LLMs restart numbering per questionnaire — observed: wave 2 turn 1 emitted `q1` again), or duplicates within one questionnaire → Postgres 23505 → uncaught 500 (post-parse, not a `ValidationGateFailure`, so no retry).
- **Fix (recommended, no migration):** namespace `question_id` at insert time — `${assistantMessageId}:${q.id}` (or `${turnIndex}:${q.id}`). **Check `executeWaveMid.grade.ts` and any assessment-by-questionId matching uses the same namespacing** — keep them consistent.

### bug_012 — duplicate `conceptUpdates` double-advance a concept's SM-2 schedule

- **Where:** `src/lib/prompts/waveClose.ts` (~lines 36-46, the `makeWaveCloseSchema` `superRefine`).
- **Cause:** the `conceptUpdates` `superRefine` only checks each name is an existing concept — no duplicate-name check. `closeTurn.ts` already dedupes `gradings` (by questionId) and `plannedConcepts` (by name); `conceptUpdates` was missed.
- **Trigger:** model emits two `conceptUpdates` entries for the same concept → both pass → `persistWaveClose` applies SM-2 twice; `applySm2Update` reads `tx`-scoped state, so the 2nd call sees the 1st write and compounds → double-advanced `repetitionCount`/`intervalDays`/`easinessFactor`/`nextReviewAt`.
- **Fix:** add a duplicate-name `superRefine` to `conceptUpdates`, mirroring the existing dedup pattern in `closeTurn.ts`. ~5 lines. Rejected parse routes through `executeTurn`'s retry directive.

### bug_002 — reloading a closed wave strands the learner

- **Where:** `src/components/chat/WaveSession.tsx` (~lines 45-52) + `src/hooks/useWaveState.ts`.
- **Cause:** the move-on CTA is derived only from `closeResult` — component-local React state in `useWaveState`, set ONLY in the submitTurn close-turn `onSuccess`. `getWaveState` always returns `closeResult: null`. `useWaveState` fetches `status` ("active"|"closed") from the wire but never exposes it in `UseWaveStateResult`.
- **Trigger:** reload / back-nav to a closed wave → `closeResult` null → no CTA. With no open questionnaire, the Composer falls back to enabled chat-text mode; sends throw `PRECONDITION_FAILED` (`submitWaveTurn.ts:~77` — wave not open); the submitTurn mutation has **no `onError`** → silent failure, typed input cleared with zero feedback.
- **Fix:** expose `status` through `useWaveState` (`UseWaveStateResult`); `WaveSession` renders a move-on/return affordance when `status === "closed"` (no `nextWaveNumber` available on reload — navigate by ordinal `waveNumber + 1`). Add an `onError` toast to the submitTurn mutation. Optionally disable the chat-text Composer when `status === "closed"`.

## Important Discoveries

- **Strict-mode constrained decoding is NOT enforced by Cerebras for `gpt-oss-120b`** — `response_format: {json_schema, strict:true}` IS sent (provider sets `supportsStructuredOutputs:true`), but the model freely emits non-conforming JSON; `executeTurn`'s validate-and-retry is the real safety net. This is why bugs 003/004/012 triggers are realistic, not theoretical — the model misbehaved on nearly every complex turn during live testing. See auto-memory `cerebras-strict-mode-not-enforced` and the `docs/TODO.md` un-park entry. Verified via the `DESC-FOLLOWING` probe in `scripts/probe-model.ts`.
- **System prompt is recomputed every turn, never persisted** — `context_messages` CHECK forbids `role='system'`; `renderTeachingSystem`/`renderScopingSystem` rebuild it from seed columns each call. So prompt-rendering edits apply live to existing sessions (dev hot-reload is enough); only persisted _output_ (openingText, framework, tier) needs a fresh run. Documented `docs/ARCHITECTURE.md:26-36`.
- **`failed_assistant_response` is the schema-mismatch retry pattern** — common observed mis-shapes: `assistantMessage` for `userMessage`, `nextLesson` for `nextUnitBlueprint`, `questionnaire.{type,prompt}` for `questionnaire.questions[]`, `{name,status}` for the `conceptUpdates` shape. Recovers via retry; the close schema (`makeWaveCloseSchema`) fails first-try on every close turn observed.
- **Approach ruled out for bug_003:** rejecting `mc-index` at parse-time (the original TODO suggestion) does NOT fix it — there is no schema-valid output the model can produce, so it converts a 500 into retry-exhaustion. Must grade mechanically.

## Next Steps

1. **`/clear`, then fix the 5 bugs via `superpowers:subagent-driven-development`** — fresh Opus 4.7 subagent per bug, two-stage review (spec compliance → code quality), controller verifies green locally. Bugs are independent; any order. Suggested: bug_012 (smallest, ~5 lines), bug_004 (no migration), bug_001, bug_003, bug_002.
2. Each fix: TDD where it fits (a failing test reproducing the bug, then green). Run constituents of `just check` locally; never `--no-verify`.
3. Commit each fix (`fix(...)`) and push to `feat/teaching-loop` — they land on the open PR #12.
4. Optionally re-run `just smoke` after the turn-logic fixes (Touch ID — user's call).
5. TODO.md task #27 ("Extend `wave.live.test.ts` to cover Wave 2 mid-turns + close") is still pending — optional, not a merge blocker.

**Verbatim — where work stopped (controller's triage message, then user invoked `/wrap-up`):**

> "**My read:** these are all worth fixing **before merging #12**. Four produce 500s or data corruption on _ordinary model behaviour_ — and we watched the model misbehave constantly this session (the strict-mode failures), so the triggers are realistic, not theoretical. None are large; bug_012 is ~5 lines, the rest are medium. bug_004's fix needs no migration (the namespacing approach).
>
> **Recommendation on how:** this session's context is near-exhausted. Best to **`/clear` and tackle the 5 fixes in a fresh session via subagent-driven development** against the branch, then push to the PR."

## Context to Preserve

- **User runs subagent-driven development** as controller-of-subagents: fresh subagent per task, default model **Opus 4.7**, two-stage review (spec then quality), controller verifies green locally — never defers verification to CI. Subagents check out the branch directly (NOT worktrees).
- **Ask first**: git commits/PRs, destructive ops, architecture decisions with multiple valid approaches.
- **Never bypass git hooks** — no `--no-verify`, no `HUSKY=0`, no hook deletion. Pre-commit is thorough; CI re-runs everything.
- **Secrets**: never echo secret values. `just smoke`/`just dev`/`just probe-model` wrap with `op run` → require Touch ID (don't offer to AFK users). DB-only scripts (`bun --env-file=.env.local …`) need no `op`.
- **Do NOT touch** `.claude/settings.json` (user's toggle) or `MISSION.md` (untracked stale).
- Project standards: TS strict, no `any`, `readonly`/`const`, TSDoc on exports, max 200 LOC/file, Zod at trust boundaries, business logic in `src/lib/` only, prompts in `src/lib/prompts/` only, DB access in `src/db/queries/` only.
- Be concise; sacrifice grammar for brevity. Conventional commits.

## Restart Hint

Safe to `/clear` — all work committed and pushed (HEAD `4b32871`); the only working-tree changes are the user's `.claude/settings.json` and stale `MISSION.md`, neither to be touched. Next session: read this file, then fix the 5 bugs via subagent-driven development on `feat/teaching-loop`.
