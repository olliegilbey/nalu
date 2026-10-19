import { describe, it, expect } from "vitest";
import { interpolate } from "./index";

describe("interpolate", () => {
  it("fills each named slot in a copy string", () => {
    expect(interpolate("Turn {current} of {total}", { current: 4, total: 10 })).toBe(
      "Turn 4 of 10",
    );
  });
});
