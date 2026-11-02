import { describe, it, expect } from "vitest";
import { saveWaveRatingInputSchema, WAVE_RATING_STAR_COUNT } from "./waveRatingInput";

/** A valid `wave.saveRating` input; tests override single fields. */
const base = {
  courseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  waveNumber: 1,
  overall: 3,
} as const;

describe("saveWaveRatingInputSchema", () => {
  it("accepts whole stars from 1 to 5", () => {
    expect(WAVE_RATING_STAR_COUNT).toBe(5);
    for (const star of [1, 2, 3, 4, 5]) {
      const input = { ...base, overall: star, difficulty: star, pacing: star, usefulness: star };
      expect(saveWaveRatingInputSchema.parse(input)).toEqual(input);
    }
  });

  it("rejects 0, 6, 2.5 and a missing overall", () => {
    for (const star of [0, 6, 2.5]) {
      expect(saveWaveRatingInputSchema.safeParse({ ...base, overall: star }).success).toBe(false);
      // Each dimension holds the same rule.
      for (const dimension of ["difficulty", "pacing", "usefulness"]) {
        expect(saveWaveRatingInputSchema.safeParse({ ...base, [dimension]: star }).success).toBe(
          false,
        );
      }
    }
    const { overall: _omitted, ...withoutOverall } = base;
    expect(saveWaveRatingInputSchema.safeParse(withoutOverall).success).toBe(false);
  });

  it("accepts a save with no dimensions", () => {
    expect(saveWaveRatingInputSchema.parse(base)).toEqual(base);
  });

  it("addresses the Wave as wave.getState does", () => {
    expect(saveWaveRatingInputSchema.safeParse({ ...base, courseId: "c1" }).success).toBe(false);
    expect(saveWaveRatingInputSchema.safeParse({ ...base, waveNumber: 0 }).success).toBe(false);
    expect(saveWaveRatingInputSchema.safeParse({ ...base, waveNumber: 1.5 }).success).toBe(false);
  });
});
