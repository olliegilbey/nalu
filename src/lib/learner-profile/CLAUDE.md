# src/lib/learner-profile

The learner's own profile, shared by every course. Today it holds custom instructions only.

- `customInstructions.ts`: `getCustomInstructions(userId)` and `saveCustomInstructions(userId, value)`. They call `src/db/queries/userProfiles.ts`. The `profile` router (`src/server/routers/profile.ts`) calls them with `ctx.userId`, so a learner reads and writes only their own text.
- One rule owns trim, cap and clear: `setCustomInstructionsInputSchema` (`src/lib/types/customInstructionsInput.ts`). It trims, then caps the trimmed text at `PROFILE.maxCustomInstructionsLength`. Empty after trim parses to null, which clears the preference. Text reaches this module already parsed.
- The profile stores the text raw. Escaping happens once, at prompt render.
- Privacy: no log line, span attribute or analytics event carries the text.
- Each Wave snapshots it as the Wave opens (issue #236): both openers read it through `getCourseOwnerCustomInstructionsInTx`. So a save applies from the next Wave. `src/lib/course/CLAUDE.md` has the details.
