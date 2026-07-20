"use client";

/*
 * Parity-locked port from kanagawa-whispers (~337 lines + 4 layered Nalu deltas).
 * Local array mutations are confined to handler closures whose results re-enter
 * React state via setX. Splitting would diverge from upstream and complicate
 * future re-syncs.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Check, ChevronLeft, ChevronRight, Mic, Plus } from "lucide-react";
import { t } from "@/i18n";
import { playWrong } from "@/lib/sound";
import { calculateMcXp } from "@/lib/scoring/xp";
import { parseQuestionnaireBuffer } from "@/lib/course/parseQuestionnaireBuffer";

export type { ChoiceQuestion } from "@/lib/course/adaptQuestionnaire";
import type { ChoiceQuestion } from "@/lib/course/adaptQuestionnaire";
import { deriveMcFeedback } from "@/lib/course/adaptQuestionnaire";

/** Read a localStorage key, returning null if storage is unavailable. */
function safeGetItem(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Chat input bar; also renders MC/free-text questionnaire cards when `questions` is set. */
export function Composer({
  value,
  onChange,
  onSend,
  disabled,
  questions,
  onComplete,
  isFirstMessage,
  persistKey,
  moveOn,
  onCorrectAnswer,
  waveTier,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled?: boolean;
  /** When non-empty, the composer renders a question card with navigation. */
  questions?: ChoiceQuestion[] | null;
  /** Called once every question has an answer. */
  onComplete?: (answers: { question: ChoiceQuestion; answer: string }[]) => void;
  /** When true, show the "What do you want to learn…" prompt. */
  isFirstMessage?: boolean;
  /** localStorage key for refresh-resilient questionnaire buffer. */
  persistKey?: string;
  /** When set, replaces the input row with a single advance button. */
  moveOn?: { readonly label: string; readonly onAdvance: () => void };
  /** Called with exact XP when the learner confirms a correct MC answer. */
  onCorrectAnswer?: (amount: number) => void;
  /** Wave tier — fallback for MC XP when a question carries no per-question tier. */
  waveTier?: number;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const hasQuestions = !!questions && questions.length > 0;

  // Per-question answers, indexed alongside `questions`. Reset whenever the
  // question set identity changes (new question batch from the assistant).
  const questionsKey = useMemo(
    () => (questions ? questions.map((q) => q.id).join("|") : ""),
    [questions],
  );
  const [answers, setAnswers] = useState<(string | null)[]>([]);
  // Per-question free-text drafts, indexed alongside `questions`. Free-text
  // answers stay editable on revisit (unlike MC, which locks on confirm), so
  // their text lives here rather than in the single parent-owned `value`.
  const [drafts, setDrafts] = useState<string[]>([]);
  const [step, setStep] = useState(0);
  const [slideDir, setSlideDir] = useState<"next" | "prev" | "none">("none");
  // Index of the option the user has tapped but not yet confirmed, per step.
  const [pending, setPending] = useState<(number | null)[]>([]);
  // Per-step transient feedback after Confirm — drives the pulse animation.
  const [feedback, setFeedback] = useState<("correct" | "wrong" | null)[]>([]);
  // While true, the option grid is locked (during the pulse).
  const [locked, setLocked] = useState(false);

  // The textarea's value: a per-question draft while a questionnaire is
  // active, otherwise the parent-owned chat-input string. `setInputValue`
  // routes writes to the matching store.
  const inputValue = hasQuestions ? (drafts[step] ?? "") : value;
  const setInputValue = (v: string) => {
    if (hasQuestions) {
      const next = [...drafts];
      next[step] = v;
      setDrafts(next);
    } else {
      onChange(v);
    }
  };

  // Initialise per-question state whenever the question set changes. Tries to
  // restore a persisted buffer (refresh-resilient); falls back to blank.
  //
  // This is ONE effect by design. It was formerly two — a hydrate effect and a
  // reset effect — and React ran the reset second, so its blank fill clobbered
  // the hydrate's restore. Merging removes the ordering bug: restore-or-blank
  // is now a single decision. SSR-safe.
  useEffect(() => {
    if (!hasQuestions) return;
    const len = questions!.length;
    const restored = parseQuestionnaireBuffer(
      persistKey && typeof window !== "undefined" ? safeGetItem(persistKey) : null,
      questionsKey,
      len,
    );
    setAnswers(restored ? [...restored.answers] : Array(len).fill(null));
    setDrafts(restored ? [...restored.drafts] : Array(len).fill(""));
    setStep(restored ? restored.step : 0);
    setPending(Array(len).fill(null));
    setFeedback(Array(len).fill(null));
    setSlideDir("none");
    setLocked(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionsKey]);

  // Persist the questionnaire buffer to localStorage on every change. Defined
  // AFTER the init effect so that, on mount, init reads localStorage before
  // this writes — the restore is never lost. SSR-safe.
  useEffect(() => {
    if (!persistKey || typeof window === "undefined" || !hasQuestions) return;
    try {
      window.localStorage.setItem(
        persistKey,
        JSON.stringify({ questionsKey, answers, step, drafts }),
      );
    } catch {
      // Quota / disabled — ignore.
    }
  }, [persistKey, questionsKey, answers, step, drafts, hasQuestions]);

  // Hydration recovery (issue #14): on a cold load of "/", a learner can type
  // into the topic composer before React hydrates. The textarea is fully
  // controlled (value=""), so hydration reconciles the raw DOM value back to the
  // empty parent state and the pre-hydration keystrokes are silently dropped —
  // the first submit does nothing and only retyping works. React preserves the
  // user's input on the DOM node across hydration, so at mount we can still read
  // it from the ref and adopt it into React state via the normal setInputValue
  // router (which forwards to the parent onChange). We deliberately do NOT try
  // to replay a pre-hydration Enter-press — preserving the text is the fix; the
  // learner presses Enter once more.
  //
  // Scoped to the free-text / first-message path (!hasQuestions): in
  // questionnaire mode the buffer-restore effect above owns textarea state, and
  // adopting a stale DOM value would fight it.
  useEffect(() => {
    if (hasQuestions) return;
    const dom = ref.current?.value ?? "";
    // Only adopt when the DOM holds pre-hydration text that the controlled value
    // lost. If React's controlled value already won (non-empty), leave it be.
    if (dom.length > 0 && value.length === 0) setInputValue(dom);
    // Mount-only: this reconciles a one-time hydration mismatch. Re-running on
    // value/setInputValue changes would re-adopt stale DOM text after the user
    // clears the field, so those deps are intentionally omitted — mirrors the
    // scoped disable on the buffer-init effect above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [inputValue]);

  const canSend = inputValue.trim().length > 0 && !disabled;
  const currentPending = hasQuestions ? (pending[step] ?? null) : null;
  const hasPending = currentPending != null;
  // A step is locked once it has a recorded answer — its option can no longer
  // be changed and no answer can be resubmitted for it.
  const stepLocked = hasQuestions && answers[step] != null;
  // "Confirm" mode: question is active, user picked an option, no free text,
  // and the step is not already locked.
  const confirmMode = hasQuestions && hasPending && !stepLocked && inputValue.trim().length === 0;

  const current = hasQuestions ? questions![step] : null;
  const total = hasQuestions ? questions!.length : 0;

  // A free-text question (no options) never locks its textarea — its answer
  // stays editable on revisit. MC questions still lock on confirm.
  const currentIsFreeText = !!current && current.options.length === 0;
  const textareaLocked = stepLocked && !currentIsFreeText;

  // Placeholder is dynamic by interaction type: an MC question keeps "or type
  // your own answer" (options exist to pick instead); a free-text question
  // uses a plain "type your answer"; otherwise it is the first-message or
  // continue prompt.
  const placeholder = hasQuestions
    ? current && current.options.length > 0
      ? t<string>("composer.placeholderAnswering")
      : t<string>("composer.placeholderAnswerFree")
    : isFirstMessage
      ? t<string>("composer.placeholderFirst")
      : t<string>("composer.placeholderContinue");

  const advanceAfterAnswer = (answer: string) => {
    if (!hasQuestions) return;
    const next = [...answers];
    next[step] = answer;
    setAnswers(next);

    // Find the next unanswered question, otherwise complete.
    const nextUnanswered = next.findIndex((a, i) => i !== step && a == null);
    if (next.every((a) => a != null)) {
      // The localStorage buffer is deliberately NOT cleared here. Its most
      // recent write (made just before this final answer) holds every answer
      // bar the last — so if the parent's submit fails and re-shows this
      // questionnaire, the Composer restores that buffer and the learner only
      // re-does the final step. On a successful submit the buffer is an orphan:
      // keyed and length-validated, it is never re-matched.
      onComplete?.(
        questions!.map((q, i) => ({
          question: q,
          // Free-text questions stay editable, so the live draft — not the
          // answer recorded at send time — is the source of truth, picking up
          // any back-edits. Fall back to the recorded answer if the draft was
          // blanked. MC questions use the recorded option text.
          answer: q.options.length === 0 ? drafts[i]?.trim() || next[i]! : next[i]!,
        })),
      );
      return;
    }
    if (step < total - 1) {
      setSlideDir("next");
      setStep(step + 1);
    } else if (nextUnanswered !== -1) {
      setSlideDir("next");
      setStep(nextUnanswered);
    }
  };

  const selectOption = (i: number) => {
    if (!hasQuestions || locked) return;
    // Once an answer is locked in for this step, it cannot be changed.
    if (answers[step] != null) return;
    // Tapping selects but does NOT advance. Confirm button locks it in.
    const next = [...pending];
    next[step] = i;
    setPending(next);
  };

  const clearPending = () => {
    if (!hasQuestions) return;
    // Don't clear a locked-in answer.
    if (answers[step] != null) return;
    if (pending[step] == null) return;
    const next = [...pending];
    next[step] = null;
    setPending(next);
  };

  const confirmSelection = () => {
    if (!hasQuestions || !current || currentPending == null || locked) return;
    const result = deriveMcFeedback(current.correctIndex, currentPending);
    const fb = [...feedback];
    fb[step] = result;
    setFeedback(fb);
    setLocked(true);
    if (result === "correct") {
      // Exact XP for a correct MC, computed client-side from the question's
      // tier — the designated `calculateMcXp` instant path. Falls back to the
      // wave tier, then to tier 1, when no per-question tier is present.
      // `onCorrectAnswer` routes through `useCourseXp.addXp`, which plays the
      // correct-answer sound centrally — no direct `playCorrect()` here.
      onCorrectAnswer?.(calculateMcXp(current.tier ?? waveTier ?? 1, true));
    } else if (result === "wrong") playWrong();
    // result === null: ungraded MC (clarify preference questions carry no
    // answer key). No feedback styling, no sound, no XP — punishing an opinion
    // with a red "wrong" outline + buzzer was the bug. The answer still locks
    // and advances below on the same uniform 750ms timer.

    const chosen = current.options[currentPending]!;
    // Hold the pulse briefly so it's perceivable, then advance.
    setTimeout(() => {
      setLocked(false);
      advanceAfterAnswer(chosen);
    }, 750);
  };

  const goPrev = () => {
    if (step === 0 || locked) return;
    setSlideDir("prev");
    setStep(step - 1);
  };
  const goNext = () => {
    if (step >= total - 1 || locked) return;
    setSlideDir("next");
    setStep(step + 1);
  };

  const handleSend = () => {
    if (disabled) return;
    if (hasQuestions && confirmMode) {
      confirmSelection();
      return;
    }
    if (!canSend) return;
    if (hasQuestions) {
      const answer = inputValue.trim();
      // Keep the draft — a free-text answer stays editable on revisit.
      clearPending();
      advanceAfterAnswer(answer);
    } else {
      onSend();
    }
  };

  if (moveOn) {
    return (
      <div className="px-3 pb-4 pt-3 bg-sumi-1/85 backdrop-blur-xl border-t border-sumi-4/60">
        <button
          onClick={moveOn.onAdvance}
          className="w-full h-11 inline-flex items-center justify-center rounded-2xl bg-spring-green text-sumi-0 font-medium tracking-tight transition active:scale-[0.99] hover:brightness-110"
        >
          {moveOn.label}
        </button>
        <p className="mt-2.5 text-center font-mono text-[10px] tracking-wider text-fuji-gray/80">
          {t<string>("app.disclaimer")}
        </p>
      </div>
    );
  }

  return (
    <div className="px-3 pb-4 pt-3 bg-sumi-1/85 backdrop-blur-xl border-t border-sumi-4/60">
      {hasQuestions && current && (
        <div className="mb-3 animate-message-in">
          {/* Header: counter + prev/next */}
          <div className="flex items-center justify-between mb-2 px-1">
            {current.options.length > 0 ? (
              <div className="flex items-center gap-2">
                <span
                  className="h-1 w-1 rounded-full"
                  style={{ background: "var(--carp-yellow)" }}
                />
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-fuji-gray">
                  {t<string>("composer.chooseLabel")}
                </span>
              </div>
            ) : (
              <div />
            )}
            <div className="flex items-center gap-1">
              <button
                aria-label={t<string>("composer.prev")}
                onClick={goPrev}
                disabled={step === 0}
                className="h-6 w-6 grid place-items-center rounded-md text-fuji-gray hover:text-foreground hover:bg-sumi-3 transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-fuji-gray"
              >
                <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} />
              </button>
              <span className="font-mono text-[10px] tabular-nums tracking-wider text-fuji-gray min-w-[28px] text-center">
                {step + 1}/{total}
              </span>
              <button
                aria-label={t<string>("composer.next")}
                onClick={goNext}
                disabled={step >= total - 1}
                className="h-6 w-6 grid place-items-center rounded-md text-fuji-gray hover:text-foreground hover:bg-sumi-3 transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-fuji-gray"
              >
                <ChevronRight className="h-3.5 w-3.5" strokeWidth={2} />
              </button>
            </div>
          </div>

          {/* Slide window */}
          <div className="overflow-hidden">
            <div
              key={`${questionsKey}:${step}:${slideDir}`}
              className={
                slideDir === "next"
                  ? "animate-q-slide-next"
                  : slideDir === "prev"
                    ? "animate-q-slide-prev"
                    : ""
              }
            >
              {/* Question prompt */}
              <p className="px-1 mb-2 text-[14px] leading-snug text-foreground/90 font-medium">
                {current.prompt}
              </p>
              {current.options.length > 0 && (
                <div className="grid grid-cols-1 gap-1.5">
                  {current.options.map((opt, i) => {
                    const isPending = currentPending === i;
                    const fb = feedback[step];
                    const isLockedAnswer = answers[step] != null;
                    const pulseClass =
                      isPending && fb === "correct"
                        ? " pulse-correct border-spring-green text-foreground"
                        : isPending && fb === "wrong"
                          ? " pulse-wrong border-wave-red text-foreground"
                          : "";
                    return (
                      <button
                        key={i}
                        onClick={() => selectOption(i)}
                        disabled={disabled || locked || isLockedAnswer}
                        className={
                          "group flex items-center gap-2.5 text-left rounded-xl px-3 py-2.5 text-[14px] leading-snug transition-all active:scale-[0.99] border disabled:cursor-not-allowed " +
                          (isLockedAnswer && !isPending ? "opacity-40 " : "") +
                          (isPending
                            ? "bg-sumi-3 border-spring-green text-foreground"
                            : "bg-sumi-2 hover:bg-sumi-3 border-sumi-4 hover:border-crystal/50 text-foreground/90") +
                          pulseClass
                        }
                      >
                        <span
                          className={
                            "font-mono text-[10px] transition-colors " +
                            (isPending
                              ? fb === "wrong"
                                ? "text-wave-red"
                                : "text-spring-green"
                              : "text-fuji-gray group-hover:text-crystal")
                          }
                        >
                          {String.fromCharCode(65 + i)}
                        </span>
                        <span className="flex-1">{opt}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
      <div className="flex items-end gap-1.5 rounded-2xl bg-sumi-3 border border-sumi-4 px-1.5 py-1 transition-colors focus-within:border-crystal/50">
        <button
          aria-label="Attach"
          className="h-9 w-9 shrink-0 grid place-items-center rounded-lg text-fuji-gray hover:text-foreground hover:bg-sumi-4 transition-colors"
        >
          <Plus className="h-[17px] w-[17px]" strokeWidth={1.75} />
        </button>

        <textarea
          ref={ref}
          rows={1}
          value={inputValue}
          disabled={textareaLocked}
          onChange={(e) => {
            if (e.target.value.length > 0) clearPending();
            setInputValue(e.target.value);
          }}
          onFocus={() => {
            // Returning to free-text drops the pending MC selection.
            if (hasQuestions) clearPending();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={placeholder}
          className="flex-1 resize-none bg-transparent px-1 py-2 text-[15px] leading-[1.4] outline-none placeholder:text-fuji-gray placeholder:font-normal"
        />

        {confirmMode ? (
          <button
            onClick={handleSend}
            disabled={locked || disabled}
            aria-label={t<string>("composer.confirm")}
            style={{ color: "var(--sumi-ink-0)" }}
            className="h-9 shrink-0 inline-flex items-center justify-center rounded-xl px-3 gap-1.5 bg-spring-green hover:brightness-110 transition active:scale-95 disabled:opacity-60"
          >
            <Check className="h-[15px] w-[15px]" strokeWidth={2.5} />
            <span className="text-[12px] font-medium tracking-wide">
              {t<string>("composer.confirm")}
            </span>
          </button>
        ) : canSend ? (
          <button
            onClick={handleSend}
            aria-label="Send"
            style={{ color: "var(--sumi-ink-0)" }}
            className="h-9 w-9 shrink-0 grid place-items-center rounded-xl bg-foreground hover:bg-crystal transition-colors active:scale-95"
          >
            <ArrowUp className="h-[17px] w-[17px]" strokeWidth={2.25} />
          </button>
        ) : (
          <button
            aria-label="Voice"
            className="h-9 w-9 shrink-0 grid place-items-center rounded-lg text-fuji-gray hover:text-foreground hover:bg-sumi-4 transition-colors"
          >
            <Mic className="h-[17px] w-[17px]" strokeWidth={1.75} />
          </button>
        )}
      </div>
      <p className="mt-2.5 text-center font-mono text-[10px] tracking-wider text-fuji-gray/80">
        {t<string>("app.disclaimer")}
      </p>
    </div>
  );
}
