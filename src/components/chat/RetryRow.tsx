"use client";

import { t } from "@/i18n";

/** Inline Nalu row with a Retry button; sits where the next assistant bubble would appear. */
export function RetryRow({ onRetry }: { readonly onRetry: () => void }) {
  // Mirrors the assistant bubble header (dot + "nalu" label) so the row reads
  // as Nalu speaking. The red dot marks it as an error, not a reply.
  return (
    <div className="w-full animate-message-in">
      <div className="flex items-center gap-2 mb-1.5">
        <span className="h-1 w-1 rounded-full" style={{ background: "var(--wave-red)" }} />
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-fuji-gray">
          {t<string>("app.name")}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-[15px] leading-relaxed text-foreground/90">
          {t<string>("retry.message")}
        </span>
        <button
          onClick={onRetry}
          className="inline-flex items-center justify-center rounded-full bg-wave-blue-2 text-foreground px-3.5 py-1.5 text-[13px] font-medium transition active:scale-[0.99] hover:brightness-110"
        >
          {t<string>("retry.action")}
        </button>
      </div>
    </div>
  );
}
