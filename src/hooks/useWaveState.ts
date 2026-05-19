"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc";
import { deriveWaveTurns } from "@/lib/course/deriveWaveTurns";
import { adaptOpenQuestion } from "@/lib/course/adaptQuestionnaire";
import type { ActiveQuestionnaire } from "./useScopingState";
import type { Turn } from "@/lib/types/turn";
import type { ShapedQuestionnaireAnswer } from "@/lib/course/shapeQuestionnaireAnswers";

/**
 * Close-turn result the page surfaces after the final wave turn lands.
 *
 * Trimmed projection of `ExecuteWaveCloseResult` — only the fields the page
 * needs to render the post-close banner + move-on CTA.
 */
export interface WaveCloseResult {
  readonly closingMessage: string;
  readonly nextWaveNumber: number;
  readonly completionXpAwarded: number;
  readonly tierAdvancedTo: number | null;
}

export interface UseWaveStateResult {
  readonly turns: readonly Turn[];
  readonly activeQuestionnaire: ActiveQuestionnaire | null;
  /** Set once a close-turn lands; null otherwise. Cleared on next mount. */
  readonly closeResult: WaveCloseResult | null;
  readonly isPending: boolean;
  readonly submitChatText: (text: string) => void;
  readonly submitQuestionnaireAnswers: (answers: readonly ShapedQuestionnaireAnswer[]) => void;
}

/**
 * Drive one Wave's chat scroll + Composer mode (spec §7).
 *
 * Reads server state via `wave.getState`; on mutation success invalidates the
 * query so derived `turns` re-compute. Wave turns are **purely user-driven** —
 * no auto-dispatch chain (contrast: `useScopingState` auto-fires
 * `generateBaseline`). Wave 1's opening prose is seeded server-side at
 * scoping-close, so the scroll is non-empty on first paint.
 *
 * Result `kind` branches:
 * - `mid-turn` → fire one toast per `gradedSignals` entry (XP hint), invalidate.
 * - `close-turn` → store `closeResult` so the page can render the move-on CTA;
 *   fire a completion banner; invalidate (so a back-nav sees fresh state).
 */
export function useWaveState(courseId: string, waveNumber: number): UseWaveStateResult {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const stateOpts = trpc.wave.getState.queryOptions({ courseId, waveNumber });
  const state = useQuery(stateOpts);

  // closeResult lives in component-local state because the wire's `getState`
  // never returns a close-turn payload (see WaveState TSDoc). We capture it
  // from the submitTurn mutation response and surface it to the page. useState
  // is allowed under eslint-plugin-functional's React-hook exception.
  const [closeResult, setCloseResult] = useState<WaveCloseResult | null>(null);

  const invalidateState = () => qc.invalidateQueries({ queryKey: stateOpts.queryKey });

  const submitTurn = useMutation(
    trpc.wave.submitTurn.mutationOptions({
      onSuccess: (result) => {
        if (result.kind === "mid-turn") {
          // One toast per graded answer. XP-only — comprehension/quality stays
          // invisible per spec (`src/components/CLAUDE.md`).
          for (const sig of result.gradedSignals) {
            if (sig.xpAwarded > 0) {
              toast.success(`+${sig.xpAwarded} XP`, { duration: 1500 });
            }
          }
        } else {
          // close-turn — capture the close result + tier banner.
          setCloseResult({
            closingMessage: result.closingMessage,
            nextWaveNumber: result.nextWaveNumber,
            completionXpAwarded: result.completionXpAwarded,
            tierAdvancedTo: result.tierAdvancedTo,
          });
          toast.success(`Wave complete: +${result.completionXpAwarded} XP`, { duration: 2500 });
          if (result.tierAdvancedTo !== null) {
            toast.success(`Tier up → ${result.tierAdvancedTo}`, { duration: 3000 });
          }
        }
        invalidateState();
      },
    }),
  );

  // Derive Turn[] from the message log + open questionnaire. Pure; safe to
  // run on every render (memoized for stability across consumer re-renders).
  const turns = useMemo<readonly Turn[]>(
    () => (state.data ? deriveWaveTurns(state.data.messages, state.data.openQuestionnaire) : []),
    [state.data],
  );

  // Active questionnaire projection for the Composer. The Composer's
  // `questionsKey` is a stable identity that triggers Composer state reset
  // when the question set changes — using `questionnaireId` (the server-side
  // row id) is the right granularity: a new questionnaire always lands on a
  // new assistant_response row, so the id changes iff the question set does.
  const activeQuestionnaire = useMemo<ActiveQuestionnaire | null>(() => {
    if (!state.data?.openQuestionnaire) return null;
    const oq = state.data.openQuestionnaire;
    return {
      kind: "wave",
      questions: oq.questions.map(adaptOpenQuestion),
      questionsKey: oq.questionnaireId,
      persistKey: `nalu:wave:${courseId}:${waveNumber}`,
    };
  }, [state.data, courseId, waveNumber]);

  const isPending = state.isFetching || submitTurn.isPending;

  const submitChatText: UseWaveStateResult["submitChatText"] = (text) => {
    submitTurn.mutate({
      courseId,
      waveNumber,
      payload: { kind: "chat-text", text },
    });
  };

  const submitQuestionnaireAnswers: UseWaveStateResult["submitQuestionnaireAnswers"] = (
    answers,
  ) => {
    // Echo back the open questionnaire's id (the server validates §7.4 mutual
    // exclusion against it). If there's no open questionnaire, the call would
    // fail server-side — the UI should be gating this path on activeQuestionnaire.
    const questionnaireId = state.data?.openQuestionnaire?.questionnaireId;
    if (!questionnaireId) return;
    submitTurn.mutate({
      courseId,
      waveNumber,
      // tRPC infers a mutable array shape; our public interface uses readonly.
      // Inputs are structurally identical (mirrors useScopingState's pattern).
      payload: { kind: "questionnaire-answers", questionnaireId, answers: answers as never },
    });
  };

  return {
    turns,
    activeQuestionnaire,
    closeResult,
    isPending,
    submitChatText,
    submitQuestionnaireAnswers,
  };
}
