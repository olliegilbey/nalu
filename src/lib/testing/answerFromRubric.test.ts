import { describe, expect, it } from "vitest";
import { answerFromRubric } from "./answerFromRubric";

describe("answerFromRubric", () => {
  it("drops a grader lead-in so the answer reads as the learner's claim", () => {
    expect(
      answerFromRubric(
        "Accept explanation that moving transfers ownership and invalidates the source.",
      ),
    ).toBe("moving transfers ownership and invalidates the source.");
  });

  it("uses a rubric without a lead-in as-is", () => {
    const rubric = "Mentions the #[entry] attribute on the reset handler.";
    expect(answerFromRubric(rubric)).toBe(rubric);
  });

  // Live smoke 2026-10-13: a mid-claim "that" cut this answer to its last
  // clause, and the grader fairly marked it partial.
  it("keeps a claim whose only 'that' sits past the lead-in", () => {
    const rubric =
      "Answer must mention using atomic types or critical sections (e.g., disabling interrupts) to protect shared data, and that unsafe static mut must be wrapped safely.";
    expect(answerFromRubric(rubric)).toBe(rubric);
  });
});
