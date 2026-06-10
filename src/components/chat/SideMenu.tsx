"use client";

import { Sheet, SheetContent } from "@/components/ui/sheet";
import { Plus, Settings, BookOpen, Volume2, VolumeX } from "lucide-react";
import { t } from "@/i18n";
import { useEffect, useState } from "react";
import { isMuted, setMuted, subscribeMute } from "@/lib/sound";

type Course = { id: string; title: string; subtitle: string; accent: string };

const ACCENT: Record<string, string> = {
  sakura: "var(--sakura-pink)",
  crystal: "var(--crystal-blue)",
  "spring-green": "var(--spring-green)",
  carp: "var(--carp-yellow)",
  aqua: "var(--wave-aqua-2)",
};

/** Slide-out left panel: course list, new-course CTA, profile, mute toggle. */
export function SideMenu({
  open,
  onOpenChange,
  activeCourseId,
  onSelectCourse,
  onNewCourse,
  onOpenSettings,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeCourseId?: string | null;
  onSelectCourse: (course: Course) => void;
  onNewCourse: () => void;
  onOpenSettings?: () => void;
}) {
  const courses = t<Course[]>("menu.courses");

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="left"
        className="w-[86vw] max-w-[340px] p-0 border-r border-sumi-4/80 bg-sumi-1/95 backdrop-blur-xl flex flex-col gap-0"
      >
        {/* Header */}
        <div className="px-5 pt-5 pb-3">
          <div className="flex items-center gap-2.5">
            <span className="h-1.5 w-1.5 rounded-full bg-spring-green" />
            <p className="font-mono text-[13px] tracking-tight">
              <span className="text-foreground">{t<string>("app.name")}</span>
              <span className="text-fuji-gray">/v1</span>
            </p>
          </div>
          <p className="mt-3 text-[11px] uppercase tracking-[0.2em] font-mono text-fuji-gray">
            {t<string>("menu.title")}
          </p>
          <p className="mt-1 text-[13px] text-fuji-gray/80">{t<string>("menu.subtitle")}</p>
        </div>

        {/* New course CTA — persistent */}
        <div className="px-3 pb-2">
          <button
            onClick={() => {
              onNewCourse();
              onOpenChange(false);
            }}
            className="w-full flex items-center gap-3 rounded-xl border border-dashed border-sumi-5 hover:border-crystal/60 bg-sumi-2/60 hover:bg-sumi-3 px-3 py-3 transition-colors group"
          >
            <span className="h-7 w-7 grid place-items-center rounded-lg bg-sumi-3 group-hover:bg-sumi-4 text-crystal">
              <Plus className="h-4 w-4" strokeWidth={2} />
            </span>
            <span className="text-[14px] font-medium text-foreground/90">
              {t<string>("menu.newCourse")}
            </span>
          </button>
        </div>

        {/* Courses list */}
        <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
          {courses.length === 0 ? (
            <p className="px-2 py-6 text-[13px] text-fuji-gray">{t<string>("menu.empty")}</p>
          ) : (
            courses.map((c) => {
              const active = c.id === activeCourseId;
              return (
                <button
                  key={c.id}
                  onClick={() => {
                    onSelectCourse(c);
                    onOpenChange(false);
                  }}
                  className={`w-full flex items-start gap-3 rounded-xl px-3 py-2.5 text-left transition-colors ${
                    active ? "bg-sumi-3" : "hover:bg-sumi-2"
                  }`}
                >
                  <span
                    className="mt-1.5 h-2 w-2 rounded-full shrink-0"
                    style={{ background: ACCENT[c.accent] ?? "var(--crystal-blue)" }}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-medium text-foreground/95 truncate">
                      {c.title}
                    </span>
                    <span className="block font-mono text-[11px] text-fuji-gray truncate">
                      {c.subtitle}
                    </span>
                  </span>
                  {active && (
                    <BookOpen className="h-3.5 w-3.5 text-fuji-gray mt-1" strokeWidth={1.75} />
                  )}
                </button>
              );
            })
          )}
        </div>

        {/* Footer — settings + profile */}
        <div className="border-t border-sumi-4/80 p-3">
          <div className="flex items-center gap-1">
            <button
              onClick={onOpenSettings}
              className="flex-1 flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-sumi-3 transition-colors"
            >
              <span
                className="h-9 w-9 rounded-full grid place-items-center text-[12px] font-medium text-sumi-0"
                style={{
                  background: "linear-gradient(135deg, var(--crystal-blue), var(--sakura-pink))",
                }}
              >
                YN
              </span>
              <span className="min-w-0 flex-1 text-left">
                <span className="block text-[13px] text-foreground/95 truncate">
                  {t<string>("menu.profileNamePlaceholder")}
                </span>
                <span className="block text-[11px] font-mono text-fuji-gray truncate">
                  {t<string>("menu.profileSubPlaceholder")}
                </span>
              </span>
              <Settings className="h-4 w-4 text-fuji-gray shrink-0" strokeWidth={1.75} />
              <span className="sr-only">{t<string>("menu.settings")}</span>
            </button>
            <MuteToggle />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function MuteToggle() {
  const [muted, setLocal] = useState<boolean>(() => isMuted());
  useEffect(() => subscribeMute(setLocal), []);
  const label = muted ? t<string>("menu.unmute") : t<string>("menu.mute");
  return (
    <button
      onClick={() => setMuted(!muted)}
      aria-label={label}
      title={label}
      aria-pressed={muted}
      className="h-9 w-9 shrink-0 grid place-items-center rounded-lg text-fuji-gray hover:text-foreground hover:bg-sumi-3 transition-colors"
    >
      {muted ? (
        <VolumeX className="h-4 w-4" strokeWidth={1.75} />
      ) : (
        <Volume2 className="h-4 w-4" strokeWidth={1.75} />
      )}
    </button>
  );
}
