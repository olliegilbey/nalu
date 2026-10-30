"use client";

import { useRef, useState } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { toast } from "sonner";
import { devUserHeaders } from "@/lib/trpc";
import { deriveStreamingTurn, type StreamingTurn } from "@/lib/course/deriveStreamingTurn";
import type { WaveTurnResultData, WaveTurnUIMessage } from "@/lib/types/waveStream";
import type { SubmitTurnBody, SubmitTurnPayload } from "@/lib/types/waveTurnInput";

/** Per-call options for one Wave send. `onError` lets the caller restore its input. */
export interface SubmitTurnOptions {
  readonly onError?: () => void;
}

/** Inputs to {@link useWaveTurnChat}. */
interface UseWaveTurnChatOptions {
  readonly courseId: string;
  readonly waveNumber: number;
  /** The `wave.getState` query key. Each finished request refetches it. */
  readonly stateQueryKey: QueryKey;
  /** Applies a `data-turn-result` part: close result, XP, tier-up toast. */
  readonly onTurnResult: (result: WaveTurnResultData) => void;
}

/** Return shape of {@link useWaveTurnChat}: the in-flight Turn, the last failed payload, and the send. */
export interface WaveTurnChat extends StreamingTurn {
  /** True while a Turn is submitted or streaming. */
  readonly isSending: boolean;
  /** This tab's last failed payload. A new send clears it. */
  readonly failedPayload: SubmitTurnPayload | null;
  /** Every Wave send goes through here, a Retry included. */
  readonly sendTurn: (payload: SubmitTurnPayload, opts?: SubmitTurnOptions) => void;
}

/**
 * The Wave Turn's `useChat` wiring against the streaming route
 * (`/api/course/[courseId]/wave/[waveNumber]/turn`).
 *
 * `useChat` manages ONLY the in-flight Turn: its status and streaming
 * assistant text (streaming plan decision 1). Committed entries render from
 * `wave.getState`. On finish we refetch that query, then clear `useChat`'s
 * transient messages, so the canonical server-derived entry replaces the
 * streamed bubble. A failed send toasts, calls the caller's `onError`, and
 * records its payload for `deriveRetryableWaveTurn` (issue #231).
 */
export function useWaveTurnChat({
  courseId,
  waveNumber,
  stateQueryKey,
  onTurnResult,
}: UseWaveTurnChatOptions): WaveTurnChat {
  const qc = useQueryClient();

  // The Turn in flight: its payload and the caller's per-call error hook.
  // `useWaveComposer` uses the hook to restore its input on failure. `useChat`'s
  // onError is chat-level and gets only the error, so `sendTurn` sets this ref
  // just before sendMessage. onError consumes it once; onFinish clears it.
  const inFlightTurnRef = useRef<
    (SubmitTurnOptions & { readonly payload: SubmitTurnPayload }) | null
  >(null);
  // This tab's last failed payload. A new send clears it.
  // `deriveRetryableWaveTurn` decides whether a Retry may re-send it.
  const [failedPayload, setFailedPayload] = useState<SubmitTurnPayload | null>(null);

  const chat = useChat<WaveTurnUIMessage>({
    // One chat instance per wave — id remounts state on wave navigation.
    id: `wave-${courseId}-${waveNumber}`,
    transport: new DefaultChatTransport({
      api: `/api/course/${courseId}/wave/${waveNumber}/turn`,
      // Dev auth stub: the route resolves the user from `x-dev-user-id` in
      // non-production (same seam as the tRPC link — see readRequestSession).
      // Without it every dev streaming request 404s. Prod: session cookie.
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
        onTurnResult(part.data);
      }
    },
    // The AI SDK runs onFinish after every request, a failed one included.
    onFinish: () => {
      inFlightTurnRef.current = null;
      // Committed state is server-derived; refetch then drop the transient
      // streaming messages so the bubble is replaced by the canonical turn.
      void qc.invalidateQueries({ queryKey: stateQueryKey }).then(() => {
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

  // In-flight prose + questionnaire preview from the live attempt only.
  // `deriveStreamingTurn` holds the slicing (failed attempts end at the last
  // `data-turn-reset` marker). Recomputed each render, like the stream itself.
  const { streamingText, streamingQuestions } = deriveStreamingTurn(chat.messages);

  // The server reads only `payload`. The message text is useChat's transient
  // copy, never rendered.
  const sendTurn = (payload: SubmitTurnPayload, opts?: SubmitTurnOptions) => {
    setFailedPayload(null);
    inFlightTurnRef.current = { payload, onError: opts?.onError };
    const text = payload.kind === "chat-text" ? payload.text : "Answers submitted";
    // Typed from the route's schema: `useChat`'s own `body` is a bare `object`.
    const body: SubmitTurnBody = { payload };
    void chat.sendMessage({ text }, { body });
  };

  return {
    isSending: chat.status === "submitted" || chat.status === "streaming",
    failedPayload,
    streamingText,
    streamingQuestions,
    sendTurn,
  };
}
