import { describe, it, expect } from "vitest";
import { expectNoPlaintextAnswerKey } from "@/lib/testing/expectNoPlaintextAnswerKey";
import { redactQuestion, redactQuestionnaireTurn } from "./redactQuestionnaire";
import { decodeCorrect } from "@/lib/security/obfuscateCorrect";
import { KEY_TO_INDEX } from "@/lib/types/mcOptionKey";

const OPTIONS = { A: "3", B: "4", C: "5", D: "6" } as const;

describe("redactQuestion", () => {
  it("swaps a graded MC key for an id-bound correctEnc and drops the server fields and tier", () => {
    const q = redactQuestion({
      id: "b1",
      type: "multiple_choice",
      prompt: "2+2?",
      options: OPTIONS,
      correct: "B",
      freetextRubric: "names four",
      conceptName: "addition",
      tier: 2,
    });
    if (q.type !== "multiple_choice") throw new Error("expected an MC question");
    // No `tier`: the client computes no XP, so it has no use for one.
    expect(Object.keys(q).sort()).toEqual(["correctEnc", "id", "options", "prompt", "type"]);
    expect(decodeCorrect("b1", q.correctEnc ?? "")).toBe(KEY_TO_INDEX.B);
  });

  it("sends no correctEnc for an ungraded MC question", () => {
    const q = redactQuestion({
      id: "q1",
      type: "multiple_choice",
      prompt: "Pick a goal",
      options: OPTIONS,
      freetextRubric: "no grading — informational",
    });
    if (q.type !== "multiple_choice") throw new Error("expected an MC question");
    expect(q.correctEnc).toBeUndefined();
    expectNoPlaintextAnswerKey(q);
  });

  it("drops a free-text rubric, concept name and tier", () => {
    expect(
      redactQuestion({
        id: "f1",
        type: "free_text",
        prompt: "Why?",
        freetextRubric: "explains counting on",
        conceptName: "counting",
        tier: 1,
      }),
    ).toEqual({ id: "f1", type: "free_text", prompt: "Why?" });
  });
});

describe("redactQuestionnaireTurn", () => {
  it("keeps the Turn's nesting and redacts every question", () => {
    const turn = redactQuestionnaireTurn({
      userMessage: "Quick check.",
      questions: {
        questions: [{ id: "f1", type: "free_text", prompt: "Why?", freetextRubric: "r" }],
      },
    });
    expect(turn).toEqual({
      userMessage: "Quick check.",
      questions: { questions: [{ id: "f1", type: "free_text", prompt: "Why?" }] },
    });
  });
});
