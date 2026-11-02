import { describe, it, expect } from "vitest";
import { deriveWaveRatingSave, showsWaveRatingDetails } from "./deriveWaveRatingSave";

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

  it("the payload carries each dimension given and omits the rest", () => {
    // All four given: all four sent.
    expect(
      deriveWaveRatingSave({
        ...address,
        stars: { overall: 4, difficulty: 5, pacing: 2, usefulness: 3 },
      }),
    ).toStrictEqual({
      courseId: "c1",
      waveNumber: 3,
      overall: 4,
      difficulty: 5,
      pacing: 2,
      usefulness: 3,
    });
    // Overall and pacing only: no difficulty or usefulness key, not even undefined.
    expect(deriveWaveRatingSave({ ...address, stars: { overall: 2, pacing: 4 } })).toStrictEqual({
      courseId: "c1",
      waveNumber: 3,
      overall: 2,
      pacing: 4,
    });
  });
});

describe("showsWaveRatingDetails", () => {
  it("hides the detail prompts until overall is set", () => {
    // A blank step asks one question, so the learner never faces a form.
    expect(showsWaveRatingDetails({})).toBe(false);
    // The lowest star counts: any overall value reveals them.
    expect(showsWaveRatingDetails({ overall: 1 })).toBe(true);
    expect(showsWaveRatingDetails({ overall: 5, pacing: 3 })).toBe(true);
  });
});
