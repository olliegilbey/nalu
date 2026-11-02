import { describe, it, expect } from "vitest";
import { deriveXpTick, holdsTypedAnswer } from "./deriveXpTick";

describe("deriveXpTick", () => {
  it("pulses with the gain when the total rises", () => {
    expect(deriveXpTick(40, 65)).toEqual({ pulse: true, gain: 25 });
  });

  it("does not pulse on the first total after mount", () => {
    // A reload lands on the stored total: nothing was just earned.
    expect(deriveXpTick(undefined, 120)).toEqual({ pulse: false });
  });

  it("does not pulse on an equal total", () => {
    // The refetch after a Turn repeats the turn result's total.
    expect(deriveXpTick(65, 65)).toEqual({ pulse: false });
  });

  it("does not pulse on a drop", () => {
    expect(deriveXpTick(65, 40)).toEqual({ pulse: false });
  });
});

describe("holdsTypedAnswer", () => {
  it("is true when any answer was typed", () => {
    expect(
      holdsTypedAnswer([
        { id: "q1", kind: "mc", selected: "A" },
        { id: "q2", kind: "freetext", text: "because", fromEscape: false },
      ]),
    ).toBe(true);
  });

  it("is false for an all-MC card", () => {
    expect(holdsTypedAnswer([{ id: "q1", kind: "mc", selected: "A" }])).toBe(false);
  });
});
