# src/lib/scoring

- `xp.ts`: Pure functions. `calculateXP(tier, qualityScore) → number` — base = tier × 10, multiplied by quality multiplier (5→1.5x, 4→1.0x, 3→0.75x, 2→0.25x, 1→0x, 0→0x). `calculateMcXp(tier, correct) → number` — MC-index path: 0 on wrong, else tier × basePerTier × `XP.mcCorrectMultiplier` (defaults to free-text q=4 equivalence). Both rounded to integer. TDD.
- `progression.ts`: Pure function. Tier advancement requires ≥80% of current tier concepts with last quality ≥3, AND minimum 5 assessed concepts. TDD.
- `baselineMerge.ts`: Pure function `mergeAndComputeXp`. Merges LLM + mechanical baseline gradings into canonical order; computes total XP using `startingTier` × per-question `qualityScore`. Mechanical entries win the dedupe (LLM never grades MC). Throws on out-of-scope tiers (defence-in-depth).
- These are deterministic. The LLM cannot influence XP or tier advancement. This is the anti-gaming boundary.
