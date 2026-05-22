"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChatHeader } from "./ChatHeader";
import { SideMenu } from "./SideMenu";

/**
 * Layout shell shared by the empty home page and the in-course chat view.
 *
 * Children render the scroll content; the parent owns Composer rendering and
 * passes it as `composer` so it stays sticky at the bottom.
 *
 * Course title (when present) is shown in the header. The side-menu nav is
 * inert for MVP (it always opens a fresh empty `/` per parity with whispers'
 * demo behavior — clicking a course just resets).
 */
export function ChatShell({
  title,
  children,
  composer,
  onNew,
  xp,
  xpPulseKey,
  xpGainAmount,
  showXp,
}: {
  readonly title?: string | null;
  readonly children: ReactNode;
  readonly composer: ReactNode;
  readonly onNew: () => void;
  readonly xp?: number;
  readonly xpPulseKey?: number;
  readonly xpGainAmount?: number;
  readonly showXp?: boolean;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Last-observed scroll content height. `children` is a fresh array on every
  // parent render — including on every Composer keystroke — so this effect runs
  // constantly. A keystroke doesn't change the message content, so `scrollHeight`
  // is unchanged and we skip the scroll. Without this guard the smooth-scroll
  // animation was re-triggered on each keystroke, making the chat visibly bob
  // up and down while typing a multi-line message.
  const lastScrollHeight = useRef(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (el.scrollHeight === lastScrollHeight.current) return;
    lastScrollHeight.current = el.scrollHeight;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [children]);

  return (
    <div className="relative flex flex-col h-[100dvh] text-foreground overflow-hidden noise">
      <ChatHeader
        title={title ?? null}
        onMenu={() => setMenuOpen(true)}
        onNew={onNew}
        xp={xp}
        xpPulseKey={xpPulseKey}
        xpGainAmount={xpGainAmount}
        showXp={showXp}
      />

      <SideMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        activeCourseId={null}
        onSelectCourse={() => {
          setMenuOpen(false);
          onNew();
        }}
        onNewCourse={() => {
          setMenuOpen(false);
          onNew();
        }}
      />

      <main ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-5 space-y-5 no-scrollbar">
        {children}
      </main>

      {composer}
    </div>
  );
}
