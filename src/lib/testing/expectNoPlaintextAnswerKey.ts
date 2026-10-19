import { expect } from "vitest";

/** A plaintext grading key as a JSON key. `"correctEnc":` does not match. */
const PLAINTEXT_KEY = /"(correct|freetextRubric)":/;

/**
 * Assert a client payload carries no plaintext answer key: no `correct` and no
 * `freetextRubric`, at any depth. It checks the JSON, which is what the wire sends.
 */
export function expectNoPlaintextAnswerKey(payload: unknown): void {
  expect(JSON.stringify(payload)).not.toMatch(PLAINTEXT_KEY);
}
