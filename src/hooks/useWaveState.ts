"use client";

import { useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { toast } from "sonner";
import { useTRPC, devUserHeaders } from "@/lib/trpc";
import { deriveWaveChatEntries } from "@/lib/course/deriveWaveChatEntries";
import { deriveActiveQuestionnaire } from "@/lib/course/deriveActiveQuestionnaire";
import { deriveTurnResultEffects } from "@/lib/course/deriveTurnResultEffects";
import { adaptStreamedToolQuestion } from "@/lib/course/adaptQuestionnaire";
import type { ChoiceQuestion } from "@/lib/course/adaptQuestionnaire";
import { useCourseXp } from "./useCourseXp";
import type { ActiveQuestionnaire } from "./useScopingState";
import type { ChatEntry } from "@/lib/types/chatEntry";
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

/** Return shape of {@link useWaveState}; chat entries, active questionnaire, XP counters, submit handlers. */
export interface UseWaveStateResult {
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
  /**
   * Questionnaire questions streamed in as a `tool-presentQuestionnaire` part
   * on the in-flight turn (generative UI) — non-null from the part's
   * `input-available` state until the committed `activeQuestionnaire` takes
   * over after the turn-result refetch. The Composer renders these as a
   * preview; interactivity comes only with `activeQuestionnaire` (isPending
   * disables the option grid until the server-derived state lands).
   */
  readonly streamingQuestions: readonly ChoiceQuestion[] | null;
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

  // Decisions live in `deriveTurnResultEffects` (pure); the hook applies the
  // side-effects. Order preserved from the old close branch: capture the close
  // result, then fold XP into the badge, then fire the tier-up toast.
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

  // Derive ChatEntry[] from chat_log. Pure; safe to run on every render
  // (memoized for stability across consumer re-renders).
  const chatEntries = useMemo<readonly ChatEntry[]>(
    () => (state.data ? deriveWaveChatEntries(state.data.chatLog) : []),
    [state.data],
  );

  // Active questionnaire for the Composer: the latest
  // `assistant.text_with_questionnaire` whose id has no later
  // `user.answers` entry in the chat log. Pure derivation extracted to
  // `deriveActiveQuestionnaire`; this stays a thin memo that guards on
  // `state.data` for render stability across consumer re-renders.
  const activeQuestionnaire = useMemo<ActiveQuestionnaire | null>(
    () => (state.data ? deriveActiveQuestionnaire(state.data.chatLog, state.data.waveId) : null),
    [state.data],
  );

  const isPending = state.isFetching || chat.status === "submitted" || chat.status === "streaming";

  // In-flight assistant parts, discarding failed attempts: a validation retry
  // re-streams the whole turn, and the server marks the boundary with a
  // NON-transient `data-turn-reset` part. Everything before the last reset is
  // a failed attempt's output (stale text/tool parts — TextUIPart carries no
  // id, so slicing on the marker's POSITION is the only reliable seam;
  // setMessages surgery mid-stream is undone by the SDK's next chunk).
  const lastAssistant = chat.messages.findLast((m) => m.role === "assistant");
  const allParts = lastAssistant?.parts ?? [];
  const lastResetIdx = allParts.findLastIndex((p) => p.type === "data-turn-reset");
  const liveParts = lastResetIdx === -1 ? allParts : allParts.slice(lastResetIdx + 1);

  // In-flight assistant prose: concatenated text parts of the live attempt
  // (empty when idle or between turns).
  const streamingText = liveParts
    .filter((p): p is Extract<typeof p, { type: "text" }> => p.type === "text")
    .map((p) => p.text)
    .join("");

  // In-flight questionnaire: the typed `tool-presentQuestionnaire` part on the
  // same message. Rendered only from `input-available` onward — the server
  // forwards no input-streaming deltas, and the input it does forward is the
  // redacted projection (grading keys stripped — see `streamWaveTurn`), a
  // structural subset of the typed input, hence the StreamedToolQuestion
  // adapter. (`recordComprehensionSignals` parts also stream but are
  // invisible to the learner by design — grading signals never render.)
  const questionnairePart = liveParts.find(
    (p): p is Extract<typeof p, { type: "tool-presentQuestionnaire" }> =>
      p.type === "tool-presentQuestionnaire",
  );
  const streamingQuestions =
    questionnairePart &&
    (questionnairePart.state === "input-available" ||
      questionnairePart.state === "output-available")
      ? questionnairePart.input.questions.map(adaptStreamedToolQuestion)
      : null;

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
    chatEntries,
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
    streamingQuestions,
    submitChatText,
    submitQuestionnaireAnswers,
  };
}
