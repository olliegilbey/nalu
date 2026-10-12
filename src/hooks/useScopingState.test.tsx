// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
} from "@tanstack/react-query";
import type { ReactNode } from "react";

// Mock tRPC context with hand-shaped queryOptions/mutationOptions. Unlike a
// pass-through-only stub, the mutationOptions here forward `o` (onMutate /
// onSuccess / onError) straight to react-query and swap in a controllable
// `mutationFn` — so the real mutation lifecycle drives our retry wiring. The
// `hoisted` handle lets each test flip `stateData` and make a Turn reject.
const hoisted = vi.hoisted(() => {
  const clarifyState = {
    courseId: "c1",
    status: "scoping",
    topic: "T",
    clarification: {
      userMessage: "intro",
      questions: [{ id: "q1", type: "free_text", prompt: "Why?", freetextRubric: "n/a" }],
      responses: [],
    },
    framework: null,
    baseline: null,
    scopingResult: null,
  } as Record<string, unknown>;
  return {
    clarifyState,
    stateData: clarifyState as Record<string, unknown>,
    // When set, `course.getState` rejects with it. `getStateCalls` counts
    // fetches, so a test can assert the hook did not retry.
    stateError: null as unknown,
    getStateCalls: 0,
    // Typed via `vi.fn`'s generic so `.mock.calls[i][0]` is the passed vars
    // (tests assert on it) while the implementation itself ignores the arg.
    frameworkFn: vi.fn<(vars: unknown) => Promise<unknown>>(async () => ({})),
    baselineFn: vi.fn<(vars: unknown) => Promise<unknown>>(async () => ({})),
    submitBaselineFn: vi.fn<(vars: unknown) => Promise<unknown>>(async () => ({
      freeTextXpAwarded: 0,
    })),
  };
});

// Framework present + baseline pending → baseline questionnaire is active and
// the auto-dispatch effect is inert (baseline already exists), so this state
// isolates the submitBaseline submit path.
const baselineState: Record<string, unknown> = {
  courseId: "c1",
  status: "scoping",
  topic: "T",
  clarification: {
    userMessage: "intro",
    questions: [],
    responses: [{ questionId: "q1", freetext: "x" }],
  },
  framework: { tiers: [{ id: "t1", title: "Tier", concepts: [] }] },
  baseline: {
    userMessage: "quiz",
    questions: [
      {
        id: "b1",
        type: "multiple_choice",
        prompt: "P?",
        options: ["A", "B", "C", "D"],
        correct: "A",
      },
    ],
    responses: [],
  },
  scopingResult: null,
};

// Framework present, baseline still null → the auto-dispatch effect fires
// generateBaseline. Exercises the baseline auto-dispatch failure path.
const frameworkOnlyState: Record<string, unknown> = {
  ...baselineState,
  baseline: null,
};

vi.mock("@/lib/trpc", () => {
  const stateOpts = {
    queryKey: ["course.getState", { courseId: "c1" }] as const,
    queryFn: async () => {
      hoisted.getStateCalls += 1;
      if (hoisted.stateError) throw hoisted.stateError;
      return hoisted.stateData;
    },
  };
  type Opts = Record<string, unknown>;
  return {
    useTRPC: () => ({
      course: {
        getState: { queryOptions: () => stateOpts },
        generateFramework: {
          mutationOptions: (o: Opts) => ({ ...o, mutationFn: hoisted.frameworkFn }),
        },
        generateBaseline: {
          mutationOptions: (o: Opts) => ({ ...o, mutationFn: hoisted.baselineFn }),
        },
        submitBaseline: {
          mutationOptions: (o: Opts) => ({ ...o, mutationFn: hoisted.submitBaselineFn }),
        },
      },
    }),
  };
});

import { createQueryClient } from "@/lib/queryClient";
import { useScopingState } from "./useScopingState";

// Scoping closed: the state a refetch returns once submitBaseline committed.
const closedState: Record<string, unknown> = {
  ...baselineState,
  status: "active",
  scopingResult: { closingMessage: "done", startingTier: 1 },
};

// A reload after a failed framework Turn: the clarify answers were saved
// before the LLM call, but no framework landed (issue #103).
const strandedFrameworkState: Record<string, unknown> = {
  ...hoisted.clarifyState,
  clarification: {
    userMessage: "intro",
    questions: [{ id: "q1", type: "free_text", prompt: "Why?", freetextRubric: "n/a" }],
    responses: [{ questionId: "q1", freetext: "because" }],
  },
};

// A reload after a failed scoping-close Turn: the baseline answers were saved
// before the LLM call, but scoping never closed (issue #103).
const strandedCloseState: Record<string, unknown> = {
  ...baselineState,
  baseline: {
    ...(baselineState.baseline as Record<string, unknown>),
    responses: [{ questionId: "b1", choice: "A" }],
  },
};

// Test-fixture slot: the latest wrapper's client, so a test can force a refetch.
let queryClient: QueryClient | null = null;

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  queryClient = qc;
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  // Reset shared mock state so tests don't leak stage/rejection setup.
  hoisted.stateData = hoisted.clarifyState;
  hoisted.stateError = null;
  hoisted.getStateCalls = 0;
  hoisted.frameworkFn.mockReset();
  hoisted.baselineFn.mockReset();
  hoisted.submitBaselineFn.mockReset();
  hoisted.frameworkFn.mockResolvedValue({});
  hoisted.baselineFn.mockResolvedValue({});
  hoisted.submitBaselineFn.mockResolvedValue({ freeTextXpAwarded: 0 });
  // Best-effort localStorage clear. Some Bun + jsdom combinations expose a
  // partial Storage shim without `.clear()` — guard the call.
  if (typeof window !== "undefined" && typeof window.localStorage?.clear === "function") {
    window.localStorage.clear();
  }
});

describe("useScopingState", () => {
  it("derives chat entries + an active clarify questionnaire", async () => {
    const { result } = renderHook(() => useScopingState("c1"), { wrapper });
    await waitFor(() => expect(result.current.chatEntries.length).toBeGreaterThan(0));

    const kinds = result.current.chatEntries.map((t) => t.kind);
    // ChatEntry union is phase-agnostic post-Task-15: topic becomes user-text and
    // clarify-intro becomes assistant-text.
    expect(kinds).toContain("user-text");
    expect(kinds).toContain("assistant-text");
    expect(result.current.activeQuestionnaire).not.toBeNull();
    expect(result.current.activeQuestionnaire?.kind).toBe("clarify");
    expect(result.current.activeQuestionnaire?.persistKey).toBe("nalu:scoping:c1:clarify");
  });

  it("exposes the course topic", async () => {
    const { result } = renderHook(() => useScopingState("c1"), { wrapper });
    await waitFor(() => expect(result.current.topic).toBe("T"));
  });

  it("starts with no failed turn", async () => {
    const { result } = renderHook(() => useScopingState("c1"), { wrapper });
    await waitFor(() => expect(result.current.activeQuestionnaire?.kind).toBe("clarify"));
    expect(result.current.failedTurn).toBeNull();
  });

  it("records a failed framework turn, then a retry re-dispatches identical variables and clears it", async () => {
    hoisted.frameworkFn.mockRejectedValueOnce(new Error("429"));
    const { result } = renderHook(() => useScopingState("c1"), { wrapper });
    await waitFor(() => expect(result.current.activeQuestionnaire?.kind).toBe("clarify"));

    const answers = [{ questionId: "q1", freetext: "because" }];
    act(() => result.current.submitClarify(answers));

    await waitFor(() => expect(result.current.failedTurn?.kind).toBe("framework"));
    expect(hoisted.frameworkFn.mock.calls[0]?.[0]).toEqual({ courseId: "c1", responses: answers });

    // Retry succeeds (default resolve): identical variables re-sent, row cleared.
    hoisted.frameworkFn.mockClear();
    act(() => result.current.failedTurn?.retry());
    await waitFor(() => expect(result.current.failedTurn).toBeNull());
    expect(hoisted.frameworkFn.mock.calls[0]?.[0]).toEqual({ courseId: "c1", responses: answers });
  });

  it("records a failed submitBaseline as a scopingClose turn, then a retry re-sends identical variables and clears it", async () => {
    hoisted.stateData = baselineState;
    hoisted.submitBaselineFn.mockRejectedValueOnce(new Error("429"));
    const { result } = renderHook(() => useScopingState("c1"), { wrapper });
    await waitFor(() => expect(result.current.activeQuestionnaire?.kind).toBe("baseline"));

    const answers = [{ id: "b1", kind: "mc" as const, selected: "A" as const }];
    act(() => result.current.submitBaselineAnswers(answers));

    await waitFor(() => expect(result.current.failedTurn?.kind).toBe("scopingClose"));
    expect(hoisted.submitBaselineFn.mock.calls[0]?.[0]).toEqual({ courseId: "c1", answers });

    // Retry succeeds (default resolve): identical variables re-sent, row cleared.
    hoisted.submitBaselineFn.mockClear();
    act(() => result.current.failedTurn?.retry());
    await waitFor(() => expect(result.current.failedTurn).toBeNull());
    expect(hoisted.submitBaselineFn.mock.calls[0]?.[0]).toEqual({ courseId: "c1", answers });
  });

  it("records a failed baseline auto-dispatch with the baseline kind, then a retry re-sends identical variables and clears it", async () => {
    hoisted.stateData = frameworkOnlyState;
    hoisted.baselineFn.mockRejectedValue(new Error("429"));
    const { result } = renderHook(() => useScopingState("c1"), { wrapper });

    await waitFor(() => expect(result.current.failedTurn?.kind).toBe("baseline"));
    expect(hoisted.baselineFn.mock.calls[0]?.[0]).toEqual({ courseId: "c1" });

    // The guard stays set on error, so only Retry re-sends. Make it succeed.
    hoisted.baselineFn.mockReset();
    hoisted.baselineFn.mockResolvedValue({});
    act(() => result.current.failedTurn?.retry());
    await waitFor(() => expect(result.current.failedTurn).toBeNull());
    expect(hoisted.baselineFn).toHaveBeenCalledTimes(1);
    expect(hoisted.baselineFn.mock.calls[0]?.[0]).toEqual({ courseId: "c1" });
  });

  it("drops a failed scopingClose once a refetch shows scoping closed on the server", async () => {
    // The server committed, but the reply never reached the client.
    hoisted.stateData = baselineState;
    hoisted.submitBaselineFn.mockRejectedValueOnce(new Error("network"));
    const { result } = renderHook(() => useScopingState("c1"), { wrapper });
    await waitFor(() => expect(result.current.activeQuestionnaire?.kind).toBe("baseline"));

    act(() => result.current.submitBaselineAnswers([{ id: "b1", kind: "mc", selected: "A" }]));
    await waitFor(() => expect(result.current.failedTurn?.kind).toBe("scopingClose"));

    hoisted.stateData = closedState;
    await act(async () => {
      await queryClient?.invalidateQueries();
    });
    await waitFor(() => expect(result.current.scopingResult).not.toBeNull());
    expect(result.current.failedTurn).toBeNull();
  });

  it("offers a framework Retry on reload when clarify answers were saved but no framework landed", async () => {
    hoisted.stateData = strandedFrameworkState;
    const { result } = renderHook(() => useScopingState("c1"), { wrapper });

    // No question card comes back, so the Retry row is the only way on.
    await waitFor(() => expect(result.current.failedTurn?.kind).toBe("framework"));
    expect(result.current.activeQuestionnaire).toBeNull();

    // Retry re-sends the saved answers.
    act(() => result.current.failedTurn?.retry());
    await waitFor(() => expect(hoisted.frameworkFn).toHaveBeenCalledTimes(1));
    expect(hoisted.frameworkFn.mock.calls[0]?.[0]).toEqual({
      courseId: "c1",
      responses: [{ questionId: "q1", freetext: "because" }],
    });
  });

  it("offers a scopingClose Retry on reload when baseline answers were saved but scoping never closed", async () => {
    hoisted.stateData = strandedCloseState;
    const { result } = renderHook(() => useScopingState("c1"), { wrapper });

    await waitFor(() => expect(result.current.failedTurn?.kind).toBe("scopingClose"));
    expect(result.current.activeQuestionnaire).toBeNull();

    // Retry re-sends the saved answers in the submitBaseline wire shape.
    act(() => result.current.failedTurn?.retry());
    await waitFor(() => expect(hoisted.submitBaselineFn).toHaveBeenCalledTimes(1));
    expect(hoisted.submitBaselineFn.mock.calls[0]?.[0]).toEqual({
      courseId: "c1",
      answers: [{ id: "b1", kind: "mc", selected: "A" }],
    });
  });

  it("offers no reload Retry while the Turn that saved the answers is still in flight", async () => {
    // The server saves the answers before the LLM call, so a refetch mid-call
    // looks like a stranded Turn. The in-flight call must not show a Retry.
    let finishFramework: (value: unknown) => void = () => undefined;
    hoisted.frameworkFn.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFramework = resolve;
        }),
    );
    const { result } = renderHook(() => useScopingState("c1"), { wrapper });
    await waitFor(() => expect(result.current.activeQuestionnaire?.kind).toBe("clarify"));

    act(() => result.current.submitClarify([{ questionId: "q1", freetext: "because" }]));
    hoisted.stateData = strandedFrameworkState;
    await act(async () => {
      await queryClient?.invalidateQueries();
    });
    await waitFor(() => expect(result.current.activeQuestionnaire).toBeNull());
    expect(result.current.failedTurn).toBeNull();

    // Let the in-flight call settle so the test leaves no pending mutation.
    await act(async () => {
      finishFramework({});
      await Promise.resolve();
    });
  });
});

describe("useScopingState course not found", () => {
  afterEach(() => {
    // Hand focus and network state back to the browser defaults.
    focusManager.setFocused(undefined);
    onlineManager.setOnline(true);
  });

  /** Render the hook against a NOT_FOUND getState, on the app's QueryClient. */
  async function renderNotFound() {
    // getState is ownership-scoped: another browser's course is NOT_FOUND too.
    hoisted.stateError = Object.assign(new Error("course not found"), {
      data: { code: "NOT_FOUND", httpStatus: 404 },
    });
    // The app's QueryClient, unlike the shared wrapper (`retry: false`). Its
    // defaults must stop refetching a course that will not appear.
    const qc = createQueryClient();
    const { result } = renderHook(() => useScopingState("c1"), {
      wrapper: ({ children }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>,
    });
    await waitFor(() => expect(result.current.courseNotFound).toBe(true));
    return result;
  }

  it("flags a NOT_FOUND course at once, without retrying", async () => {
    const result = await renderNotFound();
    expect(hoisted.getStateCalls).toBe(1);
    expect(result.current.isPending).toBe(false);
  });

  it("keeps the not-found state when the tab regains focus or the network returns", async () => {
    // A refetch of a query that never had data clears its error until the
    // reply lands, so the not-found message would vanish for that round-trip.
    const result = await renderNotFound();

    // Async act: the QueryClient's focus handler awaits before it refetches.
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    await act(async () => {
      onlineManager.setOnline(false);
      onlineManager.setOnline(true);
    });

    expect(result.current.courseNotFound).toBe(true);
    expect(hoisted.getStateCalls).toBe(1);
  });

  it("does not flag a course that loads", async () => {
    const { result } = renderHook(() => useScopingState("c1"), { wrapper });
    await waitFor(() => expect(result.current.chatEntries.length).toBeGreaterThan(0));
    expect(result.current.courseNotFound).toBe(false);
  });
});
