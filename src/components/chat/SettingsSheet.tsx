"use client";

import { useId, useState } from "react";
import { Sheet, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { useCustomInstructions } from "@/hooks/useCustomInstructions";
import { PROFILE } from "@/lib/config/tuning";
import { t } from "@/i18n";

/**
 * Slide-out right panel for learner settings: custom instructions only, for
 * now. The side menu's Settings button opens it, wired by `ChatShell`, so it
 * opens on every page. `useCustomInstructions` reads the saved text while the
 * sheet is open and owns the save.
 */
export function SettingsSheet({
  open,
  onOpenChange,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  const { saved, loadFailed, isSaving, save } = useCustomInstructions(open);

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-[86vw] max-w-[380px] p-0 border-l border-sumi-4/80 bg-sumi-1/95 backdrop-blur-xl flex flex-col gap-0"
      >
        <div className="px-5 pt-5 pb-3">
          <SheetTitle className="text-[15px] font-medium tracking-tight">
            {t<string>("settings.title")}
          </SheetTitle>
          <SheetDescription className="mt-1 text-[13px] text-fuji-gray/80">
            {t<string>("settings.description")}
          </SheetDescription>
        </div>
        {saved === undefined ? (
          <p className="px-5 py-3 text-[13px] text-fuji-gray">
            {t<string>(loadFailed ? "settings.loadFailed" : "settings.loading")}
          </p>
        ) : (
          // Keyed on the saved value: when a save or a refetch changes it,
          // the form remounts and its draft restarts from the stored text.
          <CustomInstructionsForm
            key={saved ?? ""}
            saved={saved}
            isSaving={isSaving}
            onSave={save}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

/** The custom-instructions form: label, text area, characters left, help line, Save. */
function CustomInstructionsForm({
  saved,
  isSaving,
  onSave,
}: {
  readonly saved: string | null;
  readonly isSaving: boolean;
  readonly onSave: (text: string) => void;
}) {
  const [draft, setDraft] = useState(saved ?? "");
  const id = useId();
  // Counts raw characters, as the text area's `maxLength` does. The server
  // caps the trimmed text, so a draft within `maxLength` always saves.
  const remaining = PROFILE.maxCustomInstructionsLength - draft.length;

  return (
    <form
      className="px-5 pb-5 flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(draft);
      }}
    >
      <label htmlFor={id} className="text-[13px] font-medium text-foreground/90">
        {t<string>("settings.customInstructionsLabel")}
      </label>
      <textarea
        id={id}
        rows={6}
        value={draft}
        maxLength={PROFILE.maxCustomInstructionsLength}
        onChange={(e) => setDraft(e.target.value)}
        placeholder={t<string>("settings.customInstructionsPlaceholder")}
        className="resize-none rounded-2xl bg-sumi-3 border border-sumi-4 px-3 py-2.5 text-[14px] leading-[1.45] outline-none transition-colors focus:border-crystal/50 placeholder:text-fuji-gray"
      />
      <p className="self-end font-mono text-[11px] text-fuji-gray">
        {t<string>("settings.remaining").replace("{n}", String(remaining))}
      </p>
      <p className="text-[12px] text-fuji-gray">{t<string>("settings.nextWaveHelp")}</p>
      <button
        type="submit"
        disabled={isSaving}
        className="mt-2 self-end inline-flex items-center justify-center rounded-full bg-wave-blue-2 text-foreground px-4 py-1.5 text-[13px] font-medium transition active:scale-[0.99] hover:brightness-110 disabled:opacity-50 disabled:pointer-events-none"
      >
        {t<string>("settings.save")}
      </button>
    </form>
  );
}
