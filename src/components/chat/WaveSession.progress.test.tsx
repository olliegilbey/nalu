// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import type { UseWaveStateResult } from "@/hooks/useWaveState";

/*
 * Issue #80: the learner sees how far through the Wave they are. WaveSession
 * feeds the server's turn counts to `deriveWaveProgress` and renders the
 * strip in ChatShell's subheader slot.
 *
 * ChatShell renders only its subheader slot. The real WaveProgressBar renders.
 */
vi.mock("./ChatShell", () => ({
  ChatShell: ({ subheader }: { subheader?: React.ReactNode }) => <div>{subheader}</div>,
}));
vi.mock("./Composer", () => ({ Composer: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const wave = vi.hoisted(() => ({ value: {} as UseWaveStateResult }));
vi.mock("@/hooks/useWaveState", () => ({ useWaveState: () => wave.value }));

import { WaveSession } from "./WaveSession";
import { waveStateFixture } from "./WaveSession.fixtures";

/** The progress strip's visible label, or null when it is absent. */
function progressLabel(): string | null {
  return screen.queryByRole("progressbar", { name: "Wave progress" })?.textContent ?? null;
}

beforeEach(() => {
  cleanup();
});

describe("WaveSession progress strip", () => {
  it("shows the turn the learner is on from the server's counts", () => {
    wave.value = waveStateFixture({ turnsRemaining: 7 });
    render(<WaveSession courseId="c1" waveNumber={1} />);
    expect(progressLabel()).toBe("Turn 4 of 10");
  });

  it("shows a reloaded closed Wave complete", () => {
    wave.value = waveStateFixture({ status: "closed", turnsRemaining: 0 });
    render(<WaveSession courseId="c1" waveNumber={1} />);
    expect(progressLabel()).toBe("Wave complete");
  });

  it("shows the Wave complete as soon as this tab's close turn lands", () => {
    // The close result arrives before the refetch, so status and the count
    // are still stale: one turn left. The strip and move-on CTA flip together.
    wave.value = waveStateFixture({
      turnsRemaining: 1,
      closeResult: {
        closingMessage: "Done.",
        nextWaveNumber: 2,
        completionXpAwarded: 50,
        tierAdvancedTo: null,
      },
    });
    render(<WaveSession courseId="c1" waveNumber={1} />);
    expect(progressLabel()).toBe("Wave complete");
  });

  it("shows no strip until the state query resolves", () => {
    wave.value = waveStateFixture({ status: null, turnsRemaining: null, turnBudget: null });
    render(<WaveSession courseId="c1" waveNumber={1} />);
    expect(progressLabel()).toBeNull();
  });
});
