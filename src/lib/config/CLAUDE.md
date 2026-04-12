# src/lib/config

Central configuration. These are the knobs.

- `tuning.ts`: **Every algorithm tunable in Nalu lives here.** SM-2 parameters, XP formula constants, tier advancement thresholds. If you find yourself hardcoding a number in a scoring/progression/spaced-repetition file, stop and add it here instead.
- Values are grouped by domain (`SM2`, `XP`, `PROGRESSION`) and exported as `const` objects. Consumers import the group and read fields, e.g. `SM2.easinessFactorFloor`.
- Document the _why_ of each value inline — source (SM-2 spec, PRD), rationale, and anti-gaming implications. A reviewer tweaking a number should see the full context without opening other files.
- Never import runtime values from `src/lib/types/`. Types files hold types and validation schemas only.
