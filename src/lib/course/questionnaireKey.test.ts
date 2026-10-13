import { describe, it, expect } from "vitest";
import { questionnaireKey } from "./questionnaireKey";

describe("questionnaireKey", () => {
  // Pinned byte for byte: saved answer buffers in learners' browsers carry
  // this key. Any change to the format orphans every one of them.
  it("joins the question ids with a pipe, in order", () => {
    expect(questionnaireKey([{ id: "q1" }, { id: "q2" }, { id: "q3" }])).toBe("q1|q2|q3");
    expect(questionnaireKey([{ id: "b2" }, { id: "b1" }])).toBe("b2|b1");
  });

  it("is the bare id for one question", () => {
    expect(questionnaireKey([{ id: "q1" }])).toBe("q1");
  });

  // The Composer passes `[]` when no card is shown.
  it("is empty for no questions", () => {
    expect(questionnaireKey([])).toBe("");
  });
});
