import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// The capture reads the env schema and schedules through Next's `after`.
// Both are stubbed: `after` throws outside a Next request scope, so the stub
// records each task, and `runScheduled` plays the response finishing.
const env = vi.hoisted(() => ({ posthogKey: undefined as string | undefined }));
vi.mock("@/lib/config", () => ({ getEnv: () => ({ POSTHOG_KEY: env.posthogKey }) }));

// Test-fixture slot: the tasks `after` was handed, drained by `runScheduled`.
const scheduled = vi.hoisted(() => [] as (() => unknown)[]);
vi.mock("next/server", () => ({
  after: vi.fn((task: () => unknown) => {
    scheduled.push(task);
  }),
}));

import { after } from "next/server";
import { captureWaveRated } from "./captureWaveRated";

/** Run every task `after` was handed, as Next does once the response finishes. */
async function runScheduled(): Promise<void> {
  await Promise.all(scheduled.splice(0).map((task) => task()));
}

function run() {
  captureWaveRated({ userId: "user-1", waveNumber: 3, stars: { overall: 4, pacing: 2 } });
}

beforeEach(() => {
  env.posthogKey = "phc_test";
  scheduled.length = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("captureWaveRated", () => {
  it("POSTs the built wave_rated event to PostHog EU once the response finishes", async () => {
    vi.stubEnv("VERCEL_ENV", "preview");
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"status":"Ok"}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    run();
    // Nothing leaves before the response: the send waits for `after`.
    expect(fetchMock).not.toHaveBeenCalled();
    await runScheduled();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://eu.i.posthog.com/i/v0/e/");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body as string) as {
      event: string;
      distinct_id: string;
      properties: Record<string, unknown>;
    };
    expect(body.event).toBe("wave_rated");
    expect(body.distinct_id).toBe("user-1");
    expect(body.properties).toMatchObject({
      wave_number: 3,
      overall: 4,
      pacing: 2,
      source: "preview",
    });
    // The task is time-bounded, as the pageview's is.
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends nothing without a PostHog key", async () => {
    env.posthogKey = undefined;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    run();
    await runScheduled();

    expect(after).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("logs non-2xx capture responses (fetch does not reject on HTTP errors)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 })),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    run();
    await runScheduled();

    expect(errorSpy).toHaveBeenCalledOnce();
  });

  it("never throws when PostHog fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    expect(run).not.toThrow();
    await expect(runScheduled()).resolves.toBeUndefined();
  });

  it("never throws, and logs, when it cannot schedule the send", () => {
    // `after` throws outside a Next request scope. The save must stand anyway.
    vi.mocked(after).mockImplementationOnce(() => {
      throw new Error("`after` was called outside a request scope");
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(run).not.toThrow();
    expect(errorSpy).toHaveBeenCalledOnce();
  });
});
