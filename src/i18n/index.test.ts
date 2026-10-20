import { describe, it, expect } from "vitest";
import { tFill } from "./index";

describe("tFill", () => {
  it("fills a {n} placeholder in the dictionary copy", () => {
    expect(tFill("moveOn.toWave", { n: 2 })).toBe("Move on to Wave 2");
    expect(tFill("settings.remaining", { n: 969 })).toBe("969 characters left");
  });

  it("fills every named placeholder", () => {
    expect(tFill("composer.questionCounter", { current: 1, total: 3 })).toBe("1 / 3");
  });
});
