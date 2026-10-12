// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { UseScopingStateResult } from "@/hooks/useScopingState";

// The retry row lives in Onboarding's scroll children, rendered inside
// ChatShell. Stub ChatShell to just render its children (the retry row sits
// there) and Composer to nothing — the test targets the inline retry affordance,
// not the surrounding chrome. next/navigation + useCourseXp are stubbed so the
// component mounts without a router or localStorage.
vi.mock("./ChatShell", () => ({
  ChatShell: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("./Composer", () => ({ Composer: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/hooks/useCourseXp", () => ({
  useCourseXp: () => ({ xp: 0, pulseKey: 0, gainAmount: 0, addXp: vi.fn() }),
}));

const scopingState = vi.hoisted(() => ({ value: {} as UseScopingStateResult }));
vi.mock("@/hooks/useScopingState", () => ({
  useScopingState: () => scopingState.value,
}));

import { Onboarding } from "./Onboarding";

// Minimal happy-path hook return; individual tests override `failedTurn`.
function baseState(overrides: Partial<UseScopingStateResult>): UseScopingStateResult {
  return {
    chatEntries: [],
    activeQuestionnaire: null,
    scopingResult: null,
    topic: "T",
    isPending: false,
    failedTurn: null,
    submitClarify: vi.fn(),
    submitBaselineAnswers: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  cleanup();
});

describe("Onboarding retry affordance", () => {
  it("hides the retry row when no turn has failed", () => {
    scopingState.value = baseState({ failedTurn: null });
    render(<Onboarding courseId="c1" />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });

  it("renders the retry row and re-sends the turn on click when a turn failed", () => {
    const retry = vi.fn();
    scopingState.value = baseState({ failedTurn: { kind: "framework", retry } });
    render(<Onboarding courseId="c1" />);

    const button = screen.getByRole("button", { name: "Retry" });
    expect(screen.getByText("That step failed.")).toBeTruthy();
    fireEvent.click(button);
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it("disables Retry and ignores clicks while a scoping turn is pending", () => {
    const retry = vi.fn();
    scopingState.value = baseState({
      failedTurn: { kind: "baseline", retry },
      isPending: true,
    });
    render(<Onboarding courseId="c1" />);

    const button = screen.getByRole("button", { name: "Retry" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    expect(retry).not.toHaveBeenCalled();
  });

  it("hides the retry row while the failed turn's question card is restored", () => {
    // The card's own submit is the retry, so the row would be a second,
    // stale-answer affordance.
    scopingState.value = baseState({
      failedTurn: { kind: "framework", retry: vi.fn() },
      activeQuestionnaire: {
        kind: "clarify",
        questions: [],
        questionsKey: "q1",
        persistKey: "nalu:scoping:c1:clarify",
      },
    });
    render(<Onboarding courseId="c1" />);
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  });
});
