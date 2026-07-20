// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { act } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { Composer, type ChoiceQuestion } from "./Composer";

/*
 * Regression coverage for issue #14: keystrokes typed into the topic composer
 * before React hydrates were silently discarded. These tests reproduce the real
 * cold-load sequence faithfully — server-render the composer, seed the textarea
 * with pre-hydration text (as a fast typist would), then hydrate — and assert
 * the mount effect recovers that text into React state via onChange. The
 * negative cases lock the scope: adoption must not fire in questionnaire mode
 * or when the controlled value already holds text.
 */

const noop = () => {};

/** SSR-render `ui`, seed the textarea's DOM value to `preTyped`, then hydrate. */
function hydrateWithPreTypedText(ui: React.ReactElement, preTyped: string): Root {
  const container = document.createElement("div");
  container.innerHTML = renderToString(ui);
  document.body.appendChild(container);
  // Simulate the learner having typed before the JS bundle hydrated: the raw
  // DOM value is present, but React's controlled state does not know about it.
  const textarea = container.querySelector("textarea");
  if (textarea) textarea.value = preTyped;
  let root!: Root;
  act(() => {
    root = hydrateRoot(container, ui);
  });
  return root;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Composer pre-hydration recovery (issue #14)", () => {
  it("adopts the raw DOM value when the controlled value is empty (topic path)", () => {
    const onChange = vi.fn();
    const ui = <Composer value="" onChange={onChange} onSend={noop} isFirstMessage />;

    const root = hydrateWithPreTypedText(ui, "photosynthesis");
    act(() => root.unmount());

    expect(onChange).toHaveBeenCalledWith("photosynthesis");
  });

  it("does not adopt when the controlled value is already non-empty", () => {
    const onChange = vi.fn();
    // Parent state already holds text — React's value is authoritative, so a
    // stray DOM value must not clobber it.
    const ui = <Composer value="already here" onChange={onChange} onSend={noop} isFirstMessage />;

    const root = hydrateWithPreTypedText(ui, "stale dom text");
    act(() => root.unmount());

    expect(onChange).not.toHaveBeenCalledWith("stale dom text");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not adopt in questionnaire mode (the buffer-restore effect owns state)", () => {
    const onChange = vi.fn();
    const questions: ChoiceQuestion[] = [
      { id: "q1", prompt: "Pick one", options: ["A", "B"], correctIndex: 0, tier: 1 },
    ];
    const ui = <Composer value="" onChange={onChange} onSend={noop} questions={questions} />;

    const root = hydrateWithPreTypedText(ui, "stray text");
    act(() => root.unmount());

    // In questionnaire mode the textarea is backed by per-question drafts, not
    // the parent onChange — the recovery effect must bail out entirely.
    expect(onChange).not.toHaveBeenCalled();
  });
});
