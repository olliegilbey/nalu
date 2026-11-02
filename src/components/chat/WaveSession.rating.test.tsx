// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { UseWaveStateResult } from "@/hooks/useWaveState";

/*
 * Issue #260: a closed Wave asks for one overall rating above the move-on
 * button. Move-on saves the rating, if given, and opens the next Wave without
 * waiting for the save.
 *
 * Renders the real WaveSession, Composer, rating step and `useWaveRating`.
 * ChatShell renders only its composer slot. The seams are the tRPC mutation,
 * the router and the toast.
 */
vi.mock("./ChatShell", () => ({
  ChatShell: ({ composer }: { composer: React.ReactNode }) => <div>{composer}</div>,
}));

const router = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// The tRPC stub keeps the hook's own options (its `onError`) and supplies a
// spy `mutationFn`, so the test sees what the save sends.
const save = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/lib/trpc", () => ({
  useTRPC: () => ({
    wave: {
      saveRating: {
        mutationOptions: (opts: object) => ({ ...opts, mutationFn: save.fn }),
      },
    },
  }),
}));

const wave = vi.hoisted(() => ({ value: {} as UseWaveStateResult }));
vi.mock("@/hooks/useWaveState", () => ({ useWaveState: () => wave.value }));

import { toast } from "sonner";
import { WaveSession } from "./WaveSession";
import { waveStateFixture } from "./WaveSession.fixtures";

/** This tab's close turn: the close result arrives before the refetch. */
const CLOSE_RESULT = {
  closingMessage: "Done.",
  nextWaveNumber: 2,
  completionXpAwarded: 50,
  tierAdvancedTo: null,
} as const;

/** Render Wave 1 of course c1 inside a fresh query client. */
function renderSession() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <WaveSession courseId="c1" waveNumber={1} />
    </QueryClientProvider>,
  );
}

const ratingGroup = () => screen.queryByRole("radiogroup", { name: "How was this Wave?" });
const moveOnButton = () => screen.getByRole("button", { name: "Move on to Wave 2" });
const star = (n: number) =>
  screen.getByRole<HTMLInputElement>("radio", { name: `${n} of 5 stars` });

/** Let any queued mutation start, so a test can assert none did. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  // A save that never settles: "without waiting" means move-on never awaits it.
  save.fn.mockReturnValue(new Promise(() => {}));
});

describe("WaveSession rating step", () => {
  it("a closed Wave shows the overall rating above move-on", () => {
    wave.value = waveStateFixture({ closeResult: CLOSE_RESULT });
    renderSession();

    const group = ratingGroup();
    expect(group).not.toBeNull();
    expect(screen.getAllByRole("radio")).toHaveLength(5);
    expect(star(1)).toBeTruthy();
    expect(star(5)).toBeTruthy();
    // The step sits directly above the button, in document order.
    expect(group!.compareDocumentPosition(moveOnButton())).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("an open Wave shows no rating step", () => {
    wave.value = waveStateFixture();
    renderSession();

    expect(ratingGroup()).toBeNull();
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });

  it("a reloaded closed Wave shows the step blank", () => {
    // No close result: the server's status alone says closed.
    wave.value = waveStateFixture({ status: "closed", turnsRemaining: 0 });
    renderSession();

    expect(ratingGroup()).not.toBeNull();
    expect(screen.getAllByRole<HTMLInputElement>("radio").some((r) => r.checked)).toBe(false);
  });

  it("move-on with no stars sends nothing and opens the next Wave", async () => {
    wave.value = waveStateFixture({ closeResult: CLOSE_RESULT });
    renderSession();

    fireEvent.click(moveOnButton());
    await flush();

    expect(router.push).toHaveBeenCalledWith("/course/c1/wave/2");
    expect(save.fn).not.toHaveBeenCalled();
  });

  it("move-on after 4 stars sends overall 4 and opens the next Wave without waiting", async () => {
    wave.value = waveStateFixture({ closeResult: CLOSE_RESULT });
    renderSession();

    fireEvent.click(star(4));
    expect(star(4).checked).toBe(true);
    fireEvent.click(moveOnButton());

    // Navigation is synchronous with the click; the save never settles.
    expect(router.push).toHaveBeenCalledWith("/course/c1/wave/2");
    await waitFor(() => expect(save.fn).toHaveBeenCalledOnce());
    expect(save.fn.mock.calls[0]![0]).toStrictEqual({ courseId: "c1", waveNumber: 1, overall: 4 });
  });

  it("a double tap on move-on sends one save", async () => {
    wave.value = waveStateFixture({ closeResult: CLOSE_RESULT });
    renderSession();

    fireEvent.click(star(4));
    // `router.push` waits on the server, so the button stays live for a beat.
    fireEvent.click(moveOnButton());
    fireEvent.click(moveOnButton());
    await flush();

    // One save per visit: one row write and one `wave_rated` event.
    expect(save.fn).toHaveBeenCalledOnce();
  });

  it("a failed save shows a toast", async () => {
    save.fn.mockRejectedValue(new Error("boom"));
    wave.value = waveStateFixture({ closeResult: CLOSE_RESULT });
    const { unmount } = renderSession();

    fireEvent.click(star(3));
    fireEvent.click(moveOnButton());
    // The page navigates at once, so the session unmounts before the save
    // fails. The toast must still show.
    unmount();

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("Couldn't save your rating", expect.anything()),
    );
  });
});
