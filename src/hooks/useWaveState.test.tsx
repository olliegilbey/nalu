// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { installMemoryStorage } from "@/lib/testing/memoryStorage";

// Mock sonner so we can assert toast calls without dragging the real lib in.
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Hand-shaped useChat stub (the streaming transport seam). We capture the
// options object so tests can drive onData / onFinish / onError by hand —
// the streaming analogue of the old "drive the mutation's onSuccess" pattern
// — and record sendMessage calls to assert payload forwarding.
//
// Test fixtures legitimately mutate capture buffers + "latest handler" slots —
// recording sinks for the assertion phase, not domain code. The `let` is
// required so the captured options can be reassigned across renders.
const sendMessageCalls: { message: unknown; options: unknown }[] = [];
let latestChatOptions:
  | {
      onData?: (part: { type: string; data: unknown }) => void;
      onFinish?: () => void;
      onError?: (err: Error) => void;
    }
  | undefined;
const setMessagesMock = vi.fn();
// Swappable transient message list (mirrors `currentState` below) so tests
// can exercise the streaming derivations (streamingText / streamingQuestions).
let chatMessages: unknown[] = [];

vi.mock("@ai-sdk/react", () => ({
  useChat: (opts: never) => {
    latestChatOptions = opts;
    return {
      messages: chatMessages,
      status: "ready",
      setMessages: setMessagesMock,
      sendMessage: (message: unknown, options: unknown) => {
        sendMessageCalls.push({ message, options });
        return Promise.resolve();
      },
    };
  },
}));

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
// wire payload before rendering. Mirrors the `latestChatOptions` pattern above.
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
      },
    }),
    // Dev-stub auth headers for the streaming transport; the hook calls this
    // when constructing DefaultChatTransport. Empty is fine — transport
    // config is not exercised by these tests (useChat is fully mocked).
    devUserHeaders: () => ({}),
  };
});

import { useWaveState } from "./useWaveState";
import { toast } from "sonner";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  sendMessageCalls.length = 0;
  latestChatOptions = undefined;
  setMessagesMock.mockReset();
  currentState = defaultStateData;
  chatMessages = [];
  // Fresh in-memory localStorage per test — useWaveState depends on
  // useCourseXp, and tests sharing courseId "c1" must not leak XP totals.
  installMemoryStorage();
});

describe("useWaveState", () => {
  it("derives chat entries from the chat log", async () => {
    const { result } = renderHook(() => useWaveState("c1", 1), { wrapper });
    await waitFor(() => expect(result.current.chatEntries.length).toBeGreaterThan(0));
    expect(result.current.chatEntries).toEqual([
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
            },
          ],
        },
      ],
    };

    const { result } = renderHook(() => useWaveState("c1", 1), { wrapper });
    await waitFor(() => expect(result.current.activeQuestionnaire).not.toBeNull());
    expect(result.current.activeQuestionnaire?.questionsKey).toBe("q-1");
  });

  it("submitChatText forwards a chat-text payload via sendMessage", async () => {
    const { result } = renderHook(() => useWaveState("c1", 1), { wrapper });
    await waitFor(() => expect(result.current.chatEntries.length).toBeGreaterThan(0));

    act(() => result.current.submitChatText("hello"));
    expect(sendMessageCalls).toHaveLength(1);
    expect(sendMessageCalls[0]).toEqual({
      message: { text: "hello" },
      options: { body: { payload: { kind: "chat-text", text: "hello" } } },
    });
  });

  it("captures closeResult from a close-turn data-turn-result part", async () => {
    const { result } = renderHook(() => useWaveState("c1", 1), { wrapper });
    await waitFor(() => expect(result.current.chatEntries.length).toBeGreaterThan(0));

    // Drive the transient result part by hand — the streaming analogue of
    // the old mutation onSuccess.
    act(() =>
      latestChatOptions?.onData?.({
        type: "data-turn-result",
        data: {
          kind: "close-turn",
          closingMessage: "Nicely done.",
          nextWaveId: "w2",
          nextWaveNumber: 2,
          completionXpAwarded: 50,
          tierAdvancedTo: 2,
          gradedSignals: [],
        },
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
    await waitFor(() => expect(result.current.chatEntries.length).toBeGreaterThan(0));

    act(() =>
      latestChatOptions?.onData?.({
        type: "data-turn-result",
        data: {
          kind: "mid-turn",
          gradedSignals: [
            { kind: "free-text", questionId: "q1", xpAwarded: 30 },
            { kind: "mc-index", questionId: "q2", xpAwarded: 20 },
          ],
        },
      }),
    );

    await waitFor(() => expect(result.current.xp).toBe(30));
  });

  it("derives streamingText from the last assistant message's text parts", async () => {
    chatMessages = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: "Streaming " },
          { type: "text", text: "prose." },
        ],
      },
    ];
    const { result } = renderHook(() => useWaveState("c1", 1), { wrapper });
    await waitFor(() => expect(result.current.streamingText).toBe("Streaming prose."));
    expect(result.current.streamingQuestions).toBeNull();
  });

  it("hides failed-attempt parts before the last data-turn-reset marker", async () => {
    // A validation retry: attempt 0 leaked text + a stale tool part, then the
    // server wrote the non-transient reset marker, then attempt 1 re-streamed.
    // Only the parts AFTER the marker may render.
    chatMessages = [
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: '{"questions": []}' },
          {
            type: "tool-presentQuestionnaire",
            state: "input-available",
            input: { questions: [{ id: "stale", type: "free_text", prompt: "old?" }] },
          },
          { type: "data-turn-reset", data: { attempt: 1 } },
          { type: "text", text: "Clean retry." },
          {
            type: "tool-presentQuestionnaire",
            state: "input-available",
            input: {
              questions: [
                {
                  id: "q1",
                  type: "multiple_choice",
                  prompt: "Which?",
                  options: { A: "a", B: "b", C: "c", D: "d" },
                  tier: 1,
                },
              ],
            },
          },
        ],
      },
    ];
    const { result } = renderHook(() => useWaveState("c1", 1), { wrapper });
    await waitFor(() => expect(result.current.streamingText).toBe("Clean retry."));
    expect(result.current.streamingQuestions).toEqual([
      { id: "q1", prompt: "Which?", options: ["a", "b", "c", "d"], tier: 1 },
    ]);
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

  it("surfaces an error toast when the stream errors", async () => {
    // Submitting into an already-closed wave errors server-side; the route's
    // onError forwards the guard message into the stream, and the hook's
    // onError must turn that into a visible toast instead of failing silently.
    const { result } = renderHook(() => useWaveState("c1", 1), { wrapper });
    await waitFor(() => expect(result.current.chatEntries.length).toBeGreaterThan(0));

    act(() => latestChatOptions?.onError?.(new Error("wave is closed")));
    expect(toast.error).toHaveBeenCalledWith(
      "Couldn't submit that turn",
      expect.objectContaining({ description: "wave is closed" }),
    );
    // The transient streaming bubble is dropped alongside the toast.
    expect(setMessagesMock).toHaveBeenCalled();
  });
});
