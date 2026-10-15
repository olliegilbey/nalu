"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { t } from "@/i18n";
import type { ChoiceQuestion } from "@/lib/course/adaptQuestionnaire";
import { MC_OPTION_KEYS } from "@/lib/types/mcOptionKey";
import type { UseQuestionnaireResult } from "@/hooks/useQuestionnaire";

/** Props of {@link AnswerCard}. */
interface AnswerCardProps {
  /** The question on screen. */
  readonly question: ChoiceQuestion;
  readonly questionnaire: UseQuestionnaireResult;
  readonly disabled?: boolean;
}

/** The Composer's answer card: header with prev/next, the prompt, and the MC option grid. */
export function AnswerCard({ question, questionnaire: q, disabled }: AnswerCardProps) {
  return (
    <div className="mb-3 animate-message-in">
      {/* Header: counter + prev/next */}
      <div className="flex items-center justify-between mb-2 px-1">
        {question.options.length > 0 ? (
          <div className="flex items-center gap-2">
            <span className="h-1 w-1 rounded-full" style={{ background: "var(--carp-yellow)" }} />
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
            {question.prompt}
          </p>
          {question.options.length > 0 && (
            <div className="grid grid-cols-1 gap-1.5">
              {question.options.map((opt, i) => {
                const isPending = q.currentPending === i;
                const fb = q.currentFeedback;
                const isLockedAnswer = q.answerLocked;
                // An ungraded (no answer key) selection that has been
                // confirmed — either mid-pulse (`locked`, answer not yet
                // recorded) or on revisit (`isLockedAnswer`). Frozen in
                // neutral crystal: the green selection border would read
                // as "correct" once confirmed (PR #40 reviewer note).
                const ungradedConfirmed = isPending && fb == null && (isLockedAnswer || q.locked);
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
                      {MC_OPTION_KEYS[i]}
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
  );
}
