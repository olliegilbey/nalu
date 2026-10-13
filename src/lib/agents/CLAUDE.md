# src/lib/agents

ToolLoopAgent definitions — one file per LLM-facing stage. An agent =
model + instructions (from src/lib/prompts/) + tools + stopWhen +
`cerebrasToolLoopPrepareStep` (per-step pacing + reasoning strip — NEVER
omit it) + an `onStepFinish` that calls `recordStepFinished` (rate-limit
headers for pacing, usage for the cost tally), built fresh per attempt with
turn-scoped closures (collector, lookup courseId). Dispatch goes through
`executeToolTurnStream` (src/lib/turn/), which drops the assembled
leading system message because `instructions` carries identical bytes.

Rules:

- Agents are configuration, not control flow. Stage sequencing, Wave
  budgets, XP, SM-2 live in src/lib/course/ + src/lib/{scoring,…}.
- Tools: emission tools stage into a collector (no DB writes); lookup
  tools are read-only projections capped by SQL `LIMIT` (AGENT_LOOKUP in
  tuning.ts), name-keyed, scoped to the server-resolved courseId by
  CLOSURE — a tool taking courseId from model input would be a cross-user
  read primitive. Never expose XP, scoring internals, row ids, or
  cross-user data. One deliberate exception: `getDueConcepts` carries
  `lastQuality` (last 0-5 quality score). It is a teaching signal, not XP,
  and the model cannot change it; it helps the tutor target weak concepts.
- stopWhen is always stepCountIs(bounded). isLoopFinished() is banned.
- Prompt text lives in src/lib/prompts/ — agents import renderers. Agent
  instructions must stay byte-identical to `renderContext(seed,…).system`
  (tested) or the provider cache prefix breaks.

Where agency is explicitly rejected (2026-06-10 agent-loop plan): no
model-driven stage transitions in scoping; no write-capable tools; no
unbounded loops; no tool that exposes XP, scoring internals, or other
users' data.
