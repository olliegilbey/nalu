// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import posthog from "posthog-js";
import { PostHogProvider } from "./posthog-provider";

// Mock the SDK singleton — assert on init/register without a real network client.
vi.mock("posthog-js", () => ({
  default: { init: vi.fn(), register: vi.fn() },
}));
// Mock the React wrapper so it just renders children (no PostHog context needed).
vi.mock("posthog-js/react", () => ({
  PostHogProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const KEY = "NEXT_PUBLIC_POSTHOG_KEY";
const DEV = "NEXT_PUBLIC_POSTHOG_ENABLE_DEV";

describe("PostHogProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env[KEY];
    delete process.env[DEV];
  });

  it("renders children and does not initialise when the key is absent", () => {
    render(
      <PostHogProvider>
        <span>child</span>
      </PostHogProvider>,
    );
    // getByText throws if the child is missing — its return is the assertion.
    expect(screen.getByText("child").textContent).toBe("child");
    expect(posthog.init).not.toHaveBeenCalled();
  });

  it("does not initialise in dev without the opt-in flag", () => {
    process.env[KEY] = "phc_test";
    render(
      <PostHogProvider>
        <span>child</span>
      </PostHogProvider>,
    );
    expect(posthog.init).not.toHaveBeenCalled();
  });

  it("initialises reverse-proxied and registers app:nalu when enabled", () => {
    process.env[KEY] = "phc_test";
    process.env[DEV] = "true";
    render(
      <PostHogProvider>
        <span>child</span>
      </PostHogProvider>,
    );
    expect(posthog.init).toHaveBeenCalledWith(
      "phc_test",
      expect.objectContaining({
        api_host: "/api/_lib",
        ui_host: "https://eu.posthog.com",
        person_profiles: "identified_only",
        autocapture: false,
        capture_pageview: "history_change",
        capture_pageleave: true,
      }),
    );
    expect(posthog.register).toHaveBeenCalledWith({ app: "nalu" });
  });
});
