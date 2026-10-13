import { describe, it, expect } from "vitest";
import { replaceAt } from "./utils";

describe("replaceAt", () => {
  it("returns a copy with one slot replaced", () => {
    const items = ["a", "b", "c"];
    expect(replaceAt(items, 1, "x")).toEqual(["a", "x", "c"]);
    expect(items).toEqual(["a", "b", "c"]);
  });

  it("extends a shorter array, like an index assignment", () => {
    // The Composer writes per-question slots before its state is sized to the
    // card, so a write past the end must not throw (unlike `Array#with`).
    expect(replaceAt<string | null>([], 0, "a")).toEqual(["a"]);
  });
});
