# src/lib/scoring

- `xp.ts`: Pure function. `calculateXP(tier, qualityScore) → number`. Base = tier × 10, multiplied by quality multiplier (5→1.5x, 4→1.0x, 3→0.75x, 2→0.25x, 1→0x, 0→0x). Rounded to integer. TDD.
- `progression.ts`: Pure function. Tier advancement requires ≥80% of current tier concepts with last quality ≥3, AND minimum 5 assessed concepts. TDD.
- These are deterministic. The LLM cannot influence XP or tier advancement. This is the anti-gaming boundary.
