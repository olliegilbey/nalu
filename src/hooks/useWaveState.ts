"use client";

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useTRPC } from "@/lib/trpc";
import { isNotFoundError } from "@/lib/errors";
import { deriveWaveChatEntries } from "@/lib/course/deriveWaveChatEntries";
import { deriveActiveQuestionnaire } from "@/lib/course/deriveActiveQuestionnaire";
import {
  deriveTurnResultEffects,
  type WaveCloseResult,
} from "@/lib/course/deriveTurnResultEffects";
import type { StreamingTurn } from "@/lib/course/deriveStreamingTurn";
import { deriveRetryableWaveTurn } from "@/lib/course/deriveRetryableWaveTurn";
import type { ActiveQuestionnaire } from "@/lib/course/adaptQuestionnaire";
import { useXpBadge } from "./useXpBadge";
import { useWaveTurnChat, type SubmitTurnOptions } from "./useWaveTurnChat";
import type { ChatEntry } from "@/lib/types/chatEntry";
import type { QuestionnaireAnswer } from "@/lib/types/questionnaireAnswer";
import type { WaveState } from "@/lib/course/getWaveState";
import type { WaveTurnResultData } from "@/lib/types/waveStream";
import type { SubmitTurnPayload } from "@/lib/types/waveTurnInput";

/**
 * A failed Wave Turn whose learner entry the server saved (issue #231).
 * `retry` re-sends `payload` unchanged, so the server reuses that entry
 * instead of spending a second Turn.
 */
export interface FailedWaveTurn {
  readonly payload: SubmitTurnPayload;
  readonly retry: () => void;
}

/**
 * Return shape of {@link useWaveState}; chat entries, active questionnaire, the
 * XP badge, submit handlers, and the in-flight {@link StreamingTurn}.
 */
export interface UseWaveStateResult extends StreamingTurn {
  readonly chatEntries: readonly ChatEntry[];
  readonly activeQuestionnaire: ActiveQuestionnaire | null;
  /** Set once a close-turn lands; null otherwise. Cleared on next mount. */
  readonly closeResult: WaveCloseResult | null;
  /**
   * Server-authoritative wave lifecycle status. Unlike `closeResult` (which is
   * transient component state seeded only by the close-turn result part), this
   * survives reloads — it comes straight from `wave.getState`. The page uses it
   * to render a move-on affordance on a *reloaded* closed wave, where
   * `closeResult` is null. `null` until the state query resolves.
   */
  readonly status: WaveState["status"] | null;
  /** Course topic — drives the wave header title. Null until the query resolves. */
  readonly topic: string | null;
  /** Turns left in the Wave, from `wave.getState`. Null until the query resolves. */
  readonly turnsRemaining: number | null;
  /** Turns in the Wave, from `wave.getState`. Null until the query resolves. */
  readonly turnBudget: number | null;
  /** The server's course total (`totalXp`), shown in the header badge. */
  readonly xp: number;
  /** Bumped on each rise of the total — drives the header badge animation. */
  readonly xpPulseKey: number;
  /** Amount of the most recent rise. */
  readonly xpGainAmount: number;
  readonly isPending: boolean;
  /** Non-null while a failed Turn's saved entry awaits a learner Retry. */
  readonly failedTurn: FailedWaveTurn | null;
  /** True when `wave.getState` found no such Wave for this learner: a wrong URL, or another browser's course. */
  readonly waveNotFound: boolean;
  readonly submitChatText: (text: string, opts?: SubmitTurnOptions) => void;
  readonly submitQuestionnaireAnswers: (
    answers: readonly QuestionnaireAnswer[],
    opts?: SubmitTurnOptions,
  ) => void;
}

/**
 * Drive one Wave's chat scroll + Composer mode (spec §7).
 *
 * Hybrid state model (streaming plan decision 1): `useWaveTurnChat` runs the
 * in-flight turn over `useChat`; committed entries render from
 * `wave.getState` → `deriveWaveChatEntries`. This hook composes the two.
 *
 * Each `data-turn-result` part (transient) patches the cached Wave state's
 * `totalXp` with the result's, so the badge ticks when the Turn lands; the
 * refetch after the Turn then replaces it. The client computes no XP.
 * A `close-turn` result also stores `closeResult`, so the page can render the
 * move-on CTA, and fires the tier-up toast if a tier advanced.
 *
 * A failed Turn whose learner entry the server saved lands in `failedTurn`
 * (`deriveRetryableWaveTurn`). Its Retry re-sends the same payload, so the
 * server reuses the entry rather than spending a second Turn (issue #231).
 *
 * A `getState` NOT_FOUND sets `waveNotFound`. The app's QueryClient
 * (`src/lib/queryClient.ts`) never retries it.
 */
export function useWaveState(courseId: string, waveNumber: number): UseWaveStateResult {
  const trpc = useTRPC();
  const qc = useQueryClient();

  const stateOpts = trpc.wave.getState.queryOptions({ courseId, waveNumber });
  const state = useQuery(stateOpts);
  // The badge reads the one cached total: getState's, or a turn result's patch.
  const badge = useXpBadge(state.data?.totalXp);

  // closeResult lives in component-local state because the wire's `getState`
  // never returns a close-turn payload (see WaveState TSDoc). We capture it
  // from the turn-result data part and surface it to the page.
  const [closeResult, setCloseResult] = useState<WaveCloseResult | null>(null);

  // Decisions live in `deriveTurnResultEffects` (pure); the hook applies the
  // side-effects in a fixed order: capture the close result, arm the tick's
  // sound, patch the server total into the cache, then fire the tier-up toast.
  // The sound is armed first, so the rise the patch causes can play it.
  const handleTurnResult = (result: WaveTurnResultData) => {
    const effects = deriveTurnResultEffects(result);
    if (effects.closeResult) setCloseResult(effects.closeResult);
    badge.soundOnNextRise(effects.typedAnswerEarnedXp);
    qc.setQueryData(stateOpts.queryKey, (prev) =>
      prev ? { ...prev, totalXp: result.totalXp } : prev,
    );
    if (effects.tierUp !== undefined) {
      toast.success(`Tier up → ${effects.tierUp}`, { duration: 3000 });
    }
  };

  // The in-flight Turn: `useChat`, its send, and this tab's last failed payload.
  const chat = useWaveTurnChat({
    courseId,
    waveNumber,
    stateQueryKey: stateOpts.queryKey,
    onTurnResult: handleTurnResult,
  });

  // Derive ChatEntry[] from chat_log. Pure; safe to run on every render
  // (memoized for stability across consumer re-renders).
  const chatEntries = useMemo<readonly ChatEntry[]>(
    () => (state.data ? deriveWaveChatEntries(state.data.chatLog) : []),
    [state.data],
  );

  // Active questionnaire for the Composer: the latest
  // `assistant.text_with_questionnaire` whose id has no later
  // `user.answers` entry in the chat log. `deriveActiveQuestionnaire` holds
  // the logic; the memo keeps the result stable across consumer re-renders.
  const activeQuestionnaire = useMemo<ActiveQuestionnaire | null>(
    () => (state.data ? deriveActiveQuestionnaire(state.data.chatLog, state.data.waveId) : null),
    [state.data],
  );

  const isPending = state.isFetching || chat.isSending;

  // A failed Turn's saved entry, offered for Retry. `deriveRetryableWaveTurn`
  // holds the rule; re-sending the same payload takes the server's resume path.
  const retryable = state.data
    ? deriveRetryableWaveTurn(chat.failedPayload, state.data.chatLog)
    : null;
  const failedTurn: FailedWaveTurn | null =
    retryable === null ? null : { payload: retryable, retry: () => chat.sendTurn(retryable) };

  const submitChatText: UseWaveStateResult["submitChatText"] = (text, opts) => {
    chat.sendTurn({ kind: "chat-text", text }, opts);
  };

  const submitQuestionnaireAnswers: UseWaveStateResult["submitQuestionnaireAnswers"] = (
    answers,
    opts,
  ) => {
    // Echo back the open questionnaire's id (the server validates §7.4 mutual
    // exclusion against it). If there's no open questionnaire, the call would
    // fail server-side — the UI should be gating this path on activeQuestionnaire.
    // `deriveActiveQuestionnaire` sets `questionsKey` to the questionnaireId;
    // reuse it rather than re-scanning chat_log.
    const questionnaireId = activeQuestionnaire?.questionsKey;
    if (!questionnaireId) return;
    // The optimistic user bubble stays WaveSession-owned (`useWaveComposer`).
    chat.sendTurn({ kind: "questionnaire-answers", questionnaireId, answers: [...answers] }, opts);
  };

  return {
    chatEntries,
    activeQuestionnaire,
    closeResult,
    // Server-authoritative status; null until the query resolves.
    status: state.data?.status ?? null,
    topic: state.data?.topic ?? null,
    // Turn counts for the progress strip. They refetch with the state after
    // each landed Turn, so the strip advances when the Turn lands.
    turnsRemaining: state.data?.turnsRemaining ?? null,
    turnBudget: state.data?.turnBudget ?? null,
    xp: badge.xp,
    xpPulseKey: badge.pulseKey,
    xpGainAmount: badge.gainAmount,
    isPending,
    failedTurn,
    waveNotFound: isNotFoundError(state.error),
    streamingText: chat.streamingText,
    streamingQuestions: chat.streamingQuestions,
    submitChatText,
    submitQuestionnaireAnswers,
  };
}
