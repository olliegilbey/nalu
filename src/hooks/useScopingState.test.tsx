// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// Mock tRPC context with hand-shaped queryOptions/mutationOptions. Unlike a
// pass-through-only stub, the mutationOptions here forward `o` (onMutate /
// onSuccess / onError) straight to react-query and swap in a controllable
// `mutationFn` — so the real mutation lifecycle drives our retry wiring. The
// `hoisted` handle lets each test flip `stateData` and make a step reject.
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
    queryFn: async () => hoisted.stateData,
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

import { useScopingState } from "./useScopingState";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  // Reset shared mock state so tests don't leak stage/rejection setup.
  hoisted.stateData = hoisted.clarifyState;
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

  it("starts with no failed step", async () => {
    const { result } = renderHook(() => useScopingState("c1"), { wrapper });
    await waitFor(() => expect(result.current.activeQuestionnaire?.kind).toBe("clarify"));
    expect(result.current.failedStep).toBeNull();
  });

  it("records a failed framework step, then a retry re-dispatches identical variables and clears it", async () => {
    hoisted.frameworkFn.mockRejectedValueOnce(new Error("429"));
    const { result } = renderHook(() => useScopingState("c1"), { wrapper });
    await waitFor(() => expect(result.current.activeQuestionnaire?.kind).toBe("clarify"));

    const answers = [{ questionId: "q1", freetext: "because" }];
    act(() => result.current.submitClarify(answers));

    await waitFor(() => expect(result.current.failedStep?.kind).toBe("framework"));
    expect(hoisted.frameworkFn.mock.calls[0]?.[0]).toEqual({ courseId: "c1", responses: answers });

    // Retry succeeds (default resolve): identical variables re-sent, row cleared.
    hoisted.frameworkFn.mockClear();
    act(() => result.current.failedStep?.retry());
    await waitFor(() => expect(result.current.failedStep).toBeNull());
    expect(hoisted.frameworkFn.mock.calls[0]?.[0]).toEqual({ courseId: "c1", responses: answers });
  });

  it("records a failed submitBaseline step with the submitBaseline kind", async () => {
    hoisted.stateData = baselineState;
    hoisted.submitBaselineFn.mockRejectedValueOnce(new Error("429"));
    const { result } = renderHook(() => useScopingState("c1"), { wrapper });
    await waitFor(() => expect(result.current.activeQuestionnaire?.kind).toBe("baseline"));

    const answers = [{ id: "b1", kind: "mc" as const, selected: "A" as const }];
    act(() => result.current.submitBaselineAnswers(answers));

    await waitFor(() => expect(result.current.failedStep?.kind).toBe("submitBaseline"));
    expect(hoisted.submitBaselineFn.mock.calls[0]?.[0]).toEqual({ courseId: "c1", answers });
  });

  it("records a failed baseline auto-dispatch with the baseline kind", async () => {
    hoisted.stateData = frameworkOnlyState;
    hoisted.baselineFn.mockRejectedValue(new Error("429"));
    const { result } = renderHook(() => useScopingState("c1"), { wrapper });

    await waitFor(() => expect(result.current.failedStep?.kind).toBe("baseline"));
    expect(hoisted.baselineFn.mock.calls[0]?.[0]).toEqual({ courseId: "c1" });
  });
});
