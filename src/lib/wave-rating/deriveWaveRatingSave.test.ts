import { describe, it, expect } from "vitest";
import { deriveWaveRatingSave } from "./deriveWaveRatingSave";

const address = { courseId: "c1", waveNumber: 3 } as const;

describe("deriveWaveRatingSave", () => {
  it("returns null without an overall rating", () => {
    expect(deriveWaveRatingSave({ ...address, stars: {} })).toBeNull();
    // A dimension alone is not a save: overall comes first.
    expect(deriveWaveRatingSave({ ...address, stars: { pacing: 4 } })).toBeNull();
  });

  it("returns the Wave address with the overall rating", () => {
    expect(deriveWaveRatingSave({ ...address, stars: { overall: 4 } })).toStrictEqual({
      courseId: "c1",
      waveNumber: 3,
      overall: 4,
    });
  });

  it("carries only the dimensions given", () => {
    expect(
      deriveWaveRatingSave({ ...address, stars: { overall: 2, usefulness: 5 } }),
    ).toStrictEqual({ courseId: "c1", waveNumber: 3, overall: 2, usefulness: 5 });
  });
});
