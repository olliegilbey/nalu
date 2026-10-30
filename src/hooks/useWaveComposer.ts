"use client";

import { useState } from "react";
import {
  composerTextAfterFailure,
  composerTextAfterRetry,
  resendsFailedTurn,
} from "@/lib/course/failedChatText";
import { formatComposerAnswers } from "@/lib/course/formatComposerAnswers";
import {
  shapeQuestionnaireAnswers,
  type RawComposerAnswer,
} from "@/lib/course/shapeQuestionnaireAnswers";
import type { UseWaveStateResult } from "./useWaveState";

/** The slice of {@link UseWaveStateResult} that {@link useWaveComposer} sends through. */
type WaveComposerInput = Pick<
  UseWaveStateResult,
  | "chatEntries"
  | "activeQuestionnaire"
  | "isPending"
  | "failedTurn"
  | "submitChatText"
  | "submitQuestionnaireAnswers"
>;

/** Return shape of {@link useWaveComposer}: the Composer's text, the optimistic bubble, and the send handlers. */
export interface WaveComposer {
  readonly composerValue: string;
  readonly setComposerValue: (value: string) => void;
  /** The optimistic learner bubble's text. Null once the real entry lands, or the send failed. */
  readonly optimisticContent: string | null;
  /** The questionnaire key just submitted. Its card hides at once. */
  readonly dismissedKey: string | null;
  /** The Composer's `onSend`: submit a chat-text Turn. */
  readonly sendChatText: () => void;
  /** The Composer's `onComplete`: submit the open questionnaire's answers. */
  readonly completeQuestionnaire: (answers: readonly RawComposerAnswer[]) => void;
  /** The RetryRow's `onRetry`: re-send the failed Turn's payload. */
  readonly retryFailedTurn: () => void;
}

/**
 * WaveSession's Composer state and send handlers.
 *
 * Each send shows an optimistic bubble at once. A failed send drops it and
 * hands the input back: the chat text, or the question card. Retyped text
 * would spend a second Turn (issue #231). The text rules live in
 * `failedChatText.ts`.
 */
export function useWaveComposer(wave: WaveComposerInput): WaveComposer {
  const { chatEntries, activeQuestionnaire, isPending, failedTurn } = wave;
  const [composerValue, setComposerValue] = useState("");
  // Optimistic user message. `entryCountAtSubmit` is the `chatEntries.length`
  // captured at submit: the bubble shows while `chatEntries` has not grown past
  // it (server round-trip not yet landed) and hides the instant the real entry
  // appears, so it never duplicates the real entry. A failed send drops it:
  // the Composer gets the text or the card back instead.
  const [optimistic, setOptimistic] = useState<{
    readonly content: string;
    readonly entryCountAtSubmit: number;
  } | null>(null);
  // The questionnaire key just submitted — its question card is hidden from the
  // Composer immediately, rather than lingering until the server round-trip.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);

  const sendChatText = () => {
    // Free-text send path: submit chat-text turn. Composer-side guard
    // already filters empty strings (it disables the send button).
    const text = composerValue.trim();
    if (text.length === 0) return;
    // The failed Turn's own text reuses the entry the server already
    // shows, so it needs no optimistic copy.
    if (!resendsFailedTurn(failedTurn?.payload ?? null, text)) {
      setOptimistic({ content: text, entryCountAtSubmit: chatEntries.length });
    }
    setComposerValue("");
    // On failure, hand the text back and drop its optimistic copy:
    // retyped text would spend a second Turn (issue #231). A saved
    // entry comes back with the refetch.
    wave.submitChatText(text, {
      onError: () => {
        setComposerValue((value) => composerTextAfterFailure(value, text));
        setOptimistic(null);
      },
    });
  };

  const completeQuestionnaire = (answers: readonly RawComposerAnswer[]) => {
    if (!activeQuestionnaire) return;
    // Optimistic bubble + dismiss the question card at once. Domain-shape
    // mapper lives in `src/lib/` so the component stays a thin shell.
    setOptimistic({
      content: formatComposerAnswers(answers),
      entryCountAtSubmit: chatEntries.length,
    });
    setDismissedKey(activeQuestionnaire.questionsKey);
    // On submit failure, un-dismiss the question card and drop the
    // optimistic bubble. The Composer restores the learner's answers
    // from its localStorage buffer, so they only re-do the final step.
    // If the server saved the answers, the refetch closes the card
    // instead, and the Retry row re-sends them.
    wave.submitQuestionnaireAnswers(shapeQuestionnaireAnswers(answers), {
      onError: () => {
        setDismissedKey(null);
        setOptimistic(null);
      },
    });
  };

  const retryFailedTurn = () => {
    if (isPending || !failedTurn) return;
    setComposerValue((value) => composerTextAfterRetry(value, failedTurn.payload));
    failedTurn.retry();
  };

  return {
    composerValue,
    setComposerValue,
    optimisticContent:
      optimistic && chatEntries.length === optimistic.entryCountAtSubmit
        ? optimistic.content
        : null,
    dismissedKey,
    sendChatText,
    completeQuestionnaire,
    retryFailedTurn,
  };
}
