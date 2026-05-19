"use client";

import { useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";
import { deriveTurns } from "@/lib/course/deriveTurns";
import { adaptQuestionnaire, type ChoiceQuestion } from "@/lib/course/adaptQuestionnaire";
import type { Turn } from "@/lib/types/turn";
import type { CourseState } from "@/lib/course/getState";

/**
 * Shared Composer-binding shape used by both `useScopingState` (scoping flow)
 * and `useWaveState` (wave teaching flow).
 *
 * `kind` discriminator widened from `"clarify" | "baseline"` (Task 14) to
 * include `"wave"` (Task 15) so the wave hook can use the same projection
 * shape. Widening is a one-line change because nothing in the scoping flow
 * exhaustively switches on this field — it's purely an informational tag.
 */
export interface ActiveQuestionnaire {
  readonly kind: "clarify" | "baseline" | "wave";
  readonly questions: readonly ChoiceQuestion[];
  /** Stable identity for the active question set — feeds the Composer's reset key. */
  readonly questionsKey: string;
  /** Stable per-courseId+stage key for refresh-resilient localStorage buffer. */
  readonly persistKey: string;
}

export interface UseScopingStateResult {
  readonly turns: readonly Turn[];
  readonly activeQuestionnaire: ActiveQuestionnaire | null;
  readonly scopingResult: CourseState["scopingResult"];
  readonly isPending: boolean;
  readonly submitClarify: (
    answers: ReadonlyArray<{ readonly questionId: string; readonly freetext: string }>,
  ) => void;
  readonly submitBaselineAnswers: (
    answers: ReadonlyArray<
      | { readonly id: string; readonly kind: "mc"; readonly selected: "A" | "B" | "C" | "D" }
      | {
          readonly id: string;
          readonly kind: "freetext";
          readonly text: string;
          readonly fromEscape: boolean;
        }
    >,
  ) => void;
}

/**
 * Drive the scoping flow for one course.
 *
 * Reads server state via `course.getState`; on mutation success, invalidates
 * the query so derived `turns` re-compute. Auto-dispatches `generateBaseline`
 * once `framework` lands and `baseline` is still null — gated on the mutation
 * not already being in flight to avoid double-fire during refetch races.
 *
 * Hook is portable: no DOM, no Next imports. The mutations are dispatched via
 * `@trpc/tanstack-react-query` mutation options.
 */
export function useScopingState(courseId: string): UseScopingStateResult {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const stateOpts = trpc.course.getState.queryOptions({ courseId });
  const state = useQuery(stateOpts);

  const invalidateState = () => qc.invalidateQueries({ queryKey: stateOpts.queryKey });

  const generateFramework = useMutation(
    trpc.course.generateFramework.mutationOptions({ onSuccess: invalidateState }),
  );
  const generateBaseline = useMutation(
    trpc.course.generateBaseline.mutationOptions({ onSuccess: invalidateState }),
  );
  const submitBaseline = useMutation(
    trpc.course.submitBaseline.mutationOptions({ onSuccess: invalidateState }),
  );

  const turns = useMemo(() => (state.data ? deriveTurns(state.data) : []), [state.data]);

  const activeQuestionnaire = useMemo<ActiveQuestionnaire | null>(() => {
    if (!state.data) return null;
    const s = state.data;

    // Clarify is active while there's a clarification with no responses AND
    // no framework yet.
    if (s.clarification && s.clarification.responses.length === 0 && !s.framework) {
      const { questions } = adaptQuestionnaire(s.clarification.questions);
      return {
        kind: "clarify",
        questions,
        questionsKey: questions.map((q) => q.id).join("|"),
        persistKey: `nalu:scoping:${s.courseId}:clarify`,
      };
    }

    // Baseline is active while there's a baseline with no responses AND status
    // still 'scoping' (so the close hasn't landed).
    if (s.baseline && s.baseline.responses.length === 0 && s.status === "scoping") {
      const { questions } = adaptQuestionnaire(s.baseline.questions);
      return {
        kind: "baseline",
        questions,
        questionsKey: questions.map((q) => q.id).join("|"),
        persistKey: `nalu:scoping:${s.courseId}:baseline`,
      };
    }

    return null;
  }, [state.data]);

  // Auto-dispatch generateBaseline when framework is present and baseline is not.
  // Use a ref guard so we don't re-fire during refetch settling.
  const baselineDispatchedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!state.data) return;
    if (state.data.framework && !state.data.baseline && state.status === "success") {
      if (baselineDispatchedFor.current === state.data.courseId) return;
      if (generateBaseline.isPending) return;
      const dispatchedCourseId = state.data.courseId;
      baselineDispatchedFor.current = dispatchedCourseId;
      generateBaseline.mutate(
        { courseId: dispatchedCourseId },
        {
          // Clear the guard on error so a user retry (refetch/remount) can fire
          // again. Without this, a single LLM failure would suppress baseline
          // generation for this course until the page is fully reloaded.
          onError: () => {
            if (baselineDispatchedFor.current === dispatchedCourseId) {
              baselineDispatchedFor.current = null;
            }
          },
        },
      );
    }
  }, [state.data, state.status, generateBaseline]);

  const isPending =
    state.isFetching ||
    generateFramework.isPending ||
    generateBaseline.isPending ||
    submitBaseline.isPending;

  const submitClarify: UseScopingStateResult["submitClarify"] = (answers) => {
    // tRPC infers a mutable array shape; our public interface uses readonly.
    // Inputs are structurally identical, so cast through `never` (mirrors
    // submitBaselineAnswers below).
    generateFramework.mutate({ courseId, responses: answers as never });
  };

  const submitBaselineAnswers: UseScopingStateResult["submitBaselineAnswers"] = (answers) => {
    // tRPC infers a mutable array shape; our public interface uses readonly.
    // Inputs are structurally identical, so cast through `never` (per plan).
    submitBaseline.mutate({ courseId, answers: answers as never });
  };

  return {
    turns,
    activeQuestionnaire,
    scopingResult: state.data?.scopingResult ?? null,
    isPending,
    submitClarify,
    submitBaselineAnswers,
  };
}
