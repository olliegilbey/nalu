import { describe, it, expect } from "vitest";
import { extractTag } from "./extractTag";

describe("extractTag", () => {
  it("extracts inner content of a tag", () => {
    expect(extractTag("<a>hello</a>", "a")).toBe("hello");
  });

  it("returns null when tag is absent", () => {
    expect(extractTag("no tags here", "assessment")).toBeNull();
  });

  it("returns first match when multiple tags present", () => {
    expect(extractTag("<x>one</x> middle <x>two</x>", "x")).toBe("one");
  });

  it("tolerates whitespace and newlines around content", () => {
    expect(extractTag("<x>\n  body\n</x>", "x")).toBe("body");
  });

  it("handles multiline content", () => {
    expect(extractTag("<x>line1\nline2</x>", "x")).toBe("line1\nline2");
  });

  it("ignores malformed (unclosed) tags", () => {
    expect(extractTag("<x>oops", "x")).toBeNull();
  });

  it("does not match nested identical tags greedily", () => {
    // First closing tag ends the match.
    expect(extractTag("<x>a</x><x>b</x>", "x")).toBe("a");
  });

  it("does not match substring tag names", () => {
    expect(extractTag("<assessments>x</assessments>", "assessment")).toBeNull();
  });

  it("extracts content from a tag embedded in surrounding prose", () => {
    const text = "Here's my explanation. <assessment>correct</assessment> Does that help?";
    expect(extractTag(text, "assessment")).toBe("correct");
  });
});
