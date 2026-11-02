// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import type { UseScopingStateResult } from "@/hooks/useScopingState";
import type { RawComposerAnswer } from "@/lib/course/shapeQuestionnaireAnswers";
import { playCorrect } from "@/lib/sound";

// The retry row lives in Onboarding's scroll children, rendered inside
// ChatShell. Stub ChatShell to just render its children (the retry row sits
// there) and its composer slot, and Composer to nothing — the tests target the
// scroll content, not the surrounding chrome. The ChatShell stub records the
// badge's props; the Composer stub records its props, so a test can read the
// move-on CTA and submit a card. next/navigation is stubbed so the component
// mounts without a router.
type BadgeProps = { readonly xp?: number; readonly xpPulseKey?: number };
const shellProps = vi.hoisted(() => ({ badge: {} as BadgeProps }));
vi.mock("./ChatShell", () => ({
  ChatShell: ({
    children,
    composer,
    ...badge
  }: BadgeProps & { children: React.ReactNode; composer: React.ReactNode }) => {
    shellProps.badge = badge;
    return (
      <div>
        {children}
        {composer}
      </div>
    );
  },
}));
type MoveOn = { readonly label: string; readonly onAdvance: () => void };
const composerProps = vi.hoisted(() => ({
  moveOn: undefined as MoveOn | undefined,
  onComplete: undefined as ((answers: readonly RawComposerAnswer[]) => void) | undefined,
}));
vi.mock("./Composer", () => ({
  Composer: (props: {
    moveOn?: MoveOn;
    onComplete?: (answers: readonly RawComposerAnswer[]) => void;
  }) => {
    composerProps.moveOn = props.moveOn;
    composerProps.onComplete = props.onComplete;
    return null;
  },
}));
const routerPush = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }));
// WebAudio is not under test: spy on the badge's typed-answer sound.
vi.mock("@/lib/sound", () => ({ playCorrect: vi.fn() }));

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
    totalXp: 0,
    isPending: false,
    failedTurn: null,
    courseNotFound: false,
    submitClarify: vi.fn(),
    submitBaselineAnswers: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  cleanup();
  composerProps.moveOn = undefined;
  composerProps.onComplete = undefined;
  shellProps.badge = {};
  routerPush.mockReset();
  vi.mocked(playCorrect).mockClear();
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

describe("Onboarding course not found", () => {
  it("says the course is missing and offers a new one", () => {
    scopingState.value = baseState({ courseNotFound: true, topic: null });
    render(<Onboarding courseId="c1" />);

    expect(screen.getByText(/can't find this course/)).toBeTruthy();
    expect(composerProps.moveOn?.label).toBe("Start a new course");
    composerProps.moveOn?.onAdvance();
    expect(routerPush).toHaveBeenCalledWith("/");
  });

  it("shows no not-found message for a course that loads", () => {
    scopingState.value = baseState({});
    render(<Onboarding courseId="c1" />);
    expect(screen.queryByText(/can't find this course/)).toBeNull();
    expect(composerProps.moveOn).toBeUndefined();
  });
});

describe("Onboarding XP badge", () => {
  /** A baseline card with one MC and one free-text question. */
  const baselineCard = {
    kind: "baseline" as const,
    questions: [
      { id: "b1", prompt: "2+2?", options: ["3", "4", "5", "6"] },
      { id: "b2", prompt: "Why?", options: [] },
    ],
    questionsKey: "b1|b2",
    persistKey: "nalu:scoping:c1:baseline",
  };
  const [mcQuestion, freeTextQuestion] = baselineCard.questions;

  /** Submit the card, then land the close: the refetched total rises to 45. */
  function submitAndClose(answers: readonly RawComposerAnswer[]) {
    scopingState.value = baseState({ activeQuestionnaire: baselineCard });
    const { rerender } = render(<Onboarding courseId="c1" />);
    act(() => composerProps.onComplete?.(answers));
    scopingState.value = baseState({ totalXp: 45 });
    rerender(<Onboarding courseId="c1" />);
  }

  it("shows getState's totalXp in the header badge", () => {
    scopingState.value = baseState({ totalXp: 45 });
    render(<Onboarding courseId="c1" />);
    expect(shellProps.badge.xp).toBe(45);
    // The first total after mount is not a gain.
    expect(shellProps.badge.xpPulseKey).toBe(0);
  });

  it("plays the correct sound on the close's tick after a typed baseline answer", () => {
    submitAndClose([
      { question: mcQuestion!, answer: "4" },
      { question: freeTextQuestion!, answer: "Because counting on" },
    ]);
    expect(shellProps.badge.xp).toBe(45);
    expect(shellProps.badge.xpPulseKey).toBe(1);
    expect(playCorrect).toHaveBeenCalledTimes(1);
  });

  it("ticks silently after an all-MC baseline", () => {
    // Each correct pick already played its sound at confirm.
    submitAndClose([{ question: mcQuestion!, answer: "4" }]);
    expect(shellProps.badge.xpPulseKey).toBe(1);
    expect(playCorrect).not.toHaveBeenCalled();
  });
});
