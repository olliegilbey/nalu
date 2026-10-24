"use client";

import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { toast } from "sonner";
import { useTRPC, devUserHeaders } from "@/lib/trpc";
import { isNotFoundError } from "@/lib/errors";
import { deriveWaveChatEntries } from "@/lib/course/deriveWaveChatEntries";
import { deriveActiveQuestionnaire } from "@/lib/course/deriveActiveQuestionnaire";
import {
  deriveTurnResultEffects,
  type WaveCloseResult,
} from "@/lib/course/deriveTurnResultEffects";
import { deriveStreamingTurn, type StreamingTurn } from "@/lib/course/deriveStreamingTurn";
import { deriveRetryableWaveTurn } from "@/lib/course/deriveRetryableWaveTurn";
import type { ActiveQuestionnaire } from "@/lib/course/adaptQuestionnaire";
import { useCourseXp } from "./useCourseXp";
import type { ChatEntry } from "@/lib/types/chatEntry";
import type { ShapedQuestionnaireAnswer } from "@/lib/course/shapeQuestionnaireAnswers";
import type { WaveState } from "@/lib/course/getWaveState";
import type { WaveTurnResultData, WaveTurnUIMessage } from "@/lib/types/waveStream";
import type { SubmitTurnBody, SubmitTurnPayload } from "@/lib/types/waveTurnInput";

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
 * Return shape of {@link useWaveState}; chat entries, active questionnaire, XP
 * counters, submit handlers, and the in-flight {@link StreamingTurn}.
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
  /** Wave tier — fallback for client-side MC XP. Null until the query resolves. */
  readonly currentTier: number | null;
  /** Turns left in the Wave, from `wave.getState`. Null until the query resolves. */
  readonly turnsRemaining: number | null;
  /** Turns in the Wave, from `wave.getState`. Null until the query resolves. */
  readonly turnBudget: number | null;
  /** Running XP total for the course (display counter). */
  readonly xp: number;
  /** Bumped on each XP gain — drives the header badge animation. */
  readonly xpPulseKey: number;
  /** Amount of the most recent XP gain. */
  readonly xpGainAmount: number;
  /** Records exact MC XP from a correct answer. Wired to the Composer. */
  readonly awardMcXp: (amount: number) => void;
  readonly isPending: boolean;
  /** Non-null while a failed Turn's saved entry awaits a learner Retry. */
  readonly failedTurn: FailedWaveTurn | null;
  /** True when `wave.getState` found no such Wave for this learner: a wrong URL, or another browser's course. */
  readonly waveNotFound: boolean;
  readonly submitChatText: (text: string, opts?: SubmitTurnOptions) => void;
  readonly submitQuestionnaireAnswers: (
    answers: readonly ShapedQuestionnaireAnswer[],
    opts?: SubmitTurnOptions,
  ) => void;
}

/** Per-call options for one Wave send. `onError` lets the caller restore its input. */
interface SubmitTurnOptions {
  readonly onError?: () => void;
}

/**
 * Drive one Wave's chat scroll + Composer mode (spec §7).
 *
 * Hybrid state model (streaming plan decision 1): `useChat` manages ONLY the
 * in-flight turn (status + streaming assistant text) against the streaming
 * route (`/api/course/[courseId]/wave/[waveNumber]/turn`); committed entries
 * keep rendering from `wave.getState` → `deriveWaveChatEntries`. On finish we
 * invalidate the query, then clear `useChat`'s transient messages so the
 * canonical server-derived entry replaces the streamed bubble.
 *
 * Result `kind` branches (delivered as a transient `data-turn-result` part):
 * - `mid-turn` → sum server-graded free-text XP into the badge counter.
 * - `close-turn` → store `closeResult` so the page can render the move-on CTA;
 *   add completion XP + final-turn free-text XP to the badge, fire the tier-up
 *   toast if a tier advanced.
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
  const courseXp = useCourseXp(courseId);

  const stateOpts = trpc.wave.getState.queryOptions({ courseId, waveNumber });
  const state = useQuery(stateOpts);

  // closeResult lives in component-local state because the wire's `getState`
  // never returns a close-turn payload (see WaveState TSDoc). We capture it
  // from the turn-result data part and surface it to the page.
  const [closeResult, setCloseResult] = useState<WaveCloseResult | null>(null);

  // The Turn in flight: its payload and the caller's per-call error hook.
  // WaveSession uses the hook to restore its input on failure. `useChat`'s
  // onError is chat-level and gets only the error, so `sendTurn` sets this ref
  // just before sendMessage. onError consumes it once; onFinish clears it.
  const inFlightTurnRef = useRef<
    (SubmitTurnOptions & { readonly payload: SubmitTurnPayload }) | null
  >(null);
  // This tab's last failed payload. A new send clears it.
  // `deriveRetryableWaveTurn` decides whether a Retry may re-send it.
  const [failedPayload, setFailedPayload] = useState<SubmitTurnPayload | null>(null);

  // Decisions live in `deriveTurnResultEffects` (pure); the hook applies the
  // side-effects in a fixed order: capture the close result, fold XP into the
  // badge, then fire the tier-up toast. `addXp` runs even for a 0 gain.
  const handleTurnResult = (result: WaveTurnResultData) => {
    const effects = deriveTurnResultEffects(result);
    if (effects.closeResult) setCloseResult(effects.closeResult);
    courseXp.addXp(effects.xpGain);
    if (effects.tierUp !== undefined) {
      toast.success(`Tier up → ${effects.tierUp}`, { duration: 3000 });
    }
  };

  const chat = useChat<WaveTurnUIMessage>({
    // One chat instance per wave — id remounts state on wave navigation.
    id: `wave-${courseId}-${waveNumber}`,
    transport: new DefaultChatTransport({
      api: `/api/course/${courseId}/wave/${waveNumber}/turn`,
      // Dev auth stub: the route resolves the user from `x-dev-user-id` in
      // non-production (same seam as the tRPC link — see resolveOrMintRequestUserId).
      // Without it every dev streaming request 401s. Prod: session cookie.
      headers: devUserHeaders(),
      // The server rebuilds context from the DB. So send ONLY the body that
      // `sendTurn` built. The default body would also ship `messages`, the
      // whole transient history. `sendTurn` types its body as `SubmitTurnBody`,
      // so `tsc` checks what goes on the wire (issue #220). This transport
      // sets no `body` of its own. Keep it that way: the AI SDK merges that
      // body in here, and it would ship too.
      // Returning no `headers` key keeps the transport-level headers above
      // (HttpChatTransport falls back to baseHeaders when undefined).
      prepareSendMessagesRequest: ({ body }) => ({ body: body ?? {} }),
    }),
    onData: (part) => {
      if (part.type === "data-turn-result") {
        handleTurnResult(part.data);
      }
    },
    // The AI SDK runs onFinish after every request, a failed one included.
    onFinish: () => {
      inFlightTurnRef.current = null;
      // Committed state is server-derived; refetch then drop the transient
      // streaming messages so the bubble is replaced by the canonical turn.
      void qc.invalidateQueries({ queryKey: stateOpts.queryKey }).then(() => {
        chat.setMessages([]);
      });
    },
    // Surface turn failures instead of swallowing them. The most common
    // cause is submitting into an already-closed wave (server guards throw
    // PRECONDITION_FAILED; the route's onError forwards guard message text).
    onError: (err) => {
      toast.error("Couldn't submit that turn", {
        description: err.message.length > 0 ? err.message : "Please try again.",
      });
      const turn = inFlightTurnRef.current;
      inFlightTurnRef.current = null;
      turn?.onError?.();
      setFailedPayload(turn?.payload ?? null);
      chat.setMessages([]);
    },
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

  const isPending = state.isFetching || chat.status === "submitted" || chat.status === "streaming";

  // In-flight prose + questionnaire preview from the live attempt only.
  // `deriveStreamingTurn` holds the slicing (failed attempts end at the last
  // `data-turn-reset` marker). Recomputed each render, like the stream itself.
  const { streamingText, streamingQuestions } = deriveStreamingTurn(chat.messages);

  // Every send goes through here, a Retry included. The server reads only
  // `payload`. The message text is useChat's transient copy, never rendered.
  const sendTurn = (payload: SubmitTurnPayload, opts?: SubmitTurnOptions) => {
    setFailedPayload(null);
    inFlightTurnRef.current = { payload, onError: opts?.onError };
    const text = payload.kind === "chat-text" ? payload.text : "Answers submitted";
    // Typed from the route's schema: `useChat`'s own `body` is a bare `object`.
    const body: SubmitTurnBody = { payload };
    void chat.sendMessage({ text }, { body });
  };

  // A failed Turn's saved entry, offered for Retry. `deriveRetryableWaveTurn`
  // holds the rule; re-sending the same payload takes the server's resume path.
  const retryable = state.data ? deriveRetryableWaveTurn(failedPayload, state.data.chatLog) : null;
  const failedTurn: FailedWaveTurn | null =
    retryable === null ? null : { payload: retryable, retry: () => sendTurn(retryable) };

  const submitChatText: UseWaveStateResult["submitChatText"] = (text, opts) => {
    sendTurn({ kind: "chat-text", text }, opts);
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
    // The optimistic user bubble stays WaveSession-owned.
    sendTurn({ kind: "questionnaire-answers", questionnaireId, answers: [...answers] }, opts);
  };

  return {
    chatEntries,
    activeQuestionnaire,
    closeResult,
    // Server-authoritative status; null until the query resolves.
    status: state.data?.status ?? null,
    topic: state.data?.topic ?? null,
    currentTier: state.data?.currentTier ?? null,
    // Turn counts for the progress strip. They refetch with the state after
    // each landed Turn, so the strip advances when the Turn lands.
    turnsRemaining: state.data?.turnsRemaining ?? null,
    turnBudget: state.data?.turnBudget ?? null,
    xp: courseXp.xp,
    xpPulseKey: courseXp.pulseKey,
    xpGainAmount: courseXp.gainAmount,
    awardMcXp: courseXp.addXp,
    isPending,
    failedTurn,
    waveNotFound: isNotFoundError(state.error),
    streamingText,
    streamingQuestions,
    submitChatText,
    submitQuestionnaireAnswers,
  };
}
