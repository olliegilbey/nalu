# TODO

Follow-up work surfaced during MVP development. Each entry names the file,
the concern, and the conditions under which it should be promoted to a PR.

- [ ] Narrow `makeWaveCloseSchema` to reject `mc-index` close-gradings — the close orchestrator can only grade free-text at close (MC graded mid-turn in `executeWaveMid.grade.ts`). Currently `applyCloseGradings` throws at runtime if the LLM emits an mc-index grading at close. Move the constraint into the Zod schema via a superRefine so the model's response is rejected at parse time and `executeTurn` can retry with a directive.

- [ ] Resolve drizzle-orm imports outside `src/db/` in 4 wave-close files (`src/lib/course/executeWaveMid.ts`, `persistWaveClose.ts`, `persistWaveClose.helpers.ts`, `submitBaseline.persist.ts`). AGENTS.md says "DB access → src/db/queries/ only" but these files import `and`/`desc`/`eq`/`sql` operators for transactional wave-close logic. Two options: (a) refactor the query-building into composed helpers in `src/db/queries/waves.ts`, or (b) update AGENTS.md to acknowledge that wave-close persistence helpers belong in `src/lib/course/` because they're tightly coupled to wave orchestration. Surfaced by the `no-restricted-imports` warn rule.

- [ ] `proxy.test.ts:88` floating promise — the test fires a promise without awaiting or marking with `void`. Decide whether the test should `await` (probable) or whether the pattern is intentional and the `void` annotation is the fix. Surfaced by the `@typescript-eslint/no-floating-promises` warn rule.

- [ ] Streaming follow-ups (2026-06-10 plan): stream close-turn prose; resumable streams on reload (chatbot-resume-streams doc); remove tRPC wave.submitTurn after one stable release; consider full useChat message-state adoption with the tool-calling migration.

- [ ] Delete the mid-turn mega-schema (`waveMidTurnSchema` + `renderWaveTurnEnvelope`'s `responseSchema` param + `executeWaveMid.ts` + the `"json"` teaching-prompt contract branch) TOGETHER with tRPC `wave.submitTurn` after one stable release — they are the same rollback debt. The streaming path emits via tools (`waveTurnTools.ts` + `executeToolTurnStream`); the blocking path is kept only as the rollback transport (tool-calling plan Task 6 deviation, 2026-07-06).

- [ ] Tool-calling follow-ups (2026-06-10 plan): decompose close-turn (blueprint/summary/grading) into tools using the mid-turn recipe; consider harness→model tools (getDueConcepts, getLearnerHistory) to shrink rendered context; full useChat message-state adoption; remove inline-schema fallback once scoping also moves to tools.

## Teaching-loop UI (Task 15 follow-ups)

### JSON-everywhere for wave `context_messages.content`

**Files:** `src/lib/turn/executeTurn.ts`, `src/lib/llm/renderContext.ts`,
`src/lib/course/getWaveState.ts`, `src/lib/course/deriveWaveTurns.ts`

`executeTurn` currently persists `user_message` rows with the full XML
envelope (`renderWaveTurnEnvelope` output: `<stage>…<learner_reply>…
</learner_reply><turns_remaining>…</turns_remaining><response_schema>…
</response_schema>`) and `assistant_response` rows with raw LLM JSON.
The UI reads `context_messages.content` straight into chat bubbles, so
both render the wire format verbatim (screenshots from 2026-05-19
session). Scoping doesn't have this problem — it stores typed JSONB
(`clarifications`, `baseline`, `framework`, `scopingResult` columns)
and `deriveTurns` reads structured fields.

**Fix:** mirror the JSON-everywhere principle that Task 7 applied to
prompts. Persist clean structured payloads in `context_messages.content`
— e.g. `{"text": "Great let's go"}` for chat-text, `{"answers": […]}`
for questionnaire submissions, `{userMessage, comprehensionSignals,
questionnaire}` for assistant turns. Build the XML envelope ONLY at
LLM-send time inside `renderContext` (or executeTurn's send step), never
persist it. `deriveWaveTurns` then reads structured fields, same as
`deriveTurns` reads typed JSONB columns.

**Touches:** `executeTurn` persistence, `renderContext` (LLM
context-replay must reconstruct the envelope on the fly), `getWaveState`
(`RenderedMessage.content` becomes structured), `deriveWaveTurns`,
plus integration tests that snapshot envelope content.

**Promote when:** backend Wave teaching loop is smoke-green and the
team is ready to land a coordinated migration of persisted shape.

## Concurrency races (deferred — single-user serial MVP)

These are theoretical for the current flow: one learner, one wave, turns
submitted serially. CodeRabbit flagged them on PR #12; the fixes are
architectural and not worth landing until concurrent same-wave submissions
become possible.

### `executeWaveMid` selects the assistant row by `desc(turnIndex)` / `limit(1)`

**Files:** `src/lib/course/executeWaveMid.ts`

After `executeTurn` persists the `assistant_response`, `executeWaveMid`
re-finds that row with `orderBy(desc(turnIndex)).limit(1)`. Two concurrent
same-wave submissions could each pick up the _other's_ freshly-written row,
attaching grading + questionnaire state to the wrong turn.

**Fix:** thread the persisted assistant message id + turnIndex out of
`executeTurn` directly and select by that id, instead of the desc/limit
lookup.

**Promote when:** concurrent same-wave submission becomes reachable (e.g.
multi-device, or background retry that races a live submit).

### `submitWaveTurn` guard→append flow is non-atomic

**Files:** `src/lib/course/submitWaveTurn.ts`

The §7.4 precondition guards run as a load → check → append sequence with no
row lock. Two concurrent same-wave submissions can both pass the guards on
the same pre-state and both append, double-accepting a turn.

**Fix:** wrap load → guard → append in one transaction with
`SELECT ... FOR UPDATE` (or a compare-and-swap) on the wave row so the second
submission blocks until the first commits, then re-evaluates the guards.

**Promote when:** concurrent same-wave submission becomes reachable.

### `awaitCerebrasCallSlot` slot acquisition is not serialized

**Files:** `src/lib/llm/cerebrasRateLimit.ts`

`awaitCerebrasCallSlot()` does read-state → `await sleep(...)` → write-state.
The `await` yields, so two concurrent LLM calls on the _same_ Node instance
both read the stale `lastDispatchAtMs`, compute the same spacing wait, and
dispatch together — defeating the 5-RPM floor. This is the in-process twin of
the already-documented cross-invocation raciness (see the module header in
`cerebrasRateLimit.ts`): same trigger (two concurrent `generateChat` calls),
which cannot happen for one learner submitting turns serially.

**Fix:** the proper cross-invocation fix is a shared store (Redis/DB) with
atomic acquisition; that store serializes within an instance too, subsuming
this race. A standalone in-process fix (chain each call through a single
`limiterQueue: Promise<void>`) is ~10 lines but would be discarded by the
shared-store rewrite — not worth landing separately.

**Promote when:** the shared-store rate limiter is built, OR concurrent
`generateChat` calls become reachable before then.

## Anonymous auth follow-ups

### Exclude root metadata files from the proxy matcher

**Files:** `src/proxy.ts` (`config.matcher`)

The matcher `["/((?!api|_next/static|_next/image|favicon.ico).*)"]` excludes
API routes and `_next` assets but not root metadata files. Today none exist,
so there is nothing to exclude.

**Fix:** when `robots.txt`, `sitemap.xml`, or similar public root files are
added, extend the negative-lookahead so crawler hits don't trigger a Supabase
`getUser()` round-trip and mint throwaway anonymous accounts.

**Promote when:** the first root metadata file is added.

### Periodic cleanup of session-less anonymous users

**Files:** Supabase `auth.users` (no app file yet)

Two near-simultaneous first visits can each call `signInAnonymously()`; the
losing cookie is discarded, leaving a stray `auth.users` row with no live
session and (since `ensureUserProfile` only runs on an authenticated request)
possibly no `user_profiles` row. Harmless functionally, but the table grows.

**Fix:** a scheduled job deleting anonymous users with no session activity
past a cutoff (Supabase exposes `last_sign_in_at` / `is_anonymous`).

**Promote when:** anonymous-user row count becomes non-trivial in production.

### Graceful not-found state for `/course/[id]`

**Files:** `src/app/course/[id]/page.tsx`

When `course.getState` returns `NOT_FOUND`, the course page renders the chat
shell and spins forever — no error message, no redirect. `getState` is
ownership-scoped (`getCourseById(courseId, userId)`), so this is reachable in
normal use now that every visitor has a distinct anonymous identity: opening a
bookmarked course URL on a different browser/device, after cookies are cleared
or the session cookie expires, or following a URL shared by someone else. Not
a security issue — the 404 is the ownership check working correctly — purely a
dead-end UX. Surfaced by the anonymous-auth production smoke.

**Fix:** handle the `getState` query error — render a "course not found" state
(offer to start a new course) or redirect to `/`.

**Promote when:** next UX pass, or before course-URL sharing becomes a real
flow.

## Analytics / visitor observability

### Wire PostHog for visitor attribution — DONE 2026-07-03

Implemented **server-side** anonymous `$pageview` capture in `src/proxy.ts`
(distinct_id = Supabase anon user id; real client IP as `$ip` for correct
GeoIP; tagged `app:"nalu"`), reusing resumate's EU project. Went server-side
after verifying a client reverse proxy breaks GeoIP on PostHog Cloud (it
geolocates our server, not the visitor). Spec + rationale:
`docs/superpowers/specs/2026-07-02-posthog-visitor-analytics-design.md`
(Revision section). The session↔DB-course join is now covered (distinct_id is
the anon user id). Remaining optional: richer in-session client analytics
(direct, un-proxied `posthog-js`) if ever wanted.

**Files:** client entry (`src/app/layout.tsx` or a `PostHogProvider`), optional
server-side capture in tRPC (`src/server/`), `src/proxy.ts` (stopgap only)

A prod visitor's origin — IP-geo, referrer/UTM, session — is currently
unrecoverable after ~1hr: runtime logs age out fast, the `client_ip` / `asn_name`
/ `client_ip_country` metric dimensions are gated behind Observability Plus (Pro
plan), and `@vercel/analytics` is not wired. Surfaced 2026-07-01 trying to
identify an anonymous visitor to the "how transformers work" demo (see
`reference_visitor_ip_geo_forensics` memory). With the app link now circulating in
job applications, knowing who opens it is worth having.

**Fix:** wire `posthog-js` on the client — pageviews, referrer, UTM, IP-based
geoip, session replays. Set the anonymous Supabase `user_id` as the PostHog
distinct_id so DB courses join to sessions. Consider server-side `posthog-node`
capture for key tRPC events (topic chosen, clarify, wave progress) that the client
script can't see. Free tier (1M events/mo) covers current traffic many times over.

**Stopgap (zero-dep):** log `x-vercel-ip-country` / `x-vercel-ip-city` /
`x-forwarded-for` in `src/proxy.ts` on session mint — but only as durable as log
retention (~1hr) unless drained somewhere.

**Promote when:** soon — visitor attribution is wanted now that the link is
shared. At minimum before the next batch of applications goes out.

- Agent-loop follow-ups (2026-06-10 plan): close-turn agent (blueprint/summary tools); scoping clarify as adaptive agent (model decides clarification depth via askLearner/completeScoping emissions — design only, gated on product call); evaluate createAgentUIStreamResponse to replace the hand-rolled writer once full useChat message-state adoption lands; MCP tools explicitly out of scope until an external integration exists.

## Deferred findings from CodeRabbit CLI review (2026-07-18, branch chore/llm-hygiene-observability)

Reviewed with `coderabbit review --agent --base main`. Fixed on the branch: wave-wire `freetextRubric` leak (redactWaveChatLog), `containsResponseJsonBlob` fail-open >20k, provider-strategy BYOK overclaim, glossary Turn/Step cardinality. Deferred (pre-existing behavior, each needs its own pass):

- **Scoping wire ships grading keys (product decision needed).** `clarify`/`generateBaseline` return raw `Question[]` to the client: `freetextRubric` plaintext AND (baseline MC) plaintext `correct` — `adaptQuestionnaire` deliberately uses `correct` for client-side instant feedback. Wave flow solved the same need with `correctEnc` + `decodeCorrect`. Options: mirror the wave scheme in scoping (project rubric out, swap correct→correctEnc), or accept for scoping (baseline is one-shot, low stakes). The rubric at minimum should be projected out - it has no client consumer.
- **`forwardToolChunk` forwards internal tool chunks** (`streamWaveTurn`): lookup-tool and `recordComprehensionSignals` inputs/outputs stream to the client UI channel. Not an answer-key leak, but grading-signal/SR internals cross the wire with no client consumer. Consider an allowlist (`presentQuestionnaire` only) — review alongside the scoping-wire item.
- **Rate limiter does not pace SDK-internal transport retries**: `awaitCerebrasCallSlot` gates per `generateText` call; the SDK's own `maxRetries` backoff re-requests without re-acquiring a slot. Mostly moot on paid tier; revisit if 429s return.
- **`waveTurnTools` duplicate `questionId` staging**: signals for the same question can stage twice (within a call or across calls) before persistence. Add dedup-or-reject in the collector path.
- **`waveLookupTools` caps applied post-query** (`.slice` after fetch) instead of SQL `LIMIT`; also `lastQuality` rides in the due-concepts projection to the model — decide whether scoring internals belong in lookup output.
- **`presentQuestionnaire` schema lacks `.max(3)`** on questions (described "1-3" but unenforced). Wire-schema change — bundle with the next prompt-bytes-touching PR, not a drive-by.
- **`context_messages` kind/role DB constraint** doesn't pin `assistant_tool_call`→assistant / `tool_result`→tool pairings. Schema hardening + migration.
- **`probe-model.ts` trial semantics**: valid-rate counts valid tool calls, not trials-with-required-questionnaire-call; missing calls should count as failures. Fix before the next probe campaign.
- **`streamWaveTurn.live.test.ts` uses `console.log`** in beforeAll (live-gated so the commit gate misses it); switch to `process.stderr.write`.

## Session backlog (2026-07-20)

- **Migrate TODO.md → public GitHub Issues.** Decision pending Ollie's yes. Recommendation: public issues (this file is already committed to a public repo, so a private tracker protects nothing extra); PRs auto-close via "Fixes #N", subagents read them with `gh issue view`, and a groomed issue list is good public signal. Add a private GitHub Project later only if a private prioritization layer earns its keep.
- **Ungraded MC: confirmed option keeps the green selection border** (PR #40 reviewer note). It's the pre-existing pending/selection indicator, not grading feedback, but green-on-confirm can read as "correct". Decide: accept, or freeze confirmed ungraded selections in a neutral color (small Composer-only change).
- **Wire an OTLP endpoint + set `LLM_TELEMETRY=true` in Vercel env.** Phase 5 spans currently export nowhere (`src/instrumentation.ts` registers, no destination). Low-friction candidates: Vercel OTel drain → Axiom or Grafana Cloud. Then wave-turn latency becomes measurable per stage/step/tool-call.
- **Watch `reasoning_effort: high` latency** (PR #39, live since 2026-07-20). High effort spends reasoning tokens before the first visible byte; partly offset by fewer schema-retry round-trips. If wave mid-turn latency degrades, drop `LLM.reasoningEffort` to "medium" or split per-stage (high for framework/baseline/close, medium for mid-turns) - one-line tuning change either way.
