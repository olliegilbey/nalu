"use client";

import { t } from "@/i18n";

/** The dot + "nalu" label above every assistant row; `dotColor` is a CSS colour. */
export function AssistantHeader({
  dotColor = "var(--sakura-pink)",
}: {
  readonly dotColor?: string;
}) {
  // Inline style, not a Tailwind class, so callers can pass any palette var.
  return (
    <div className="flex items-center gap-2 mb-1.5">
      <span className="h-1 w-1 rounded-full" style={{ background: dotColor }} />
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-fuji-gray">
        {t<string>("app.name")}
      </span>
    </div>
  );
}
