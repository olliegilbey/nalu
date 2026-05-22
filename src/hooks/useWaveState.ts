"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc";
import { formatMutationError } from "@/lib/errors";
import { deriveWaveTurns } from "@/lib/course/deriveWaveTurns";
import { adaptOpenQuestion } from "@/lib/course/adaptQuestionnaire";
import { useCourseXp } from "./useCourseXp";
import type { ActiveQuestionnaire } from "./useScopingState";
import type { Turn } from "@/lib/types/turn";
import type { ShapedQuestionnaireAnswer } from "@/lib/course/shapeQuestionnaireAnswers";
import type { WaveState } from "@/lib/course/getWaveState";

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
  /**
   * Server-authoritative wave lifecycle status. Unlike `closeResult` (which is
   * transient component state seeded only by the close-turn mutation), this
   * survives reloads — it comes straight from `wave.getState`. The page uses it
   * to render a move-on affordance on a *reloaded* closed wave, where
   * `closeResult` is null. `null` until the state query resolves.
   */
  readonly status: WaveState["status"] | null;
  /** Course topic — drives the wave header title. Null until the query resolves. */
  readonly topic: string | null;
  /** Wave tier — fallback for client-side MC XP. Null until the query resolves. */
  readonly currentTier: number | null;
  /** Running XP total for the course (display counter). */
  readonly xp: number;
  /** Bumped on each XP gain — drives the header badge animation. */
  readonly xpPulseKey: number;
  /** Amount of the most recent XP gain. */
  readonly xpGainAmount: number;
  /** Records exact MC XP from a correct answer. Wired to the Composer. */
  readonly awardMcXp: (amount: number) => void;
  readonly isPending: boolean;
  readonly submitChatText: (text: string) => void;
  readonly submitQuestionnaireAnswers: (
    answers: readonly ShapedQuestionnaireAnswer[],
    opts?: { readonly onError?: () => void },
  ) => void;
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
 * - `mid-turn` → sum server-graded free-text XP into the badge counter,
 *   invalidate.
 * - `close-turn` → store `closeResult` so the page can render the move-on CTA;
 *   add completion XP + final-turn free-text XP to the badge, fire the tier-up
 *   toast if a tier advanced, invalidate (so a back-nav sees fresh state).
 */
export function useWaveState(courseId: string, waveNumber: number): UseWaveStateResult {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const courseXp = useCourseXp(courseId);

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
          // Free-text XP is server-graded; sum it into one badge pulse. MC XP
          // is already counted client-side at confirm time (Composer
          // onCorrectAnswer) — skip `mc-index` signals to avoid double-counting.
          const freeTextXp = result.gradedSignals
            .filter((s) => s.kind === "free-text")
            .reduce((sum, s) => sum + s.xpAwarded, 0);
          courseXp.addXp(freeTextXp);
        } else {
          // close-turn — capture the close result + completion XP.
          setCloseResult({
            closingMessage: result.closingMessage,
            nextWaveNumber: result.nextWaveNumber,
            completionXpAwarded: result.completionXpAwarded,
            tierAdvancedTo: result.tierAdvancedTo,
          });
          // Free-text answered on the wave's FINAL turn is server-graded too —
          // mirror the mid-turn branch and fold its XP into the same pulse as
          // completion XP. Skip `mc-index` signals: MC on the close turn is
          // already counted client-side (Composer onCorrectAnswer) — summing it
          // here would double-count. Without this, final-turn free-text XP was
          // silently dropped on the client (the badge never moved).
          const freeTextXp = result.gradedSignals
            .filter((s) => s.kind === "free-text")
            .reduce((sum, s) => sum + s.xpAwarded, 0);
          courseXp.addXp(result.completionXpAwarded + freeTextXp);
          if (result.tierAdvancedTo !== null) {
            toast.success(`Tier up → ${result.tierAdvancedTo}`, { duration: 3000 });
          }
        }
        invalidateState();
      },
      // Surface turn failures instead of swallowing them. The most common
      // cause is submitting into an already-closed wave (server throws
      // PRECONDITION_FAILED) — e.g. a learner who reloaded a finished wave and
      // typed into the composer. Without this the rejected mutation produced
      // no feedback at all and the learner's text vanished silently. Matches
      // the `toast.error(..., { description })` pattern in `TopicInput.tsx`.
      onError: (err) => {
        toast.error("Couldn't submit that turn", {
          description: formatMutationError(err),
        });
      },
    }),
  );

  // Derive Turn[] from chat_log. Pure; safe to run on every render
  // (memoized for stability across consumer re-renders).
  const turns = useMemo<readonly Turn[]>(
    () => (state.data ? deriveWaveTurns(state.data.chatLog) : []),
    [state.data],
  );

  // Active questionnaire for the Composer: the latest
  // `assistant.text_with_questionnaire` whose id has no later
  // `user.answers` entry in the chat log. Mirrors `useScopingState`'s
  // derivation pattern — same `ActiveQuestionnaire` shape, same
  // questionnaireId-as-key identity for Composer state reset.
  const activeQuestionnaire = useMemo<ActiveQuestionnaire | null>(() => {
    if (!state.data) return null;
    const log = state.data.chatLog;
    // Walk from the tail to find the most recent questionnaire emission;
    // `findLastIndex` is cleaner than reversing + indexing.
    const lastQIdx = log.findLastIndex(
      (e) => e.role === "assistant" && e.kind === "text_with_questionnaire",
    );
    if (lastQIdx === -1) return null;
    const lastQ = log[lastQIdx];
    // Re-narrow for TS — findLastIndex predicate guarantees this shape at runtime.
    if (lastQ?.role !== "assistant" || lastQ.kind !== "text_with_questionnaire") return null;
    // Any later `user.answers` entry referencing this questionnaire's id
    // means it's been submitted → no active questionnaire.
    const answered = log
      .slice(lastQIdx + 1)
      .some(
        (e) =>
          e.role === "user" && e.kind === "answers" && e.questionnaireId === lastQ.questionnaireId,
      );
    if (answered) return null;
    return {
      kind: "wave",
      questions: lastQ.questions.map(adaptOpenQuestion),
      questionsKey: lastQ.questionnaireId,
      persistKey: `nalu:wave:${state.data.waveId}:q:${lastQ.questionnaireId}`,
    };
  }, [state.data]);

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
    opts,
  ) => {
    // Echo back the open questionnaire's id (the server validates §7.4 mutual
    // exclusion against it). If there's no open questionnaire, the call would
    // fail server-side — the UI should be gating this path on activeQuestionnaire.
    // `questionsKey` was set to the questionnaireId in the memo above; reuse
    // it rather than re-scanning chat_log.
    const questionnaireId = activeQuestionnaire?.questionsKey;
    if (!questionnaireId) return;
    submitTurn.mutate(
      {
        courseId,
        waveNumber,
        // tRPC infers a mutable array shape; our public interface uses readonly.
        // Inputs are structurally identical (mirrors useScopingState's pattern).
        payload: { kind: "questionnaire-answers", questionnaireId, answers: answers as never },
      },
      // Per-call `onError` lets WaveSession re-show the questionnaire card and
      // clear its optimistic bubble on failure; the mutation-level toast still fires.
      { onError: opts?.onError },
    );
  };

  return {
    turns,
    activeQuestionnaire,
    closeResult,
    // Server-authoritative status; null until the query resolves.
    status: state.data?.status ?? null,
    topic: state.data?.topic ?? null,
    currentTier: state.data?.currentTier ?? null,
    xp: courseXp.xp,
    xpPulseKey: courseXp.pulseKey,
    xpGainAmount: courseXp.gainAmount,
    awardMcXp: courseXp.addXp,
    isPending,
    submitChatText,
    submitQuestionnaireAnswers,
  };
}
