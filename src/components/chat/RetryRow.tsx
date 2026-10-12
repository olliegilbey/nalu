"use client";

import { t } from "@/i18n";
import { AssistantHeader } from "./AssistantHeader";

/** Inline Nalu row with a Retry button; sits where the next assistant bubble would appear. */
export function RetryRow({
  onRetry,
  disabled,
}: {
  readonly onRetry: () => void;
  readonly disabled: boolean;
}) {
  // The shared header makes the row read as Nalu speaking. The red dot marks
  // it as an error, not a reply.
  return (
    <div className="w-full animate-message-in">
      <AssistantHeader dotColor="var(--wave-red)" />
      <div className="flex items-center gap-3">
        <span className="text-[15px] leading-relaxed text-foreground/90">
          {t<string>("retry.message")}
        </span>
        <button
          onClick={onRetry}
          disabled={disabled}
          className="inline-flex items-center justify-center rounded-full bg-wave-blue-2 text-foreground px-3.5 py-1.5 text-[13px] font-medium transition active:scale-[0.99] hover:brightness-110 disabled:opacity-50 disabled:pointer-events-none"
        >
          {t<string>("retry.action")}
        </button>
      </div>
    </div>
  );
}
