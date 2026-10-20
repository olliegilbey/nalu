# src/lib/config

Central configuration. These are the knobs.

- `tuning.ts`: **Every algorithm tunable in Nalu lives here.** SM-2 parameters, XP formula constants, tier advancement thresholds, scoping bounds, the custom-instructions cap, LLM call defaults and pacing, Wave length. If you find yourself hardcoding a number in a scoring/progression/spaced-repetition file, stop and add it here instead.
- Values are grouped by domain (`SM2`, `XP`, `PROGRESSION`, `SCOPING`, `PROFILE`, `FRAMEWORK`, `BASELINE`, `QUESTIONNAIRE`, `LLM`, `CEREBRAS_PRICING`, `AGENT_LOOKUP`, `WAVE`) and exported as `const` objects. Consumers import the group and read fields, e.g. `SM2.easinessFactorFloor`.
- `src/db/schema/concepts.ts` reads `SM2.initialEasinessFactor` (column default) and `SM2.easinessFactorFloor` (CHECK bound). Retuning either needs `just db-generate <name>` and a committed migration; `src/db/schemaMigrationDrift.test.ts` fails until it lands. Keep `tuning.ts` free of runtime imports: drizzle-kit loads it, and anything it imports, with the schema.
- `@/lib/config` resolves to the sibling file `src/lib/config.ts`, not this directory. It holds the Zod-validated env (`getEnv()`).
- Document the _why_ of each value inline — source (SM-2 spec, PRD), rationale, and anti-gaming implications. A reviewer tweaking a number should see the full context without opening other files.
- Never import runtime values from `src/lib/types/`. Types files hold types, validation schemas, and the literal sets those schemas enumerate over (`MC_OPTION_KEYS` in `mcOptionKey.ts`, `VERDICT_QUALITY_BANDS` in `jsonbBaseline.ts`). Tunable numbers stay here.
