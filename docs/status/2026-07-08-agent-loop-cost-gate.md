# Agent-loop cost/latency gate: GO (with fast-lane raise proposed)

Decision gate for `docs/superpowers/plans/2026-06-10-agent-loop-scoping.md`
Task 1. Inputs: one fresh instrumented live run (2026-07-08, paid-tier
Cerebras, gpt-oss-120b: tool-loop smoke + full blocking wave loop), the
Phase-3 probe verdict (@docs/status/2026-07-06-tool-call-probe-verdict.md),
and two live browser turns on the dev deployment.

## Measured Phase-3 per-turn profile

| Metric | Value | Source |
|---|---|---|
| Median LLM calls per tool mid-turn | **2 steps** (tool call → prose) | Probe (2×20 trials, median 2); live smoke turn (2 steps); browser turn 2 (2 steps) |
| Retry-inflated turn (observed once) | 3 calls (1 failed attempt + 2-step retry) | Browser turn 1 (JSON-imitation → gate retry) |
| Wall-clock per LLM call | **~1.5 s** (23.3 s for 16 calls incl. testcontainers DB + scoping) | Instrumented run |
| Typical 2-step mid-turn wall-clock | **~3-5 s** end-to-end | Instrumented run + browser observation |
| Tokens/step | not logged by the smoke path (usage is summed but dropped at the call site) — probe economics: ~350 calls ≈ low single-digit cents → **~0.01¢/call** | Probe cost note |

## Modeled lookup-tool overhead

Each lookup (`getDueConcepts` / `getConceptHistory`) adds one full loop step:
+1 paced request + one more pass over the (cached) context.

- Typical turn with one lookup: 2 → **3 steps ≈ 4.5-7 s** — exactly the 1.5×
  Phase-3 median boundary at the call level; within it in wall-clock terms
  because the added step re-reads a cached prefix.
- Worst case is the hard `stopWhen` ceiling `LLM.maxToolSteps = 4`:
  4 × (~1.5-3 s gen + 0.2 s fast-lane spacing) ≈ **7-13 s**. Above 1.5× the
  median but bounded, rare (lookup only when choosing review material), and
  unchanged in kind from Phase 3 (the ceiling already exists).

## Fast-lane budget per Wave

`LLM.fastLaneCallsPerUser = 30` @ 200 ms spacing, then a 13 s/call slow lane.
The counter is in-memory per process (resets on serverless cold start).

- 10-turn Wave at 2 calls/turn = 20 calls → fits.
- At 3 calls/turn (one lookup per turn) = 30 → **exhausts the lane exactly at
  wave end**; any retry or 4-step turn tips mid-wave turns onto the 13 s
  cliff. The plan's prediction ("by turn 10") confirmed.

**Proposal:** raise `fastLaneCallsPerUser` 30 → **45** when Task 4 lands.
Rationale: the paid-tier key allows 1000 RPM and has no daily token cap
(reference_cerebras_free_tier_limits); 200 ms spacing already caps a process
at ≤300 calls/min. A Wave's total calls don't increase materially from the
raise — the same turns just avoid the artificial 13 s cliff. Shared-key
caveat (STT workload): volume impact is +~10-15 calls/wave at ~0.01¢ each,
negligible; the raise changes pacing, not spend.

## Verdict

**GO.**

- Typical lookup turn (3 steps) sits at ~1.5× the Phase-3 median — inside
  the gate. The 4-step ceiling exceeds it but is the pre-existing hard bound,
  not new latency risk.
- A full Wave stays inside acceptable budget **with the 30→45 fast-lane
  raise**; even without it, serverless cold-start resets make the cliff
  intermittent in production.

Caveat for Task 4/5: log summed `usage` from the tool loop in the smoke
forensic line (one-line change in `streamWaveTurn.live.test.ts`) so the A/B
in Task 5 can compare token cost, not just behavior.
