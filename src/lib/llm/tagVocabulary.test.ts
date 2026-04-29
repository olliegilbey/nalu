import { describe, it, expect } from "vitest";
import {
  comprehensionSignalSchema,
  assessmentSchema,
  nextLessonBlueprintSchema,
  courseSummaryUpdateSchema,
  TEACHING_TURN_TAGS,
  HARNESS_INJECTION_TAGS,
} from "./tagVocabulary";

describe("tag vocabulary", () => {
  it("validates a comprehension signal with required tier", () => {
    expect(
      comprehensionSignalSchema.parse({
        concept_name: "aliasing XOR mutability",
        tier: 2,
        demonstrated_quality: 4,
        evidence: "got it",
      }),
    ).toBeDefined();
  });

  it("rejects a comprehension signal missing tier", () => {
    expect(() =>
      comprehensionSignalSchema.parse({
        concept_name: "x",
        demonstrated_quality: 4,
        evidence: "y",
      }),
    ).toThrow();
  });

  it("validates an assessment with one MC question", () => {
    expect(
      assessmentSchema.parse({
        questions: [
          {
            question_id: "q1",
            concept_name: "c",
            tier: 1,
            type: "multiple_choice",
            question: "?",
            options: { A: "a", B: "b" },
            correct: "A",
          },
        ],
      }),
    ).toBeDefined();
  });

  it("validates a next_lesson_blueprint", () => {
    expect(
      nextLessonBlueprintSchema.parse({ topic: "t", outline: ["a"], openingText: "hi" }),
    ).toBeDefined();
  });

  it("validates a course_summary_update", () => {
    expect(courseSummaryUpdateSchema.parse({ summary: "x" })).toBeDefined();
  });

  it("enumerates expected tags", () => {
    expect(TEACHING_TURN_TAGS).toContain("response");
    expect(HARNESS_INJECTION_TAGS).toContain("user_message");
  });
});
