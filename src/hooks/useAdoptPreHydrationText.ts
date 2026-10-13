"use client";

import { useEffect, type RefObject } from "react";

/** Inputs of {@link useAdoptPreHydrationText}. */
export interface UseAdoptPreHydrationTextOptions {
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** Only the plain chat input adopts; an answer card restores its own buffer. */
  readonly enabled: boolean;
  /** The controlled value at mount. */
  readonly value: string;
  /** Receives the adopted text. */
  readonly onAdopt: (text: string) => void;
}

/**
 * Keep text typed into a textarea before React hydrated (issue #14).
 *
 * On a cold load of "/", a learner can type into the topic composer before
 * React hydrates. Hydration keeps that text on the DOM node: react-dom's
 * `initTextarea` sets only `defaultValue`. But the textarea is controlled and
 * parent state is still "", so React never sees the text. Enter finds an
 * empty input and does nothing, and the next re-render (`updateTextarea`)
 * writes "" over the DOM text. At mount the text is still on the node, so we
 * read it from the ref and adopt it into React state. We deliberately do NOT
 * try to replay a pre-hydration Enter-press — preserving the text is the fix;
 * the learner presses Enter once more.
 *
 * Disabled for an answer card: its buffer-restore effect owns textarea state,
 * and adopting a stale DOM value would fight it.
 */
export function useAdoptPreHydrationText({
  textareaRef,
  enabled,
  value,
  onAdopt,
}: UseAdoptPreHydrationTextOptions): void {
  useEffect(() => {
    if (!enabled) return;
    const dom = textareaRef.current?.value ?? "";
    // Only adopt when the DOM holds text that React state lacks. A non-empty
    // controlled value is authoritative: the next re-render writes it over the DOM.
    if (dom.length > 0 && value.length === 0) onAdopt(dom);
    // Mount-only: this reconciles a one-time hydration mismatch. Re-running on
    // value/onAdopt changes would re-adopt stale DOM text after the user
    // clears the field, so those deps are intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
