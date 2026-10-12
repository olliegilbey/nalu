"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc";
import { formatMutationError, isNotFoundError } from "@/lib/errors";
import { deriveChatEntries } from "@/lib/course/deriveChatEntries";
import { adaptQuestionnaire, type ActiveQuestionnaire } from "@/lib/course/adaptQuestionnaire";
import { deriveStrandedScopingTurn } from "@/lib/course/deriveStrandedScopingTurn";
import type { ChatEntry } from "@/lib/types/chatEntry";
import type { CourseState } from "@/lib/course/getState";

/**
 * The last scoping Turn that failed, with a closure that re-sends it. Drives the
 * inline Retry row: a toast alone fades and leaves the learner with no way on.
 * `kind` names the scoping stage that failed; `scopingClose` is `submitBaseline`.
 * `retry` re-runs the same mutation with the same variables. After a reload,
 * it re-sends the answers the server saved (`deriveStrandedScopingTurn`).
 */
export interface FailedScopingTurn {
  readonly kind: "framework" | "baseline" | "scopingClose";
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
  /** Non-null while the last scoping Turn failed and awaits a learner Retry. */
  readonly failedTurn: FailedScopingTurn | null;
  /** True when `course.getState` found no course for this learner: a wrong URL, or another browser's course. */
  readonly courseNotFound: boolean;
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
 * A failed scoping Turn lands in `failedTurn`, with a closure that re-sends it.
 * A `getState` NOT_FOUND sets `courseNotFound`. The app's QueryClient
 * (`src/lib/queryClient.ts`) never retries it.
 * A reload rebuilds `failedTurn` from server state, so the learner is not stranded.
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

  // Last failed scoping Turn + its re-send closure. Each Turn's per-call
  // `onError` sets it, because the mutation variables are in scope there. Each
  // mutation's `onMutate` and `onSuccess` clear it, so any fresh attempt,
  // including a Retry, drops the stale row before it runs.
  const [failedTurn, setFailedTurn] = useState<FailedScopingTurn | null>(null);
  const clearFailedTurn = () => setFailedTurn(null);
  // Returns the invalidation promise, so the mutation stays pending until the
  // refetched state lands.
  const onTurnSuccess = () => {
    clearFailedTurn();
    return invalidateState();
  };

  const generateFramework = useMutation(
    trpc.course.generateFramework.mutationOptions({
      onMutate: clearFailedTurn,
      onSuccess: onTurnSuccess,
      onError: (err) => {
        toast.error("Couldn't build your course outline", {
          description: formatMutationError(err),
        });
      },
    }),
  );
  const generateBaseline = useMutation(
    trpc.course.generateBaseline.mutationOptions({
      onMutate: clearFailedTurn,
      onSuccess: onTurnSuccess,
    }),
  );
  const submitBaseline = useMutation(
    trpc.course.submitBaseline.mutationOptions({
      onMutate: clearFailedTurn,
      onSuccess: onTurnSuccess,
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
      // `fire` sends the baseline Turn. It backs both the auto-dispatch below
      // and the Retry closure. The baseline Turn has no learner submit handler
      // (it fires on its own), so its retry lives here, not in a submit* method.
      const fire = () => {
        generateBaseline.mutate(
          { courseId: dispatchedCourseId },
          {
            // Keep the guard set on error. Resetting it lets the effect re-run
            // (its deps include the mutation result, whose reference flips on
            // the error transition) and re-fire at once: an infinite loop on any
            // persistent failure, such as a sustained 429. The Retry row is the
            // recovery path, and a fresh mount still re-fires via a new guard
            // ref. `retry: fire` re-sends directly, bypassing the guarded effect.
            onError: (err) => {
              toast.error("Couldn't create your baseline quiz", {
                description: formatMutationError(err),
              });
              setFailedTurn({ kind: "baseline", retry: fire });
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
          setFailedTurn({ kind: "framework", retry: () => submitClarify(answers, opts) });
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
          setFailedTurn({
            kind: "scopingClose",
            retry: () => submitBaselineAnswers(answers, opts),
          });
          opts?.onError?.();
        },
        onSuccess: opts?.onSuccess,
      },
    );
  };

  // The server can commit a Turn whose reply never reached the client (a
  // network drop). Once a refetch shows that stage landed, the failure is
  // stale, so hide it. Otherwise "Move on" could sit beside a Retry row.
  const landed = {
    framework: Boolean(state.data?.framework),
    baseline: Boolean(state.data?.baseline),
    scopingClose: Boolean(state.data?.scopingResult),
  };
  // A reload drops `failedTurn`, and a saved-answers Turn shows no question
  // card. Rebuild its Retry from server state (issue #103). Skip while a Turn
  // is in flight: its answers are saved before the LLM call, so a mid-call
  // refetch looks the same as a failure.
  const turnInFlight = generateFramework.isPending || submitBaseline.isPending;
  const stranded = state.data && !turnInFlight ? deriveStrandedScopingTurn(state.data) : null;
  const strandedTurn: FailedScopingTurn | null =
    stranded === null
      ? null
      : stranded.kind === "framework"
        ? { kind: "framework", retry: () => submitClarify(stranded.responses) }
        : { kind: "scopingClose", retry: () => submitBaselineAnswers(stranded.answers) };
  const openFailedTurn = failedTurn && !landed[failedTurn.kind] ? failedTurn : strandedTurn;

  return {
    chatEntries,
    activeQuestionnaire,
    scopingResult: state.data?.scopingResult ?? null,
    topic: state.data?.topic ?? null,
    isPending,
    failedTurn: openFailedTurn,
    courseNotFound: isNotFoundError(state.error),
    submitClarify,
    submitBaselineAnswers,
  };
}
