# src/lib/spaced-repetition

- `sm2.ts`: Pure SM-2 function. No side effects, no DB calls. Readonly input → new state. TDD.
- `scheduler.ts`: Queries fresh + due concepts from DB, formats the `<concepts_for_next_wave>` injection block. No in-session exclusion — SM-2 pushes `nextReviewAt` forward, so assessed concepts naturally fall out of the next Wave's due snapshot. The renderer always emits the full envelope, using `(none)` placeholders for empty sub-lists (spec §5.4).
- Review injection is rebuilt fresh every turn. Not part of conversation history. Appended at end of system prompt.
- Quality scores: integers 0-5. Easiness factor minimum: 1.3. Quality < 3 resets repetition count, sets interval to 1 day.
