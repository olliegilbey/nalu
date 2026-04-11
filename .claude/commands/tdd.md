Implement a pure function using TDD. Argument: function name and purpose.

1. Write the test file first (`*.test.ts` colocated next to the source file).
2. Define test cases covering: happy path, edge cases, error cases.
3. Run `just test` — confirm tests fail (red).
4. Write the minimal implementation to pass tests.
5. Run `just test` — confirm tests pass (green).
6. Refactor if needed, keeping tests green.
7. Add TSDoc to the exported function.
