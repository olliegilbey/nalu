import { describe, it, expect } from "vitest";
import { buildWaveRatedEvent } from "./buildWaveRatedEvent";

const base = {
  apiKey: "phc_test",
  distinctId: "user-1",
  waveNumber: 3,
  stars: { overall: 4 },
  timestamp: "2026-11-02T00:00:00.000Z",
  environment: { env: "production", source: "preview", is_server: true } as const,
};

describe("buildWaveRatedEvent", () => {
  it("carries the Wave number and the stars given, and no course id, topic or text", () => {
    const e = buildWaveRatedEvent({ ...base, stars: { overall: 4, pacing: 2 } });

    expect(Object.keys(e).sort()).toEqual([
      "api_key",
      "distinct_id",
      "event",
      "properties",
      "timestamp",
    ]);
    expect(e.api_key).toBe("phc_test");
    expect(e.event).toBe("wave_rated");
    // The anon user id, as on `$pageview`, so the events join.
    expect(e.distinct_id).toBe("user-1");
    expect(e.timestamp).toBe("2026-11-02T00:00:00.000Z");
    // The exact property set: no course id, topic or learner text can ride along.
    expect(Object.keys(e.properties).sort()).toEqual([
      "$process_person_profile",
      "app",
      "env",
      "is_server",
      "overall",
      "pacing",
      "source",
      "wave_number",
    ]);
    expect(e.properties).toMatchObject({
      wave_number: 3,
      overall: 4,
      pacing: 2,
      app: "nalu",
      env: "production",
      source: "preview",
      is_server: true,
      $process_person_profile: false,
    });
  });

  it("carries every dimension when all four stars are given", () => {
    const e = buildWaveRatedEvent({
      ...base,
      stars: { overall: 5, difficulty: 3, pacing: 4, usefulness: 1 },
    });
    expect(e.properties).toMatchObject({ overall: 5, difficulty: 3, pacing: 4, usefulness: 1 });
  });

  it("omits a dimension the learner did not give", () => {
    const e = buildWaveRatedEvent(base);
    expect(e.properties).not.toHaveProperty("difficulty");
    expect(e.properties).not.toHaveProperty("pacing");
    expect(e.properties).not.toHaveProperty("usefulness");
  });
});
