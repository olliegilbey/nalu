"use client";

import { useEffect, useRef } from "react";
import { ArrowUp, Check, ChevronLeft, ChevronRight, Mic, Plus } from "lucide-react";
import { t } from "@/i18n";
import { useQuestionnaire, type UseQuestionnaireOptions } from "@/hooks/useQuestionnaire";
import { useAdoptPreHydrationText } from "@/hooks/useAdoptPreHydrationText";

export type { ChoiceQuestion } from "@/lib/course/adaptQuestionnaire";

/** Props of {@link Composer}: the answer-card inputs plus the render-only ones. */
interface ComposerProps extends UseQuestionnaireOptions {
  /** When true, show the "What do you want to learn…" prompt. */
  readonly isFirstMessage?: boolean;
  /** When set, replaces the input row with a single advance button. */
  readonly moveOn?: { readonly label: string; readonly onAdvance: () => void };
}

/** Chat input bar that swaps in an answer card; `useQuestionnaire` owns the card's state. */
export function Composer({ isFirstMessage, moveOn, ...options }: ComposerProps) {
  const { value, onChange, disabled } = options;
  const ref = useRef<HTMLTextAreaElement>(null);
  const q = useQuestionnaire(options);
  const { current } = q;
  useAdoptPreHydrationText({
    textareaRef: ref,
    enabled: !q.hasQuestions,
    value,
    onAdopt: onChange,
  });

  // Grow the textarea with its text, up to a cap.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = Math.min(el.scrollHeight, 160) + "px";
  }, [q.inputValue]);

  // An MC question keeps "or type your own answer" (options exist to pick
  // instead); a free-text question uses a plain "type your answer";
  // otherwise it is the first-message or continue prompt.
  const placeholder = q.hasQuestions
    ? q.current && q.current.options.length > 0
      ? t<string>("composer.placeholderAnswering")
      : t<string>("composer.placeholderAnswerFree")
    : isFirstMessage
      ? t<string>("composer.placeholderFirst")
      : t<string>("composer.placeholderContinue");

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
      {q.hasQuestions && current && (
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
                onClick={q.goPrev}
                disabled={!q.canGoPrev || q.isPreview}
                className="h-6 w-6 grid place-items-center rounded-md text-fuji-gray hover:text-foreground hover:bg-sumi-3 transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-fuji-gray"
              >
                <ChevronLeft className="h-3.5 w-3.5" strokeWidth={2} />
              </button>
              <span className="font-mono text-[10px] tabular-nums tracking-wider text-fuji-gray min-w-[28px] text-center">
                {q.questionIndex + 1}/{q.total}
              </span>
              <button
                aria-label={t<string>("composer.next")}
                onClick={q.goNext}
                disabled={!q.canGoNext || q.isPreview}
                className="h-6 w-6 grid place-items-center rounded-md text-fuji-gray hover:text-foreground hover:bg-sumi-3 transition-colors disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-fuji-gray"
              >
                <ChevronRight className="h-3.5 w-3.5" strokeWidth={2} />
              </button>
            </div>
          </div>

          {/* Slide window */}
          <div className="overflow-hidden">
            <div
              key={`${q.questionsKey}:${q.questionIndex}:${q.slideDir}`}
              className={
                q.slideDir === "next"
                  ? "animate-q-slide-next"
                  : q.slideDir === "prev"
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
                    const isPending = q.currentPending === i;
                    const fb = q.currentFeedback;
                    const isLockedAnswer = q.answerLocked;
                    // An ungraded (no answer key) selection that has been
                    // confirmed — either mid-pulse (`locked`, answer not yet
                    // recorded) or on revisit (`isLockedAnswer`). Frozen in
                    // neutral crystal: the green selection border would read
                    // as "correct" once confirmed (PR #40 reviewer note).
                    const ungradedConfirmed =
                      isPending && fb == null && (isLockedAnswer || q.locked);
                    const pulseClass =
                      isPending && fb === "correct"
                        ? " pulse-correct border-spring-green text-foreground"
                        : isPending && fb === "wrong"
                          ? " pulse-wrong border-wave-red text-foreground"
                          : "";
                    return (
                      <button
                        key={i}
                        onClick={() => q.selectOption(i)}
                        disabled={disabled || q.locked || isLockedAnswer}
                        className={
                          "group flex items-center gap-2.5 text-left rounded-xl px-3 py-2.5 text-[14px] leading-snug transition-all active:scale-[0.99] border disabled:cursor-not-allowed " +
                          (isLockedAnswer && !isPending ? "opacity-40 " : "") +
                          (isPending
                            ? ungradedConfirmed
                              ? "bg-sumi-3 border-crystal text-foreground"
                              : "bg-sumi-3 border-spring-green text-foreground"
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
                                : ungradedConfirmed
                                  ? "text-crystal"
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
          value={q.inputValue}
          disabled={q.textareaLocked}
          // A preview stays focusable: `disabled` would drop focus (#118).
          readOnly={q.isPreview}
          onChange={(e) => q.typeInput(e.target.value)}
          // Returning to free text drops the pending MC pick.
          onFocus={q.clearPending}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              q.send();
            }
          }}
          placeholder={placeholder}
          className="flex-1 resize-none bg-transparent px-1 py-2 text-[15px] leading-[1.4] outline-none placeholder:text-fuji-gray placeholder:font-normal"
        />

        {q.confirmMode ? (
          <button
            onClick={q.send}
            disabled={q.locked || disabled}
            aria-label={t<string>("composer.confirm")}
            style={{ color: "var(--sumi-ink-0)" }}
            className="h-9 shrink-0 inline-flex items-center justify-center rounded-xl px-3 gap-1.5 bg-spring-green hover:brightness-110 transition active:scale-95 disabled:opacity-60"
          >
            <Check className="h-[15px] w-[15px]" strokeWidth={2.5} />
            <span className="text-[12px] font-medium tracking-wide">
              {t<string>("composer.confirm")}
            </span>
          </button>
        ) : q.canSend ? (
          <button
            onClick={q.send}
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
