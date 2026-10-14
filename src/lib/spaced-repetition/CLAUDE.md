# src/lib/spaced-repetition

- `sm2.ts`: Pure SM-2 function. No side effects, no DB calls. Readonly input → new state. TDD.
- `scheduler.ts`: Queries fresh + due concepts from DB, formats the `<concepts_for_next_wave>` injection block. No in-session exclusion — SM-2 pushes `nextReviewAt` forward, so assessed concepts naturally fall out of the next Wave's due snapshot. The renderer always emits the full envelope, using `(none)` placeholders for empty sub-lists (spec §5.4).
- Due concepts enter the Context only at Wave boundaries. At Wave start, the Wave's `dueConceptsSnapshot` renders as `<due_for_review>` in the static system prompt (`src/lib/prompts/teaching.ts`). On the close turn, `renderConceptInjection` output rides in the user envelope (`executeWaveClose.ts`), appended like any other row. Nothing is rebuilt per turn. Mid-Wave, the model can look up concept history through the read-only lookup tools in `src/lib/agents/waveLookupTools.ts`, and the due list too in `"hint"` mode; each result is appended as a `tool_result` row.
- Quality scores: integers 0-5. Easiness factor minimum: 1.3. Quality < 3 resets repetition count, sets interval to 1 day.
