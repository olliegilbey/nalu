// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { installMemoryStorage } from "@/lib/testing/memoryStorage";

// Mock sonner so we can assert toast calls without dragging the real lib in.
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Hand-shaped tRPC stub. We capture submitTurn invocations so we can assert
// the hook forwards `chat-text` / `questionnaire-answers` payloads correctly,
// and we drive onSuccess by hand to exercise the result-branch handling.
//
// Test fixtures legitimately mutate an `args[]` capture buffer + a single
// "latest handler" slot — both are recording sinks for the assertion phase,
// not domain code. The `let` is required so the captured handler can be
// reassigned across renders.
const submitTurnCalls: { args: unknown }[] = [];
// eslint-disable-next-line functional/no-let -- test-fixture handler slot
let latestOnSuccess: ((result: unknown) => void) | undefined;
// eslint-disable-next-line functional/no-let -- test-fixture handler slot
let latestOnError: ((err: unknown) => void) | undefined;

// Default wave-state fixture (chat_log-first wire shape). Individual tests
// re-assign `currentState` to exercise different chatLog shapes; the
// `vi.mock("@/lib/trpc", ...)` factory reads from this cell on each query.
const defaultStateData = {
  courseId: "c1",
  topic: "Test topic",
  waveId: "w1",
  waveNumber: 1,
  currentTier: 1,
  status: "active" as const,
  turnsRemaining: 9,
  chatLog: [{ role: "assistant", kind: "text", content: "Welcome to wave 1." }] as const,
  closeResult: null,
};

// Mutable test-fixture cell so individual tests can swap in a different
// wire payload before rendering. Mirrors the `latestOnSuccess` pattern above.
// eslint-disable-next-line functional/no-let -- test-fixture state slot
let currentState: unknown = defaultStateData;

vi.mock("@/lib/trpc", () => {
  const stateOpts = {
    queryKey: ["wave.getState", { courseId: "c1", waveNumber: 1 }] as const,
    // Read `currentState` lazily so per-test re-assignments are picked up.
    queryFn: async () => currentState,
  };
  return {
    useTRPC: () => ({
      wave: {
        getState: { queryOptions: () => stateOpts },
        submitTurn: {
          mutationOptions: (o: {
            onSuccess?: (r: unknown) => void;
            onError?: (e: unknown) => void;
          }) => ({
            mutationFn: async (args: unknown) => {
              // eslint-disable-next-line functional/immutable-data -- record into test buffer
              submitTurnCalls.push({ args });
              latestOnSuccess = o.onSuccess;
              latestOnError = o.onError;
              return { kind: "mid-turn" }; // benign default; specific tests override via latestOnSuccess
            },
          }),
        },
      },
    }),
  };
});

import { useWaveState } from "./useWaveState";
import { toast } from "sonner";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  /* eslint-disable functional/immutable-data -- reset test buffers between tests */
  submitTurnCalls.length = 0;
  latestOnSuccess = undefined;
  latestOnError = undefined;
  currentState = defaultStateData;
  /* eslint-enable functional/immutable-data */
  // Fresh in-memory localStorage per test — useWaveState now depends on
  // useCourseXp, and tests sharing courseId "c1" must not leak XP totals.
  installMemoryStorage();
});

describe("useWaveState", () => {
  it("derives turns from the chat log", async () => {
    const { result } = renderHook(() => useWaveState("c1", 1), { wrapper });
    await waitFor(() => expect(result.current.turns.length).toBeGreaterThan(0));
    expect(result.current.turns).toEqual([
      { kind: "assistant-text", content: "Welcome to wave 1." },
    ]);
    expect(result.current.activeQuestionnaire).toBeNull();
    expect(result.current.closeResult).toBeNull();
  });

  it("derives activeQuestionnaire from chatLog when a text_with_questionnaire is open", async () => {
    // Swap in a chat_log with an unanswered questionnaire as the latest assistant entry.
    currentState = {
      ...defaultStateData,
      chatLog: [
        { role: "assistant", kind: "text", content: "Welcome." },
        {
          role: "assistant",
          kind: "text_with_questionnaire",
          questionnaireId: "q-1",
          content: "Try this:",
          questions: [
            {
              id: "qa",
              type: "multiple_choice",
              prompt: "?",
              options: { A: "1", B: "2", C: "3", D: "4" },
              correctEnc: "enc",
              freetextRubric: "n/a",
            },
          ],
        },
      ],
    };

    const { result } = renderHook(() => useWaveState("c1", 1), { wrapper });
    await waitFor(() => expect(result.current.activeQuestionnaire).not.toBeNull());
    expect(result.current.activeQuestionnaire?.questionsKey).toBe("q-1");
  });

  it("submitChatText forwards a chat-text payload", async () => {
    const { result } = renderHook(() => useWaveState("c1", 1), { wrapper });
    await waitFor(() => expect(result.current.turns.length).toBeGreaterThan(0));

    act(() => result.current.submitChatText("hello"));
    await waitFor(() => expect(submitTurnCalls.length).toBe(1));
    expect(submitTurnCalls[0]?.args).toEqual({
      courseId: "c1",
      waveNumber: 1,
      payload: { kind: "chat-text", text: "hello" },
    });
  });

  it("captures closeResult from a close-turn mutation response", async () => {
    const { result } = renderHook(() => useWaveState("c1", 1), { wrapper });
    await waitFor(() => expect(result.current.turns.length).toBeGreaterThan(0));

    // Fire the mutation, then drive onSuccess by hand with a close-turn result.
    act(() => result.current.submitChatText("done"));
    await waitFor(() => expect(latestOnSuccess).toBeDefined());

    act(() =>
      latestOnSuccess?.({
        kind: "close-turn",
        closingMessage: "Nicely done.",
        nextWaveId: "w2",
        nextWaveNumber: 2,
        completionXpAwarded: 50,
        tierAdvancedTo: 2,
        gradedSignals: [],
      }),
    );

    await waitFor(() => expect(result.current.closeResult).not.toBeNull());
    expect(result.current.closeResult).toEqual({
      closingMessage: "Nicely done.",
      nextWaveNumber: 2,
      completionXpAwarded: 50,
      tierAdvancedTo: 2,
    });
    await waitFor(() => expect(result.current.xp).toBe(50));
  });

  it("adds free-text XP to the badge and skips mc-index signals", async () => {
    const { result } = renderHook(() => useWaveState("c1", 1), { wrapper });
    await waitFor(() => expect(result.current.turns.length).toBeGreaterThan(0));

    act(() => result.current.submitChatText("an answer"));
    await waitFor(() => expect(latestOnSuccess).toBeDefined());

    act(() =>
      latestOnSuccess?.({
        kind: "mid-turn",
        gradedSignals: [
          { kind: "free-text", questionId: "q1", xpAwarded: 30 },
          { kind: "mc-index", questionId: "q2", xpAwarded: 20 },
        ],
      }),
    );

    await waitFor(() => expect(result.current.xp).toBe(30));
  });

  it("exposes the course topic and current tier", async () => {
    const { result } = renderHook(() => useWaveState("c1", 1), { wrapper });
    await waitFor(() => expect(result.current.topic).toBe("Test topic"));
    expect(result.current.currentTier).toBe(1);
  });

  it("threads the server-authoritative status through the hook", async () => {
    // Status starts null (query unresolved), then settles to the wire value.
    const { result } = renderHook(() => useWaveState("c1", 1), { wrapper });
    expect(result.current.status).toBeNull();
    await waitFor(() => expect(result.current.status).toBe("active"));
  });

  it("exposes status 'closed' for a reloaded closed wave", async () => {
    // A reloaded closed wave: getState returns status "closed" and no
    // closeResult. The page derives the move-on affordance from `status`.
    currentState = { ...defaultStateData, status: "closed" as const };
    const { result } = renderHook(() => useWaveState("c1", 1), { wrapper });
    await waitFor(() => expect(result.current.status).toBe("closed"));
    expect(result.current.closeResult).toBeNull();
  });

  it("surfaces an error toast when a turn submission rejects", async () => {
    // Submitting into an already-closed wave rejects server-side. The onError
    // handler must turn that into a visible toast instead of failing silently.
    // Driven by hand (like the onSuccess test) — the tRPC stub's
    // `mutationOptions` only forwards `mutationFn`, so react-query never runs
    // the registered callbacks; we capture and invoke them directly.
    const { result } = renderHook(() => useWaveState("c1", 1), { wrapper });
    await waitFor(() => expect(result.current.turns.length).toBeGreaterThan(0));

    act(() => result.current.submitChatText("continue"));
    await waitFor(() => expect(latestOnError).toBeDefined());

    act(() => latestOnError?.(new Error("wave is closed")));
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't submit that turn",
      expect.objectContaining({ description: "wave is closed" }),
    );
  });
});
