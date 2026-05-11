# TODOs

- **Zod bound-violation retry for scoping `generateStructured` calls.** When scoping `generateStructured` calls (e.g. framework generation, where `<max_topics>` / `<min_units>` are enforced post-parse) fail schema validation, do one automated retry feeding the validation error back to the model as corrective context. Currently the transport-level `LLM.maxRetries` covers network/transport only; schema-drift retries are a separate concern. Scoped to scoping for now; generalise to all `generateStructured` callers if/when teaching-session schemas hit the same failure mode. Subsumed by spec §9.2's retry policy — implementation lives in the next-milestone harness loop.

- **Tier-reduction thresholds in `tuning.ts`.** Define when sustained low-quality answers should drop the learner a tier; currently advancement is one-way.

- **Mechanical-MC quality-score mapping confirmed in `tuning.ts`.** Lock the integer-to-SM-2-quality mapping for server-graded multiple-choice answers (correct/incorrect → 5/2 today, but the boundary cases need spec-level sign-off).

- **`llm_call_logs` audit table (post-MVP).** Per-call row capturing prompt hash, token usage, latency, model id — for prompt-cache hit-rate tracking and regression diagnosis.

- **`<curriculum_note>` + `curriculum_notes` table (post-MVP).** When framework editing earns its keep, design the tag schema, persistence table, and consumer (auto-edit vs user-surfaced suggestion) together.

- **`tier_changes` history (post-MVP).** Audit trail of tier advancements/reductions per course (timestamp, from/to tier, trigger). Useful for UI history and progression diagnostics.

- **Auth wiring milestone (its own spec).** Replace dev-user stub with real Supabase Auth + RLS. Spec covers session handling, RLS policies on every table, and migration of dev rows.

- **Cache hot-path verification against Cerebras / OpenAI-compatible.** Confirm prompt-cache hit-rates on production providers; if Cerebras's cache window or hash semantics diverge from OpenAI's, the byte-stable prefix invariant may need adjustment.

- **`turns_remaining` exact attachment point.** Decide whether `<turns_remaining>` rides as its own `harness_turn_counter` row prepended to each user turn, or is inlined into the user message — affects render and replay semantics.

- **Wave turn-parity invariant.** The Wave's final turn (`turns_remaining == 0`) must land on a model response — that turn carries the wrap-up, `<next_lesson_blueprint>`, and `<course_summary_update>`. Without an explicit invariant, an off-by-one or odd/even mismatch in the user↔model ping-pong can let `turns_remaining` reach 0 on a user turn, stranding the next-Wave seed. Decide whether to enforce parity by counting math (e.g. `WAVE_TURN_COUNT` always counts model turns, not message exchanges), by harness-side natural-language handling (force one extra turn until the model has emitted the closer), or both. Lock this before the harness loop is built; surface it in spec §6 alongside the `<turns_remaining>` contract.

- **`getNextTurnIndex` read-then-insert race (post-MVP).** The current implementation is safe under the single-user-per-Wave harness loop — concurrent writers cannot occur. If parallel write paths are ever added (e.g. sub-agent harness, multi-device replay), wrap the SELECT MAX + INSERT in a SERIALIZABLE transaction or convert to a per-parent Postgres sequence. See `src/db/queries/contextMessages.ts` for the inline note.

- **`recordAssessment` monotonic-turn race (post-MVP).** Same shape as the `getNextTurnIndex` race above: the SELECT MAX + INSERT in `src/db/queries/assessments.ts` is safe under the single-user-per-Wave invariant, but two concurrent writers could both observe the same `currentMax` and break monotonicity. Hardening (SERIALIZABLE transaction or `pg_advisory_xact_lock` keyed by `waveId`) is deferred until parallel write paths exist; flagged by CodeRabbit on PR #8 and acknowledged inline.

- **File-size cleanup pass (post-merge).** `src/db/queries/courses.ts`, `src/db/migrations/schema.integration.test.ts`, and `src/db/queries/contextMessages.integration.test.ts` exceed the 200-LOC guideline. Splits were intentionally deferred from PR #8 to keep the review-fix diff focused. Suggested splits: courses.ts → courses-reads.ts + courses-writes.ts + courses-utils.ts; integration tests → one file per table.

- **Optional `closed_at >= opened_at` invariant (post-MVP).** Considered for `scoping_passes` and `waves` during Phase B but deferred — adds a CHECK that uses two columns and would have a nontrivial cost on bulk insert. Add when we have a concrete bug or audit requirement that would benefit.

- **"Turn" terminology rename (post-MVP).** The codebase uses "turn" to mean one user↔assistant ping-pong (one HTTP call, one LLM call). This diverges from common LLM/chat usage where a "turn" is a single message from one side. Internally consistent and documented in `docs/UBIQUITOUS_LANGUAGE.md`, but causes a mental-model bump for new readers. A rename (e.g. `turn` → `exchange` or `round`) would touch: DB column `context_messages.turn_index`, enum value `harness_turn_counter`, constant `WAVE_TURN_COUNT`, model-facing `<turns_remaining>` tag in `tagVocabulary.ts` + prompts, function names (`getNextTurnIndex`, planned `executeTurn`), and PRD/glossary/sim docs + every `CLAUDE.md`. Deferred — bundling this into a feature spec would dwarf the actual work. Tackle as a dedicated rename PR if/when the friction warrants it.
