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
import { waveStateFixture } from "./WaveSession.fixtures";

beforeEach(() => {
  cleanup();
  composerProps.moveOn = undefined;
  routerPush.mockReset();
});

describe("WaveSession wave not found", () => {
  it("says the lesson is missing and offers a new course", () => {
    // A failed getState resolves nothing, so its fields stay null.
    wave.value = waveStateFixture({
      waveNotFound: true,
      status: null,
      topic: null,
      turnsRemaining: null,
      turnBudget: null,
    });
    render(<WaveSession courseId="c1" waveNumber={1} />);

    // "Lesson", not "course": NOT_FOUND also covers a Wave number the
    // learner's own course lacks (issue #230).
    expect(screen.getByText(/can't find this lesson/)).toBeTruthy();
    expect(screen.queryByText(/can't find this course/)).toBeNull();
    expect(composerProps.moveOn?.label).toBe("Start a new course");
    composerProps.moveOn?.onAdvance();
    expect(routerPush).toHaveBeenCalledWith("/");
  });

  it("shows no not-found message for a wave that loads", () => {
    wave.value = waveStateFixture({});
    render(<WaveSession courseId="c1" waveNumber={1} />);
    expect(screen.queryByText(/can't find this lesson/)).toBeNull();
    expect(composerProps.moveOn).toBeUndefined();
  });
});
