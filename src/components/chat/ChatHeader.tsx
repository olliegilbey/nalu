"use client";

import { Menu, SquarePen } from "lucide-react";
import { t } from "@/i18n";

export function ChatHeader({
  onNew,
  onMenu,
  title,
}: {
  onNew?: () => void;
  onMenu?: () => void;
  /** When omitted, shows the app wordmark. When set, shows the conversation title. */
  title?: string | null;
}) {
  const showTitle = !!title;
  return (
    <header className="relative z-20 flex items-center justify-between px-4 h-14 border-b border-sumi-4/60 bg-sumi-1/70 backdrop-blur-xl">
      <button
        onClick={onMenu}
        aria-label={t("header.menu")}
        className="h-9 w-9 -ml-2 grid place-items-center rounded-lg text-fuji-gray hover:text-foreground hover:bg-sumi-3 transition-colors"
      >
        <Menu className="h-[18px] w-[18px]" strokeWidth={1.75} />
      </button>

      {showTitle ? (
        <div className="flex items-center gap-2 min-w-0 px-2">
          <span className="h-1.5 w-1.5 rounded-full bg-sakura-pink shrink-0" />
          <p className="text-[14px] font-medium tracking-tight truncate max-w-[60vw]">{title}</p>
        </div>
      ) : (
        <div className="flex items-center gap-2.5">
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-spring-green">
            <span className="absolute inset-0 rounded-full bg-spring-green/60 animate-ping" />
          </span>
          <p className="font-mono text-[13px] tracking-tight">
            <span className="text-foreground">{t<string>("app.name")}</span>
            <span className="text-fuji-gray">/v1</span>
          </p>
        </div>
      )}

      <button
        onClick={onNew}
        aria-label={t("header.newChat")}
        className="h-9 w-9 -mr-2 grid place-items-center rounded-lg text-fuji-gray hover:text-foreground hover:bg-sumi-3 transition-colors"
      >
        <SquarePen className="h-[17px] w-[17px]" strokeWidth={1.75} />
      </button>
    </header>
  );
}
