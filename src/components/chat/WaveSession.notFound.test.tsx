// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { UseWaveStateResult } from "@/hooks/useWaveState";

/*
 * Issue #112: a Wave URL opened in another browser is NOT_FOUND. WaveSession
 * must say so and offer a fresh start, not show an empty chat.
 *
 * ChatShell renders only its children and composer slot. The Composer stub
 * records its props, so a test can read the move-on CTA. The real
 * MessageBubble renders, so the message text is visible.
 */
vi.mock("./ChatShell", () => ({
  ChatShell: ({ children, composer }: { children: React.ReactNode; composer: React.ReactNode }) => (
    <div>
      {children}
      {composer}
    </div>
  ),
}));
type MoveOn = { readonly label: string; readonly onAdvance: () => void };
const composerProps = vi.hoisted(() => ({ moveOn: undefined as MoveOn | undefined }));
vi.mock("./Composer", () => ({
  Composer: (props: { moveOn?: MoveOn }) => {
    composerProps.moveOn = props.moveOn;
    return null;
  },
}));
const routerPush = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }));

const wave = vi.hoisted(() => ({ value: {} as UseWaveStateResult }));
vi.mock("@/hooks/useWaveState", () => ({ useWaveState: () => wave.value }));

import { WaveSession } from "./WaveSession";

/** A `useWaveState` result for an open Wave; tests override single fields. */
function waveState(overrides: Partial<UseWaveStateResult>): UseWaveStateResult {
  return {
    chatEntries: [],
    activeQuestionnaire: null,
    closeResult: null,
    status: "active",
    topic: "T",
    currentTier: 1,
    xp: 0,
    xpPulseKey: 0,
    xpGainAmount: 0,
    awardMcXp: vi.fn(),
    isPending: false,
    waveNotFound: false,
    streamingText: "",
    streamingQuestions: null,
    submitChatText: vi.fn(),
    submitQuestionnaireAnswers: vi.fn(),
    ...overrides,
  };
}

beforeEach(() => {
  cleanup();
  composerProps.moveOn = undefined;
  routerPush.mockReset();
});

describe("WaveSession wave not found", () => {
  it("says the course is missing and offers a new one", () => {
    // A failed getState resolves nothing, so status and topic stay null.
    wave.value = waveState({ waveNotFound: true, status: null, topic: null, currentTier: null });
    render(<WaveSession courseId="c1" waveNumber={1} />);

    expect(screen.getByText(/can't find this course/)).toBeTruthy();
    expect(composerProps.moveOn?.label).toBe("Start a new course");
    composerProps.moveOn?.onAdvance();
    expect(routerPush).toHaveBeenCalledWith("/");
  });

  it("shows no not-found message for a wave that loads", () => {
    wave.value = waveState({});
    render(<WaveSession courseId="c1" waveNumber={1} />);
    expect(screen.queryByText(/can't find this course/)).toBeNull();
    expect(composerProps.moveOn).toBeUndefined();
  });
});
