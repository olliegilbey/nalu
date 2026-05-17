// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// Mock tRPC context to provide hand-shaped queryOptions/mutationOptions.
// The hook only consumes these two shapes (queryKey/queryFn for getState; an
// onSuccess-invoking mutationFn for the three mutations), so a thin stub
// is enough — we're testing the adapter wiring, not the underlying transport.
vi.mock("@/lib/trpc", () => {
  const stateData = {
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
  };
  const stateOpts = {
    queryKey: ["course.getState", { courseId: "c1" }] as const,
    queryFn: async () => stateData,
  };
  return {
    useTRPC: () => ({
      course: {
        getState: { queryOptions: () => stateOpts },
        generateFramework: {
          mutationOptions: (o: { onSuccess?: () => void }) => ({
            mutationFn: async () => {
              o.onSuccess?.();
              return {};
            },
          }),
        },
        generateBaseline: {
          mutationOptions: (o: { onSuccess?: () => void }) => ({
            mutationFn: async () => {
              o.onSuccess?.();
              return {};
            },
          }),
        },
        submitBaseline: {
          mutationOptions: (o: { onSuccess?: () => void }) => ({
            mutationFn: async () => {
              o.onSuccess?.();
              return {};
            },
          }),
        },
      },
    }),
  };
});

import { useScopingState } from "./useScopingState";

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

beforeEach(() => {
  // Best-effort localStorage clear. Some Bun + jsdom combinations expose a
  // partial Storage shim without `.clear()` — guard the call.
  if (typeof window !== "undefined" && typeof window.localStorage?.clear === "function") {
    window.localStorage.clear();
  }
});

describe("useScopingState", () => {
  it("derives turns + an active clarify questionnaire", async () => {
    const { result } = renderHook(() => useScopingState("c1"), { wrapper });
    await waitFor(() => expect(result.current.turns.length).toBeGreaterThan(0));

    const kinds = result.current.turns.map((t) => t.kind);
    expect(kinds).toContain("user-topic");
    expect(kinds).toContain("llm-clarify-intro");
    expect(result.current.activeQuestionnaire).not.toBeNull();
    expect(result.current.activeQuestionnaire?.kind).toBe("clarify");
    expect(result.current.activeQuestionnaire?.persistKey).toBe("nalu:scoping:c1:clarify");
  });
});
