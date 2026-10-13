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

  it("flags a brace on the final, still-streaming partial line", () => {
    // The leak guard runs per delta; the brace line may not be complete yet.
    expect(findJsonProseLeakIndex("Sure thing.\n{")).toBe("Sure thing.\n".length);
  });

  // --- Mid-line JSON (#156) ---------------------------------------------

  it("flags JSON that starts mid-line, at its opening brace", () => {
    const prose = 'Here is your quiz: {"questions":[{"prompt":"…","correct":"B"}]}';
    expect(findJsonProseLeakIndex(prose)).toBe("Here is your quiz: ".length);
  });

  it("flags a mid-line brace when whitespace sits between it and the quote", () => {
    const prose = 'Quiz time: {  "correct": "A"}';
    expect(findJsonProseLeakIndex(prose)).toBe("Quiz time: ".length);
  });

  it("flags a pretty-printed dump whose brace ends a prose line", () => {
    // The whitespace between `{` and the first key may include a newline.
    const prose = 'Here is your quiz: {\n  "questions": []\n}';
    expect(findJsonProseLeakIndex(prose)).toBe("Here is your quiz: ".length);
  });

  it("flags mid-line JSON after a closed inline code span on the same line", () => {
    const prose = 'Use `x` then {"correct": "B"}';
    expect(findJsonProseLeakIndex(prose)).toBe("Use `x` then ".length);
  });

  it("resets an unclosed inline code span at the end of its line", () => {
    const prose = 'A stray ` tick\nquiz: {"correct": "B"}';
    expect(findJsonProseLeakIndex(prose)).toBe("A stray ` tick\nquiz: ".length);
  });

  it("ignores JSON inside an inline code span", () => {
    const prose = 'Write an object like `{"a": 1}` in your file.';
    expect(findJsonProseLeakIndex(prose)).toBeNull();
  });

  it("ignores mid-line JSON inside a fenced code block", () => {
    const prose = 'Look:\n```js\nconst x = {"a": 1};\n```\nDone.';
    expect(findJsonProseLeakIndex(prose)).toBeNull();
  });

  it("ignores set notation", () => {
    expect(findJsonProseLeakIndex("The set {a, b} has two members.")).toBeNull();
  });

  it("ignores a lone mid-line brace with no quote after it", () => {
    expect(findJsonProseLeakIndex("In Rust, { opens a block.")).toBeNull();
  });

  it("holds a trailing mid-line brace until the next character decides", () => {
    // Per-delta streaming: a `{` that ends the prose so far is not yet a leak.
    // It becomes one when the next delta opens a quoted key.
    expect(findJsonProseLeakIndex("Here is your quiz: {")).toBeNull();
    expect(findJsonProseLeakIndex('Here is your quiz: {"')).toBe("Here is your quiz: ".length);
  });

  it("flags inline JSON in teaching prose without backticks (accepted false positive)", () => {
    // The guard cannot tell this teaching example from a leak. Was "ignores
    // mid-line braces in normal prose" before #156. The cut only truncates
    // the transient stream; chat_log keeps the full prose.
    const prose = 'In JSON you write { "key": "value" } - braces around pairs.';
    expect(findJsonProseLeakIndex(prose)).toBe("In JSON you write ".length);
  });
});
