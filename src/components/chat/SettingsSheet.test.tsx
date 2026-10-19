// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { UseCustomInstructionsResult } from "@/hooks/useCustomInstructions";
import { PROFILE } from "@/lib/config/tuning";

/*
 * The learner reaches the settings sheet from the side menu's Settings button,
 * on every page, because the shared ChatShell wires it. Renders the real
 * ChatShell, SideMenu and SettingsSheet. `useCustomInstructions` is stubbed:
 * the test records whether the sheet asked it to load, and what Save sent.
 */

const hook = vi.hoisted(() => ({
  value: {} as UseCustomInstructionsResult,
  openArgs: [] as boolean[],
}));
vi.mock("@/hooks/useCustomInstructions", () => ({
  useCustomInstructions: (open: boolean) => {
    hook.openArgs.push(open);
    return hook.value;
  },
}));

import { ChatShell } from "./ChatShell";

const SAVED = "Keep sessions short and varied.";

beforeEach(() => {
  cleanup();
  hook.openArgs = [];
  hook.value = { saved: SAVED, loadFailed: false, isSaving: false, save: vi.fn() };
});

/** Render the shell, open the side menu, and tap its Settings button. */
function openSettingsFromSideMenu() {
  render(
    <ChatShell composer={null} onNew={vi.fn()}>
      {null}
    </ChatShell>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Menu" }));
  fireEvent.click(screen.getByRole("button", { name: /Settings/ }));
}

describe("SettingsSheet", () => {
  it("stays closed, and loads nothing, until Settings is tapped", () => {
    render(
      <ChatShell composer={null} onNew={vi.fn()}>
        {null}
      </ChatShell>,
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(hook.openArgs.every((open) => !open)).toBe(true);
  });

  it("opens from the side menu's Settings button and shows the saved value", () => {
    openSettingsFromSideMenu();

    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(hook.openArgs.at(-1)).toBe(true);
    const box = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Custom instructions" });
    expect(box.value).toBe(SAVED);
  });

  it("sends the typed text on Save", () => {
    openSettingsFromSideMenu();

    fireEvent.change(screen.getByRole("textbox", { name: "Custom instructions" }), {
      target: { value: "I learn best through analogies" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(hook.value.save).toHaveBeenCalledWith("I learn best through analogies");
  });

  it("shows the next-Wave help line and the characters left", () => {
    openSettingsFromSideMenu();

    expect(screen.getByText("Changes apply from your next Wave.")).toBeTruthy();
    // The cap minus the 31-character saved value.
    const left = PROFILE.maxCustomInstructionsLength - 31;
    expect(screen.getByText(`${left} characters left`)).toBeTruthy();
  });

  it("caps the text area at the tunable", () => {
    openSettingsFromSideMenu();

    const box = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Custom instructions" });
    expect(box.maxLength).toBe(PROFILE.maxCustomInstructionsLength);
  });

  it("shows an empty box when nothing is saved", () => {
    hook.value = { ...hook.value, saved: null };
    openSettingsFromSideMenu();

    const box = screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Custom instructions" });
    expect(box.value).toBe("");
  });

  it("says so when the saved value fails to load, and offers no form", () => {
    hook.value = { ...hook.value, saved: undefined, loadFailed: true };
    openSettingsFromSideMenu();

    expect(screen.getByText(/Couldn't load your settings/)).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: "Custom instructions" })).toBeNull();
  });
});
