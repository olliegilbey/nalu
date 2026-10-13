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
});
