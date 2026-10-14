import { describe, expect, it } from "vitest";
import { findJsonProseLeakIndex } from "./findJsonProseLeakIndex";

describe("findJsonProseLeakIndex", () => {
  it("flags a message that IS a raw JSON object (index 0)", () => {
    expect(findJsonProseLeakIndex('{"questions": [{"correct": "C"}]}')).toBe(0);
  });

  it("flags a pretty-printed JSON dump trailing normal prose", () => {
    const prose = 'Here is your quiz!\n{\n  "questions": []\n}';
    expect(findJsonProseLeakIndex(prose)).toBe("Here is your quiz!\n".length);
  });

  it("flags an indented line-start brace", () => {
    const prose = 'Quiz:\n  {"correct": "A"}';
    expect(findJsonProseLeakIndex(prose)).toBe("Quiz:\n  ".length);
  });

  it("ignores braces inside a fenced code block (legit teaching content)", () => {
    const prose = 'JSON objects look like this:\n```json\n{ "name": "value" }\n```\nSee?';
    expect(findJsonProseLeakIndex(prose)).toBeNull();
  });

  it("ignores braces inside a STILL-OPEN fence (fence streamed, close pending)", () => {
    const prose = 'Example:\n```json\n{ "name":';
    expect(findJsonProseLeakIndex(prose)).toBeNull();
  });

  it("ignores mid-line braces in normal prose", () => {
    const prose = 'In JSON you write { "key": "value" } - braces around pairs.';
    expect(findJsonProseLeakIndex(prose)).toBeNull();
  });

  it("flags a brace on the final, still-streaming partial line", () => {
    // The leak guard runs per delta; the brace line may not be complete yet.
    expect(findJsonProseLeakIndex("Sure thing.\n{")).toBe("Sure thing.\n".length);
  });
});
