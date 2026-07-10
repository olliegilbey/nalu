# src/lib/agents

ToolLoopAgent definitions — one file per LLM-facing stage. An agent =
model + instructions (from src/lib/prompts/) + tools + stopWhen +
`cerebrasToolLoopPrepareStep` (per-step pacing + reasoning strip — NEVER
omit it), built fresh per attempt with turn-scoped closures (collector,
lookup courseId).

Rules:

- Agents are configuration, not control flow. Stage sequencing, Wave
  budgets, XP, SM-2 live in src/lib/course/ + src/lib/{scoring,…}.
- Tools: emission tools stage into a collector (no DB writes); lookup
  tools are read-only, capped projections (AGENT_LOOKUP in tuning.ts),
  name-keyed, scoped to the server-resolved courseId by CLOSURE — a tool
  taking courseId from model input would be a cross-user read primitive.
  Never expose XP, scoring internals, row ids, or cross-user data.
- stopWhen is always stepCountIs(bounded). isLoopFinished() is banned.
- Prompt text lives in src/lib/prompts/ — agents import renderers. Agent
  instructions must stay byte-identical to `renderContext(seed,…).system`
  (tested) or the provider cache prefix breaks.

Where agency is explicitly rejected (2026-06-10 agent-loop plan): no
model-driven stage transitions in scoping; no write-capable tools; no
unbounded loops; no tool that exposes XP, scoring internals, or other
users' data.
