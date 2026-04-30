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
