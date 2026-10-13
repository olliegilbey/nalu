import { describe, it, expect } from "vitest";
import {
  parseQuestionnaireBuffer,
  restoreQuestionnaireBuffer,
  serializeQuestionnaireBuffer,
} from "./questionnaireBuffer";

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
      questionIndex: 1,
      drafts: ["draft one", ""],
    });
  });

  it("defaults drafts to blanks when the buffer predates the feature", () => {
    const raw = JSON.stringify({ questionsKey: KEY, answers: [null, null], step: 0 });
    expect(parseQuestionnaireBuffer(raw, KEY, 2)).toEqual({
      answers: [null, null],
      questionIndex: 0,
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

  it("returns null when the stored question index is out of range", () => {
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

describe("restoreQuestionnaireBuffer", () => {
  it("restores a matching buffer", () => {
    const raw = JSON.stringify({ questionsKey: KEY, answers: ["A", null], step: 1 });
    expect(restoreQuestionnaireBuffer(raw, KEY, 2)).toEqual({
      answers: ["A", null],
      questionIndex: 1,
      drafts: ["", ""],
    });
  });

  it("starts blank on the first question when nothing matches", () => {
    const raw = JSON.stringify({ questionsKey: "other", answers: ["A", null], step: 1 });
    expect(restoreQuestionnaireBuffer(raw, KEY, 2)).toEqual({
      answers: [null, null],
      questionIndex: 0,
      drafts: ["", ""],
    });
    expect(restoreQuestionnaireBuffer(null, KEY, 3)).toEqual({
      answers: [null, null, null],
      questionIndex: 0,
      drafts: ["", "", ""],
    });
  });
});

describe("serializeQuestionnaireBuffer", () => {
  const buffer = { answers: ["A", null], questionIndex: 1, drafts: ["", "half typed"] };

  it("round-trips through parse", () => {
    const raw = serializeQuestionnaireBuffer(KEY, buffer);
    expect(parseQuestionnaireBuffer(raw, KEY, 2)).toEqual(buffer);
  });

  it("keeps the on-disk key `step`, so buffers saved before the rename still restore", () => {
    expect(JSON.parse(serializeQuestionnaireBuffer(KEY, buffer))).toEqual({
      questionsKey: KEY,
      answers: ["A", null],
      step: 1,
      drafts: ["", "half typed"],
    });
  });
});
