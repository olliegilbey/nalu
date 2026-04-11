Start a new feature implementation. Argument: feature description.

1. Read the relevant CLAUDE.md files for the directories you'll touch.
2. Create a TODO list for the feature (TaskCreate).
3. For each step, explain intent before writing code.
4. Follow architecture boundaries: logic in `src/lib/`, prompts in `src/lib/prompts/`, DB in `src/db/queries/`.
5. Write tests alongside implementation (colocated). TDD for pure functions.
6. Run `just check` when complete.
7. Suggest a commit when all checks pass.
