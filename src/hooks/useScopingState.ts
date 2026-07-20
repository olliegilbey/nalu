"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc";
import { formatMutationError } from "@/lib/errors";
import { deriveChatEntries } from "@/lib/course/deriveChatEntries";
import { adaptQuestionnaire, type ChoiceQuestion } from "@/lib/course/adaptQuestionnaire";
import type { ChatEntry } from "@/lib/types/chatEntry";
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

/**
 * The last scoping step that failed, with a closure to re-dispatch it. Drives
 * the inline Retry affordance (issue #16): errors previously surfaced only as an
 * ephemeral toast, stranding the learner. `retry` re-runs the same mutation with
 * the same variables. Null when nothing is in a failed state.
 */
export interface FailedScopingStep {
  readonly kind: "framework" | "baseline" | "submitBaseline";
  readonly retry: () => void;
}

/** Return shape of {@link useScopingState}; chat entries + active questionnaire + submit handlers. */
export interface UseScopingStateResult {
  readonly chatEntries: readonly ChatEntry[];
  readonly activeQuestionnaire: ActiveQuestionnaire | null;
  readonly scopingResult: CourseState["scopingResult"];
  /** Course topic — drives the chat header title. Null until the query resolves. */
  readonly topic: string | null;
  readonly isPending: boolean;
  /** Non-null while the last scoping step failed and awaits a user Retry. */
  readonly failedStep: FailedScopingStep | null;
  readonly submitClarify: (
    answers: ReadonlyArray<{ readonly questionId: string; readonly freetext: string }>,
    opts?: { readonly onError?: () => void },
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
    // `onSuccess` carries the free-text XP subtotal so the caller can pop the
    // header badge; `onError` lets it recover its optimistic UI. Both optional.
    opts?: {
      readonly onError?: () => void;
      readonly onSuccess?: (result: { readonly freeTextXpAwarded: number }) => void;
    },
  ) => void;
}

/**
 * Drive the scoping flow for one course.
 *
 * Reads server state via `course.getState`; on mutation success, invalidates
 * the query so derived `chatEntries` re-compute. Auto-dispatches `generateBaseline`
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

  // Last failed scoping step + its re-dispatch closure (issue #16). Set in each
  // step's per-call `onError` (where the mutation variables are in scope) and
  // cleared in each mutation's `onMutate` — so any fresh attempt, including a
  // Retry, clears the stale row before it runs.
  const [failedStep, setFailedStep] = useState<FailedScopingStep | null>(null);
  const clearFailedStep = () => setFailedStep(null);

  const generateFramework = useMutation(
    trpc.course.generateFramework.mutationOptions({
      onMutate: clearFailedStep,
      onSuccess: invalidateState,
      onError: (err) => {
        toast.error("Couldn't build your course outline", {
          description: formatMutationError(err),
        });
      },
    }),
  );
  const generateBaseline = useMutation(
    trpc.course.generateBaseline.mutationOptions({
      onMutate: clearFailedStep,
      onSuccess: invalidateState,
    }),
  );
  const submitBaseline = useMutation(
    trpc.course.submitBaseline.mutationOptions({
      onMutate: clearFailedStep,
      onSuccess: invalidateState,
      onError: (err) => {
        toast.error("Couldn't save your answers", {
          description: formatMutationError(err),
        });
      },
    }),
  );

  const chatEntries = useMemo(
    () => (state.data ? deriveChatEntries(state.data) : []),
    [state.data],
  );

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
      // `fire` re-dispatches the same baseline generation; it backs both the
      // auto-dispatch below and the inline Retry closure (issue #16). Baseline
      // has no user-facing submit handler — it auto-fires — so its retry lives
      // here rather than in a submit* method.
      const fire = () => {
        generateBaseline.mutate(
          { courseId: dispatchedCourseId },
          {
            // Do NOT reset the guard on error. The previous reset let the effect
            // re-run (its deps include the mutation result, whose reference flips
            // on the error transition) and re-fire immediately — an infinite
            // retry loop on any persistent failure (e.g. a sustained 429). The
            // inline Retry affordance below is now the recovery path (issue #16),
            // and a fresh mount still re-fires via a new guard ref. `retry: fire`
            // re-dispatches directly, bypassing the guarded effect.
            onError: (err) => {
              toast.error("Couldn't create your baseline quiz", {
                description: formatMutationError(err),
              });
              setFailedStep({ kind: "baseline", retry: fire });
            },
          },
        );
      };
      fire();
    }
  }, [state.data, state.status, generateBaseline]);

  const isPending =
    state.isFetching ||
    generateFramework.isPending ||
    generateBaseline.isPending ||
    submitBaseline.isPending;

  const submitClarify: UseScopingStateResult["submitClarify"] = (answers, opts) => {
    // tRPC infers a mutable array shape; our public interface uses readonly.
    // Inputs are structurally identical, so cast through `never` (mirrors
    // submitBaselineAnswers below). The per-call `onError` lets the caller
    // recover its optimistic UI on failure — the mutation-level toast still fires.
    generateFramework.mutate(
      { courseId, responses: answers as never },
      {
        onError: () => {
          // Retry re-invokes this same handler with the same variables, so the
          // caller's optimistic-recovery wiring re-runs on any repeat failure.
          setFailedStep({ kind: "framework", retry: () => submitClarify(answers, opts) });
          opts?.onError?.();
        },
      },
    );
  };

  const submitBaselineAnswers: UseScopingStateResult["submitBaselineAnswers"] = (answers, opts) => {
    // tRPC infers a mutable array shape; our public interface uses readonly.
    // Inputs are structurally identical, so cast through `never` (per plan).
    // The mutation-level `onSuccess` (invalidateState) still runs first;
    // react-query then invokes this per-call `onSuccess` with the result.
    submitBaseline.mutate(
      { courseId, answers: answers as never },
      {
        onError: () => {
          // Retry re-invokes with identical variables + opts (see submitClarify).
          setFailedStep({
            kind: "submitBaseline",
            retry: () => submitBaselineAnswers(answers, opts),
          });
          opts?.onError?.();
        },
        onSuccess: opts?.onSuccess,
      },
    );
  };

  return {
    chatEntries,
    activeQuestionnaire,
    scopingResult: state.data?.scopingResult ?? null,
    topic: state.data?.topic ?? null,
    isPending,
    failedStep,
    submitClarify,
    submitBaselineAnswers,
  };
}
