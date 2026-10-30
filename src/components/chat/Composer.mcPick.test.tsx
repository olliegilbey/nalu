// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import { render, screen, fireEvent, act, type RenderResult } from "@testing-library/react";
import type { RawComposerAnswer } from "@/lib/course/shapeQuestionnaireAnswers";
import { installMemoryStorage } from "@/lib/testing/memoryStorage";
import { Composer, type ChoiceQuestion } from "./Composer";

/*
 * The unconfirmed MC pick and the confirm pulse lock. Tapping an option only
 * picks it; Confirm locks it in, then a 750ms pulse plays before the card
 * advances. Typing or focusing the textarea drops the pick. During the pulse
 * the options are disabled and prev/next do nothing. A card that unmounts or
 * swaps inside the pulse drops its pending advance (#132).
 */

const noop = () => {};

const questions: ChoiceQuestion[] = [
  {
    id: "q1",
    prompt: "Capital of France?",
    options: ["Paris", "Lyon", "Nice", "Lille"],
    correctIndex: 0,
  },
  {
    id: "q2",
    prompt: "Capital of Italy?",
    options: ["Milan", "Rome", "Turin", "Naples"],
    correctIndex: 1,
  },
];

// The next questionnaire. It reuses ids q1 and q2, as Wave questionnaires do,
// so only its `persistKey` tells the Composer the card changed (#118).
const nextQuestions: ChoiceQuestion[] = [
  {
    id: "q1",
    prompt: "Largest planet?",
    options: ["Mars", "Jupiter", "Venus", "Earth"],
    correctIndex: 1,
  },
  {
    id: "q2",
    prompt: "Smallest planet?",
    options: ["Mercury", "Saturn", "Uranus", "Neptune"],
    correctIndex: 0,
  },
];

/** The option button labelled `label`. */
const option = (label: string) => screen.getByText(label).closest("button")!;
const confirmButton = () => screen.queryByRole("button", { name: "Confirm" });

// Test-fixture slots, refilled per test: the rendered card and its submit spy.
let view: RenderResult;
let onComplete: Mock<(answers: readonly RawComposerAnswer[]) => void>;

/** A live answer card for `qs`, buffered under `persistKey`. */
const card = (qs: ChoiceQuestion[], persistKey: string) => (
  <Composer
    value=""
    onChange={noop}
    onSend={noop}
    onComplete={onComplete}
    questions={qs}
    persistKey={persistKey}
  />
);

/** Advance fake time by `ms`, flushing React updates. */
const elapse = (ms: number) => {
  // Block body: a void callback picks the sync `act` overload, not the Promise one.
  act(() => {
    vi.advanceTimersByTime(ms);
  });
};

beforeEach(() => {
  vi.useFakeTimers();
  // A live card needs a buffer key and working storage; fresh per test.
  installMemoryStorage();
  onComplete = vi.fn();
  view = render(card(questions, "nalu:test:mc-pick"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Composer unconfirmed MC pick", () => {
  it("drops the pick when the learner types, so clearing the text brings no Confirm back", () => {
    fireEvent.click(option("Lyon"));
    expect(confirmButton()).not.toBeNull();

    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "M" } });
    fireEvent.change(box, { target: { value: "" } });

    expect(confirmButton()).toBeNull();
    expect(option("Lyon").classList.contains("border-spring-green")).toBe(false);
  });

  it("drops the pick when the textarea gains focus", () => {
    fireEvent.click(option("Lyon"));
    expect(confirmButton()).not.toBeNull();

    fireEvent.focus(screen.getByRole("textbox"));

    expect(confirmButton()).toBeNull();
    expect(option("Lyon").classList.contains("border-spring-green")).toBe(false);
  });
});

describe("Composer confirm pulse lock", () => {
  it("blocks picks and navigation for 750ms, then advances", () => {
    fireEvent.click(option("Paris"));
    fireEvent.click(confirmButton()!);

    // Inside the pulse: every option is disabled, and Next does nothing.
    for (const label of ["Paris", "Lyon", "Nice", "Lille"]) {
      expect(option(label).disabled).toBe(true);
    }
    fireEvent.click(screen.getByRole("button", { name: "Next question" }));
    expect(screen.getByText("Capital of France?")).toBeTruthy();

    elapse(749);
    expect(screen.getByText("Capital of France?")).toBeTruthy();

    elapse(1);
    expect(screen.getByText("Capital of Italy?")).toBeTruthy();
    expect(option("Rome").disabled).toBe(false);
  });
});

describe("Composer confirm timer (#132)", () => {
  it("drops the pending advance when the card unmounts mid-pulse", () => {
    fireEvent.click(option("Paris"));
    fireEvent.click(confirmButton()!);
    elapse(750);
    // Confirm the final question, then unmount inside its pulse.
    fireEvent.click(option("Rome"));
    fireEvent.click(confirmButton()!);
    view.unmount();
    elapse(750);

    // A stale callback would submit the unmounted card's answers.
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("drops the pending advance when the card swaps mid-pulse", () => {
    fireEvent.click(option("Paris"));
    fireEvent.click(confirmButton()!);
    view.rerender(card(nextQuestions, "nalu:test:mc-pick-next"));
    elapse(750);

    // A stale callback would record "Paris" on the new card and move it to q2.
    expect(screen.getByText("Largest planet?")).toBeTruthy();
    expect(option("Jupiter").disabled).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("keeps the pending advance when a refetch re-renders the same card mid-pulse", () => {
    fireEvent.click(option("Paris"));
    fireEvent.click(confirmButton()!);
    // A refetch hands the parent a new array with the same questions and key.
    // The cancel keys on question ids, not array identity, so it must not fire.
    view.rerender(card([...questions], "nalu:test:mc-pick"));
    elapse(750);

    // A cancelled timer would leave the card frozen on q1 with the pulse lock on.
    expect(screen.getByText("Capital of Italy?")).toBeTruthy();
    expect(option("Rome").disabled).toBe(false);
  });
});
