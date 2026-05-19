// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

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

const stateData = {
  courseId: "c1",
  waveId: "w1",
  waveNumber: 1,
  currentTier: 1,
  status: "active" as const,
  turnsRemaining: 9,
  messages: [
    {
      id: "a1",
      turnIndex: 0,
      seq: 0,
      kind: "assistant_response" as const,
      role: "assistant" as const,
      content: "Welcome to wave 1.",
    },
  ],
  openQuestionnaire: null,
  closeResult: null,
};

vi.mock("@/lib/trpc", () => {
  const stateOpts = {
    queryKey: ["wave.getState", { courseId: "c1", waveNumber: 1 }] as const,
    queryFn: async () => stateData,
  };
  return {
    useTRPC: () => ({
      wave: {
        getState: { queryOptions: () => stateOpts },
        submitTurn: {
          mutationOptions: (o: { onSuccess?: (r: unknown) => void }) => ({
            mutationFn: async (args: unknown) => {
              // eslint-disable-next-line functional/immutable-data -- record into test buffer
              submitTurnCalls.push({ args });
              latestOnSuccess = o.onSuccess;
              return { kind: "mid-turn" }; // benign default; specific tests override via latestOnSuccess
            },
          }),
        },
      },
    }),
  };
});

import { useWaveState } from "./useWaveState";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  /* eslint-disable functional/immutable-data -- reset test buffers between tests */
  submitTurnCalls.length = 0;
  latestOnSuccess = undefined;
  /* eslint-enable functional/immutable-data */
});

describe("useWaveState", () => {
  it("derives turns from the message log", async () => {
    const { result } = renderHook(() => useWaveState("c1", 1), { wrapper });
    await waitFor(() => expect(result.current.turns.length).toBeGreaterThan(0));
    expect(result.current.turns).toEqual([
      { kind: "assistant-text", content: "Welcome to wave 1." },
    ]);
    expect(result.current.activeQuestionnaire).toBeNull();
    expect(result.current.closeResult).toBeNull();
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
  });
});
