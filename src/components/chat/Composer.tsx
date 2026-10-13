"use client";

import { useEffect, useRef } from "react";
import { ArrowUp, Check, Mic, Plus } from "lucide-react";
import { t } from "@/i18n";
import { useQuestionnaire, type UseQuestionnaireOptions } from "@/hooks/useQuestionnaire";
import { useAdoptPreHydrationText } from "@/hooks/useAdoptPreHydrationText";
import { AnswerCard } from "./AnswerCard";

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
      {q.hasQuestions && q.current && (
        <AnswerCard question={q.current} questionnaire={q} disabled={disabled} />
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
