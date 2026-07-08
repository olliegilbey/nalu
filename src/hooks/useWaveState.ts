"use client";

import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { toast } from "sonner";
import { useTRPC, devUserHeaders } from "@/lib/trpc";
import { deriveWaveTurns } from "@/lib/course/deriveWaveTurns";
import { adaptOpenQuestion } from "@/lib/course/adaptQuestionnaire";
import { useCourseXp } from "./useCourseXp";
import type { ActiveQuestionnaire } from "./useScopingState";
import type { Turn } from "@/lib/types/turn";
import type { ShapedQuestionnaireAnswer } from "@/lib/course/shapeQuestionnaireAnswers";
import type { WaveState } from "@/lib/course/getWaveState";
import type { WaveTurnResultData, WaveTurnUIMessage } from "@/lib/types/waveStream";

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

/** Return shape of {@link useWaveState}; turns, active questionnaire, XP counters, submit handlers. */
export interface UseWaveStateResult {
  readonly turns: readonly Turn[];
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
  /**
   * In-flight assistant prose, growing token-by-token while the turn streams.
   * Empty string when idle. The committed turn (from `wave.getState` after
   * invalidation) replaces it on finish — see `onFinish` below.
   */
  readonly streamingText: string;
  readonly submitChatText: (text: string) => void;
  readonly submitQuestionnaireAnswers: (
    answers: readonly ShapedQuestionnaireAnswer[],
    opts?: { readonly onError?: () => void },
  ) => void;
}

/**
 * Drive one Wave's chat scroll + Composer mode (spec §7).
 *
 * Hybrid state model (streaming plan decision 1): `useChat` manages ONLY the
 * in-flight turn (status + streaming assistant text) against the streaming
 * route (`/api/course/[courseId]/wave/[waveNumber]/turn`); committed turns
 * keep rendering from `wave.getState` → `deriveWaveTurns`. On finish we
 * invalidate the query, then clear `useChat`'s transient messages so the
 * canonical server-derived turn replaces the streamed bubble.
 *
 * Result `kind` branches (delivered as a transient `data-turn-result` part):
 * - `mid-turn` → sum server-graded free-text XP into the badge counter.
 * - `close-turn` → store `closeResult` so the page can render the move-on CTA;
 *   add completion XP + final-turn free-text XP to the badge, fire the tier-up
 *   toast if a tier advanced.
 */
export function useWaveState(courseId: string, waveNumber: number): UseWaveStateResult {
  const trpc = useTRPC();
  const qc = useQueryClient();
  const courseXp = useCourseXp(courseId);

  const stateOpts = trpc.wave.getState.queryOptions({ courseId, waveNumber });
  const state = useQuery(stateOpts);

  // closeResult lives in component-local state because the wire's `getState`
  // never returns a close-turn payload (see WaveState TSDoc). We capture it
  // from the turn-result data part and surface it to the page. useState
  // is allowed under eslint-plugin-functional's React-hook exception.
  const [closeResult, setCloseResult] = useState<WaveCloseResult | null>(null);

  // Per-call error hook for questionnaire submissions: WaveSession re-shows
  // the question card + clears its optimistic bubble on failure. `useChat`'s
  // onError is chat-level, so the per-call callback is carried in a ref set
  // just before sendMessage and consumed (once) by onError / cleared on finish.
  const questionnaireErrorRef = useRef<(() => void) | null>(null);

  /** Exact port of the old submitTurn onSuccess branches (invalidate moved to onFinish). */
  const handleTurnResult = (result: WaveTurnResultData) => {
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
      // here would double-count.
      const freeTextXp = result.gradedSignals
        .filter((s) => s.kind === "free-text")
        .reduce((sum, s) => sum + s.xpAwarded, 0);
      courseXp.addXp(result.completionXpAwarded + freeTextXp);
      if (result.tierAdvancedTo !== null) {
        toast.success(`Tier up → ${result.tierAdvancedTo}`, { duration: 3000 });
      }
    }
  };

  const chat = useChat<WaveTurnUIMessage>({
    // One chat instance per wave — id remounts state on wave navigation.
    id: `wave-${courseId}-${waveNumber}`,
    transport: new DefaultChatTransport({
      api: `/api/course/${courseId}/wave/${waveNumber}/turn`,
      // Dev auth stub: the route resolves the user from `x-dev-user-id` in
      // non-production (same seam as the tRPC link — see resolveRequestUserId).
      // Without it every dev streaming request 401s. Prod: session cookie.
      headers: devUserHeaders(),
      // The server rebuilds context from the DB; send ONLY the payload.
      // (messages would otherwise ship the whole transient history.)
      // Returning no `headers` key keeps the transport-level headers above
      // (HttpChatTransport falls back to baseHeaders when undefined).
      prepareSendMessagesRequest: ({ body }) => ({ body: { payload: body?.["payload"] } }),
    }),
    onData: (part) => {
      if (part.type === "data-turn-reset") {
        // A validation retry is about to re-stream: drop the partial bubble.
        chat.setMessages((prev) => prev.filter((m) => m.role !== "assistant"));
        return;
      }
      if (part.type === "data-turn-result") {
        handleTurnResult(part.data);
      }
    },
    onFinish: () => {
      questionnaireErrorRef.current = null;
      // Committed state is server-derived; refetch then drop the transient
      // streaming messages so the bubble is replaced by the canonical turn.
      void qc.invalidateQueries({ queryKey: stateOpts.queryKey }).then(() => {
        chat.setMessages([]);
      });
    },
    // Surface turn failures instead of swallowing them. The most common
    // cause is submitting into an already-closed wave (server guards throw
    // PRECONDITION_FAILED; the route's onError forwards the message text).
    onError: (err) => {
      toast.error("Couldn't submit that turn", {
        description: err.message.length > 0 ? err.message : "Please try again.",
      });
      questionnaireErrorRef.current?.();
      questionnaireErrorRef.current = null;
      chat.setMessages([]);
    },
  });

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

  const isPending = state.isFetching || chat.status === "submitted" || chat.status === "streaming";

  // In-flight assistant prose: concatenated text parts of the last assistant
  // message in useChat's transient list (empty when idle or between turns).
  const lastAssistant = chat.messages.findLast((m) => m.role === "assistant");
  const streamingText = (lastAssistant?.parts ?? [])
    .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");

  const submitChatText: UseWaveStateResult["submitChatText"] = (text) => {
    void chat.sendMessage({ text }, { body: { payload: { kind: "chat-text", text } } });
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
    questionnaireErrorRef.current = opts?.onError ?? null;
    void chat.sendMessage(
      // The optimistic user bubble stays WaveSession-owned; this text is the
      // transient user message inside useChat's list (never rendered).
      { text: "Answers submitted" },
      {
        body: {
          payload: { kind: "questionnaire-answers", questionnaireId, answers },
        },
      },
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
    streamingText,
    submitChatText,
    submitQuestionnaireAnswers,
  };
}
