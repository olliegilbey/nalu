"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { playCorrect, playWrong } from "@/lib/sound";
import { replaceAt } from "@/lib/utils";
import { deriveMcFeedback, type ChoiceQuestion } from "@/lib/course/adaptQuestionnaire";
import { deriveComposerControls, type ComposerControls } from "@/lib/course/deriveComposerControls";
import { deriveQuestionnaireAdvance } from "@/lib/course/deriveQuestionnaireAdvance";
import { deriveSendAction } from "@/lib/course/deriveSendAction";
import {
  restoreQuestionnaireBuffer,
  serializeQuestionnaireBuffer,
} from "@/lib/course/questionnaireBuffer";
import { questionnaireKey } from "@/lib/course/questionnaireKey";
import type { RawComposerAnswer } from "@/lib/course/shapeQuestionnaireAnswers";

/** How long a confirmed MC pick pulses before the card advances. */
const CONFIRM_PULSE_MS = 750;

/** Which way the question window slides on its next render. */
export type SlideDirection = "next" | "prev" | "none";

/** Confirm feedback per question: graded, or `null` when ungraded or unconfirmed. */
type McFeedback = "correct" | "wrong" | null;

/** Inputs of {@link useQuestionnaire}: the Composer's props, minus rendering ones. */
export interface UseQuestionnaireOptions {
  /** The answer card's questions; `null`, absent or empty means the plain chat input. */
  readonly questions?: readonly ChoiceQuestion[] | null;
  /** localStorage key for the card's answer buffer. Absent on a streaming preview. */
  readonly persistKey?: string;
  /** Parent-owned chat-input text, used when no card is shown. */
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onSend: () => void;
  readonly disabled?: boolean;
  /** Called once every question has an answer. */
  readonly onComplete?: (answers: readonly RawComposerAnswer[]) => void;
}

/** The answer card's state and handlers, for the Composer to render. */
export interface UseQuestionnaireResult extends ComposerControls {
  /** The card's question ids joined; part of the slide window's React key. */
  readonly questionsKey: string;
  readonly questionIndex: number;
  readonly slideDir: SlideDirection;
  /** Confirm feedback for the current question; drives the pulse. */
  readonly currentFeedback: McFeedback;
  /** True during the confirm pulse: the option grid and navigation are frozen. */
  readonly locked: boolean;
  /** Textarea change. Typing an answer drops the pending MC pick. */
  readonly typeInput: (text: string) => void;
  /** Drop the current question's unconfirmed pick. */
  readonly clearPending: () => void;
  /** Pick an option without confirming it. */
  readonly selectOption: (index: number) => void;
  /** Send button and Enter: confirm the pick, answer with text, or send chat. */
  readonly send: () => void;
  readonly goPrev: () => void;
  readonly goNext: () => void;
}

/**
 * The Composer's answer-card state machine: answers, drafts, the question on
 * screen, the unconfirmed pick, confirm feedback, and the pulse lock.
 *
 * Holds React state and side effects: localStorage, the pulse timer, sound,
 * and the parent callbacks. Pure helpers in `src/lib/course/` make the
 * decisions: which controls are live, what Send does, and where the card goes
 * next. The hook dispatches their results and checks their flags against the
 * pulse lock. Without a card it routes the textarea to the parent's chat input.
 */
export function useQuestionnaire({
  questions,
  persistKey,
  value,
  onChange,
  onSend,
  disabled,
  onComplete,
}: UseQuestionnaireOptions): UseQuestionnaireResult {
  // Identity of the question set. Not unique on its own: a Wave's
  // questionnaires reuse raw ids, so `persistKey` joins it below.
  const questionsKey = useMemo(() => questionnaireKey(questions ?? []), [questions]);
  // Per-question state, indexed alongside `questions`. Free-text drafts live
  // here, not in the parent `value`: they stay editable on revisit, while MC
  // answers lock on confirm.
  const [answers, setAnswers] = useState<readonly (string | null)[]>([]);
  const [drafts, setDrafts] = useState<readonly string[]>([]);
  const [questionIndex, setQuestionIndex] = useState(0);
  const [slideDir, setSlideDir] = useState<SlideDirection>("none");
  const [pending, setPending] = useState<readonly (number | null)[]>([]);
  const [feedback, setFeedback] = useState<readonly McFeedback[]>([]);
  const [locked, setLocked] = useState(false);
  // The confirm pulse's pending advance, so a card swap or unmount can cancel it.
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const controls = deriveComposerControls({
    questions,
    questionIndex,
    answers,
    drafts,
    pending,
    chatValue: value,
    disabled,
    persistKey,
  });
  const { hasQuestions, current, currentPending, answerLocked } = controls;

  // Initialise per-question state whenever the card changes: restore its
  // buffer if one matches, otherwise start blank. ONE effect by design: as two
  // (hydrate, then reset), the reset's blank fill clobbered the restore.
  // `persistKey` is part of the identity: Wave questionnaires reuse raw ids, so
  // a key change must re-read the right buffer (#118). SSR-safe.
  useEffect(() => {
    if (!questions?.length) return; // No card.
    const len = questions.length;
    const raw = persistKey && typeof window !== "undefined" ? safeGetItem(persistKey) : null;
    const restored = restoreQuestionnaireBuffer(raw, questionsKey, len);
    setAnswers(restored.answers);
    setDrafts(restored.drafts);
    setQuestionIndex(restored.questionIndex);
    setPending(Array(len).fill(null));
    setFeedback(Array(len).fill(null));
    setSlideDir("none");
    setLocked(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionsKey, persistKey]);

  // Cancel a pulsing confirm when the card swaps or unmounts. Its callback
  // closes over the old card's answers: it would record them on the new card,
  // or call `onComplete` with them (#132). Same identity as the init effect.
  // Keyed on ids, not the `questions` array: a refetch hands over a new array
  // for the same card, and cancelling then would freeze it locked.
  useEffect(() => () => clearTimeout(confirmTimer.current), [questionsKey, persistKey]);

  // Persist the buffer on every change. Declared AFTER the init effect so
  // that, on mount, init reads localStorage before this writes — the restore
  // is never lost. SSR-safe.
  useEffect(() => {
    if (!persistKey || typeof window === "undefined" || !hasQuestions) return;
    try {
      window.localStorage.setItem(
        persistKey,
        serializeQuestionnaireBuffer(questionsKey, { answers, questionIndex, drafts }),
      );
    } catch {
      // Quota / disabled — ignore.
    }
  }, [persistKey, questionsKey, answers, questionIndex, drafts, hasQuestions]);

  // Route textarea writes: the current question's draft, or the parent input.
  const setInputValue = (text: string) => {
    if (hasQuestions) setDrafts(replaceAt(drafts, questionIndex, text));
    else onChange(text);
  };

  const advanceAfterAnswer = (answer: string) => {
    if (!questions?.length) return; // No card.
    const advance = deriveQuestionnaireAdvance({
      questions,
      answers,
      drafts,
      questionIndex,
      answer,
    });
    setAnswers(advance.answers);
    if (advance.kind === "complete") {
      // The buffer is deliberately NOT cleared. Its last write holds every
      // answer bar this one, so a failed submit re-shows the card and the
      // learner re-does only the final question. After a successful submit
      // the buffer is an orphan: keyed and length-checked, it never re-matches.
      onComplete?.(advance.completed);
      return;
    }
    setSlideDir("next");
    setQuestionIndex(advance.nextIndex);
  };

  const selectOption = (index: number) => {
    // Tapping selects but does NOT advance; Confirm locks it in. A recorded
    // answer cannot change.
    if (!hasQuestions || locked || answerLocked) return;
    setPending(replaceAt(pending, questionIndex, index));
  };

  const clearPending = () => {
    if (answerLocked || currentPending == null) return;
    setPending(replaceAt(pending, questionIndex, null));
  };

  const confirmSelection = () => {
    if (!current || currentPending == null || locked) return;
    const result = deriveMcFeedback(current.correctIndex, currentPending);
    setFeedback(replaceAt(feedback, questionIndex, result));
    setLocked(true);
    // One sound per answer: a correct pick's sound plays here, and the
    // badge's tick for its XP stays silent. The Composer awards no XP; the
    // badge shows the server total once the Turn lands.
    if (result === "correct") playCorrect();
    else if (result === "wrong") playWrong();
    // result === null: ungraded MC (clarify preference questions carry no
    // answer key). No feedback styling, no sound — punishing an opinion
    // with a red "wrong" outline + buzzer was the bug. The answer still locks
    // and advances below on the same uniform timer.
    const chosen = current.options[currentPending]!;
    // Hold the pulse briefly so it's perceivable, then advance.
    confirmTimer.current = setTimeout(() => {
      setLocked(false);
      advanceAfterAnswer(chosen);
    }, CONFIRM_PULSE_MS);
  };

  const send = () => {
    const action = deriveSendAction(controls, disabled);
    if (action.kind === "confirm") confirmSelection();
    else if (action.kind === "chat") onSend();
    else if (action.kind === "answer") {
      // Keep the draft — a free-text answer stays editable on revisit.
      clearPending();
      advanceAfterAnswer(action.answer);
    }
  };

  return {
    ...controls,
    questionsKey,
    questionIndex,
    slideDir,
    currentFeedback: feedback[questionIndex] ?? null,
    locked,
    typeInput: (text) => {
      if (text.length > 0) clearPending();
      setInputValue(text);
    },
    clearPending,
    selectOption,
    send,
    goPrev: () => {
      if (!controls.canGoPrev || locked) return;
      setSlideDir("prev");
      setQuestionIndex(questionIndex - 1);
    },
    goNext: () => {
      if (!controls.canGoNext || locked) return;
      setSlideDir("next");
      setQuestionIndex(questionIndex + 1);
    },
  };
}

/** Read a localStorage key, returning null if storage is unavailable. */
function safeGetItem(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
