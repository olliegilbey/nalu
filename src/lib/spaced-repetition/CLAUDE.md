# src/lib/spaced-repetition

- `sm2.ts`: Pure SM-2 function. No side effects, no DB calls. Readonly input → new state. TDD.
- `scheduler.ts`: Queries due concepts from DB, formats review injection block, excludes concepts already assessed this session. Returns empty string when nothing is due.
- Review injection is rebuilt fresh every turn. Not part of conversation history. Appended at end of system prompt.
- Quality scores: integers 0-5. Easiness factor minimum: 1.3. Quality < 3 resets repetition count, sets interval to 1 day.
