import { describe, expect, it } from "vitest";
import { decodeCorrect, encodeCorrect } from "./obfuscateCorrect";

describe("obfuscateCorrect", () => {
  it("round-trips a (questionId, index) pair", () => {
    const enc = encodeCorrect("q-123", 2);
    expect(decodeCorrect("q-123", enc)).toBe(2);
  });

  it("returns null on questionId mismatch (binding violation)", () => {
    const enc = encodeCorrect("q-123", 2);
    expect(decodeCorrect("q-456", enc)).toBeNull();
  });

  it("returns null on malformed base64", () => {
    expect(decodeCorrect("q-123", "@@@not-base64@@@")).toBeNull();
  });

  it("returns null when decoded index is not a non-negative integer", () => {
    const bad = Buffer.from("q-123:-1", "utf8").toString("base64");
    expect(decodeCorrect("q-123", bad)).toBeNull();
  });

  it("encodes different indices to different strings", () => {
    expect(encodeCorrect("q-1", 0)).not.toEqual(encodeCorrect("q-1", 1));
  });
});
