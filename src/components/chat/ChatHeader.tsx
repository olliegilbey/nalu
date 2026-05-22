"use client";

import { Menu, SquarePen, Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { t } from "@/i18n";

/**
 * Top chat bar: menu button, title-or-wordmark, an optional XP badge, and the
 * new-chat button.
 *
 * @param onNew - Invoked when the new-chat button is pressed.
 * @param onMenu - Invoked when the menu button is pressed.
 * @param title - Conversation title; when null/omitted the app wordmark shows.
 * @param xp - Accumulated course XP shown in the badge.
 * @param xpPulseKey - Bumped on each XP gain to trigger the badge animation.
 * @param xpGainAmount - Amount of the most recent gain, shown in the floater.
 * @param showXp - Render the XP badge even at 0 XP.
 */
export function ChatHeader({
  onNew,
  onMenu,
  title,
  xp = 0,
  xpPulseKey = 0,
  xpGainAmount = 10,
  showXp = false,
}: {
  onNew?: () => void;
  onMenu?: () => void;
  /** When omitted, shows the app wordmark. When set, shows the conversation title. */
  title?: string | null;
  /** Accumulated XP for the current course. */
  xp?: number;
  /** Incremented on each XP gain to trigger the badge animation. */
  xpPulseKey?: number;
  /** Amount gained on the most recent pulse (shown in the "+N XP" floater). */
  xpGainAmount?: number;
  /** When true, the XP badge is rendered even at 0 XP. */
  showXp?: boolean;
}) {
  const showTitle = !!title;
  const renderXp = showXp || xp > 0 || xpPulseKey > 0;
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

      <div className="flex items-center gap-1 -mr-2">
        {renderXp && <XpBadge xp={xp} pulseKey={xpPulseKey} gain={xpGainAmount} />}
        <button
          onClick={onNew}
          aria-label={t("header.newChat")}
          className="h-9 w-9 grid place-items-center rounded-lg text-fuji-gray hover:text-foreground hover:bg-sumi-3 transition-colors"
        >
          <SquarePen className="h-[17px] w-[17px]" strokeWidth={1.75} />
        </button>
      </div>
    </header>
  );
}

/**
 * Animated XP pill. Shows the pre-gain total during the pop animation, then
 * snaps to the new total as the "+N XP" floater fades — so the floater appears
 * to "land". Timings must match the `xp-badge-pop` / `xp-gain-float` keyframes.
 */
function XpBadge({ xp, pulseKey, gain }: { xp: number; pulseKey: number; gain: number }) {
  // The badge normally shows the live `xp` — a pure derivation, so an `xp`
  // change from localStorage hydration is reflected immediately. `frozen`
  // overrides it only during a gain pulse: it holds the pre-gain total while
  // the "+N XP" floater rises, then releases (back to `xp`) as the floater
  // lands, so the number appears to "catch" the floater.
  const [frozen, setFrozen] = useState<number | null>(null);
  const [pulsing, setPulsing] = useState(false);
  // The previous render's `xp` — the pre-gain total a pulse freezes.
  const prevXp = useRef(xp);

  // Pulse effect. Declared BEFORE the prevXp tracker below so it still sees
  // the PREVIOUS render's `xp` (a gain bumps `xp` and `pulseKey` together).
  useEffect(() => {
    if (pulseKey === 0) return;
    setFrozen(prevXp.current);
    setPulsing(true);
    const landAt = 520;
    const endAt = 900;
    const t1 = window.setTimeout(() => setFrozen(null), landAt);
    const t2 = window.setTimeout(() => setPulsing(false), endAt);
    return () => {
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [pulseKey]);

  // Track the latest `xp` for the next pulse's pre-gain freeze.
  useEffect(() => {
    prevXp.current = xp;
  });

  const displayed = frozen ?? xp;

  return (
    <div className="relative">
      <div
        className={
          "inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border bg-sumi-3 border-sumi-4 will-change-transform " +
          (pulsing ? "xp-badge-pop" : "")
        }
        style={{ color: "var(--spring-green)" }}
        aria-live="polite"
        aria-label={`${displayed} XP`}
      >
        <Sparkles className="h-3 w-3" strokeWidth={2.25} />
        <span className="font-mono text-[11px] tabular-nums tracking-wide text-foreground">
          {displayed}
        </span>
        <span className="font-mono text-[9px] tracking-[0.16em] uppercase text-fuji-gray">XP</span>
      </div>
      {pulsing && (
        <span
          key={pulseKey}
          className="xp-gain-float pointer-events-none absolute left-1/2 -translate-x-1/2 -top-1 font-mono text-[11px] font-semibold tracking-wide"
          style={{ color: "var(--spring-green)" }}
        >
          +{gain} XP
        </span>
      )}
    </div>
  );
}
