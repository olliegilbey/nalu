import { describe, it, expect } from "vitest";
import { PROFILE } from "@/lib/config/tuning";
import { setCustomInstructionsInputSchema } from "./customInstructionsInput";

const CAP = PROFILE.maxCustomInstructionsLength;

/** Parse one raw text through the schema; returns the stored value or throws. */
const parse = (customInstructions: string) =>
  setCustomInstructionsInputSchema.parse({ customInstructions }).customInstructions;

describe("setCustomInstructionsInputSchema", () => {
  it("trims surrounding whitespace", () => {
    expect(parse("  \n I learn best through analogies \t\n")).toBe(
      "I learn best through analogies",
    );
  });

  it("accepts text of exactly the cap", () => {
    expect(parse("a".repeat(CAP))).toHaveLength(CAP);
  });

  it("counts the trimmed text against the cap", () => {
    expect(parse(`   ${"a".repeat(CAP)}   `)).toHaveLength(CAP);
  });

  it("rejects text one character over the cap", () => {
    expect(() => parse("a".repeat(CAP + 1))).toThrow();
  });

  it("maps whitespace-only text to null", () => {
    expect(parse(" \n\t  ")).toBeNull();
  });

  it("maps empty text to null", () => {
    expect(parse("")).toBeNull();
  });
});
