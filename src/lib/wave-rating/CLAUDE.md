# src/lib/wave-rating

The Wave rating: the learner's stars for one closed Wave (issues #259, #260, #261). Feedback, never score.

- `saveWaveRating.ts`: `saveWaveRating({ userId, courseId, waveNumber, stars })`. The `wave.saveRating` router calls it with `ctx.userId`. Guards run in order. A missing Wave, or a course another learner owns, fails NOT_FOUND with one message, as in `getWaveState`. An open Wave fails PRECONDITION_FAILED. Then it upserts the row (`src/db/queries/waveRatings.ts`) and calls `captureWaveRated`. A refusal writes nothing and sends no event. It returns the stored stars.
- `deriveWaveRatingSave.ts`: the rating step's two pure rules for the client. `deriveWaveRatingSave` decides the save. No overall rating returns null, so move-on sends nothing. Otherwise it returns the `wave.saveRating` input with each star given and no key for the rest. `useWaveRating` (`src/hooks/`) calls it. `showsWaveRatingDetails` decides the reveal: the difficulty, pacing and usefulness prompts show only once overall holds a value. `WaveRatingStep` calls it, so the hook holds no decision.
- One rule owns the stars: `saveWaveRatingInputSchema` (`src/lib/types/waveRatingInput.ts`). Each star is a whole number from 1 to `WAVE_RATING_STAR_COUNT`; the `wave_ratings` CHECKs hold the same bound. Overall is required; difficulty, pacing and usefulness are optional. Stars reach this module already parsed.
- A save replaces the row whole. A dimension the latest save omits is stored null. `rated_at` moves to each save.
- Never score: nothing here reads or writes XP, SM-2, tiers, the Context or the chat log. No prompt renderer, Context loader, scoring or SM-2 code reads `wave_ratings`. The LLM never sees a rating.
- Analytics: `captureWaveRated` (`src/lib/analytics/`) sends one `wave_rated` event per save, through Next's `after`, so it runs after the response. It carries the Wave number and the stars only: no course id, topic or text. It never throws, and sends nothing without `POSTHOG_KEY`. `after` throws outside a Next request scope, so router tests mock that module.
- Privacy: no log line carries the stars.
