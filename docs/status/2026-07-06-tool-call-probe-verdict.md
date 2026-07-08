# Tool-call reliability gate: GO (gpt-oss-120b on Cerebras)

Decision gate for `docs/superpowers/plans/2026-06-10-tool-calling-turn-actions.md`
Task 1. Probe: `just probe-model gpt-oss-120b --tools` (20 scripted teach+quiz
trials per run, two tools, `stopWhen: stepCountIs(4)`).

## Verdict

**GO.** With the wire/validator-split schema (see finding 3): **95.0%** and
**100.0%** valid-call rate on consecutive runs, median loop depth **2** steps
(gate: ≥95% AND ≤3). Residual: ~5% of trials the model teaches without calling
`presentQuestionnaire` at all (`noCallWhenRequired` 1/20 per run) — the
harness-side `validateTurn` gate covers this in the real pipeline.

## Raw numbers (all runs, chronological)

| # | Schema config | Valid rate | Notes |
|---|---------------|-----------:|-------|
| 1 | bare `.optional()` | 91.3%* | *double-counted invalid calls (tally bug, fixed) |
| 2 | bare `.optional()` | 90.0% | 2 invalid, 2 no-call |
| 3 | bare `.optional()` | 87.0% | 3 invalid, 0 no-call |
| 4 | bare `.optional()` | 95.2% | 1 invalid, 0 no-call |
| 5 | `.nullish()` (anyOf unions) | 44.4% | options emitted as ARRAY; 6 no-call |
| 6 | `.nullish()` (anyOf unions) | 45.2% | same failure mode; 5 no-call |
| 7 | wire/validator split | **95.0%** | 1 invalid, 1 no-call, median 2 steps |
| 8 | wire/validator split | **100.0%** | 0 invalid, 1 no-call, median 2 steps |

Every invalid call in runs 2–4 was the SAME mode: `"correct": null` emitted on
a `free_text` question, rejected by `.optional()` (which permits absence, not
null). Zero hallucinated tool names in any run.

## Findings that bind later tasks

1. **Strip reasoning per step or the loop 400s.** gpt-oss-120b emits
   reasoning; `@ai-sdk/openai-compatible` round-trips it as
   `reasoning_content` on assistant messages, and Cerebras rejects that as an
   input property (`400 wrong_api_format`). Fix: `prepareStep` returns
   `messages` with assistant `reasoning` parts filtered out.
   `streamToolChat` (Task 5) MUST do the same.
2. **Tool schemas need a wire/validator split** (the tool-channel analogue of
   `toOutputSchema`): wire bytes from the bare-`.optional()` shape via
   `toCerebrasJsonSchema` (union-free — `anyOf`-null unions crater reliability
   to ~44% and cause record→array confusion), validation via Zod after a
   `stripNullsDeep` pass (tool-trained models emit explicit `null` for
   inapplicable optionals, OpenAI strict-mode convention). Task 4's
   `waveTurnTools.ts` MUST build inputSchemas this way.
3. **Invalid tool inputs do NOT throw in multi-step flows** (verified in
   installed `ai@6.0.158` source, contra the doc's `generateText` blurb): the
   call lands in `step.toolCalls` flagged `invalid: true, dynamic: true` and a
   matching `tool-error` part is fed back to the model, which self-corrected
   in-loop in every observed case (3-step trials). Count attempts from
   `step.toolCalls`, not from thrown errors.

## Cost

8 probe runs ≈ 350 live calls ≈ low single-digit cents on the paid-tier key.
