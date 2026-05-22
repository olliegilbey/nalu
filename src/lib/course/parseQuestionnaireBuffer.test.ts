import { describe, it, expect } from "vitest";
import { parseQuestionnaireBuffer } from "./parseQuestionnaireBuffer";

const KEY = "q1|q2";

describe("parseQuestionnaireBuffer", () => {
  it("restores a well-formed buffer including drafts", () => {
    const raw = JSON.stringify({
      questionsKey: KEY,
      answers: ["A", null],
      step: 1,
      drafts: ["draft one", ""],
    });
    expect(parseQuestionnaireBuffer(raw, KEY, 2)).toEqual({
      answers: ["A", null],
      step: 1,
      drafts: ["draft one", ""],
    });
  });

  it("defaults drafts to blanks when the buffer predates the feature", () => {
    const raw = JSON.stringify({ questionsKey: KEY, answers: [null, null], step: 0 });
    expect(parseQuestionnaireBuffer(raw, KEY, 2)).toEqual({
      answers: [null, null],
      step: 0,
      drafts: ["", ""],
    });
  });

  it("returns null when the questionsKey does not match", () => {
    const raw = JSON.stringify({ questionsKey: "other", answers: [null], step: 0 });
    expect(parseQuestionnaireBuffer(raw, KEY, 1)).toBeNull();
  });

  it("returns null when the answers length does not match", () => {
    const raw = JSON.stringify({ questionsKey: KEY, answers: [null], step: 0 });
    expect(parseQuestionnaireBuffer(raw, KEY, 2)).toBeNull();
  });

  it("returns null when step is out of range", () => {
    const raw = JSON.stringify({ questionsKey: KEY, answers: [null, null], step: 5 });
    expect(parseQuestionnaireBuffer(raw, KEY, 2)).toBeNull();
  });

  it("returns null when drafts length does not match", () => {
    const raw = JSON.stringify({
      questionsKey: KEY,
      answers: [null, null],
      step: 0,
      drafts: ["only one"],
    });
    expect(parseQuestionnaireBuffer(raw, KEY, 2)).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseQuestionnaireBuffer("{not json", KEY, 2)).toBeNull();
  });

  it("returns null for a null or empty raw value", () => {
    expect(parseQuestionnaireBuffer(null, KEY, 2)).toBeNull();
    expect(parseQuestionnaireBuffer("", KEY, 2)).toBeNull();
  });
});
