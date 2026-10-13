// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { installMemoryStorage } from "@/lib/testing/memoryStorage";
import { Composer, type ChoiceQuestion } from "./Composer";

/*
 * The unconfirmed MC pick and the confirm pulse lock. Tapping an option only
 * picks it; Confirm locks it in, then a 750ms pulse plays before the card
 * advances. Typing or focusing the textarea drops the pick. During the pulse
 * the options are disabled and prev/next do nothing.
 */

const noop = () => {};

const questions: ChoiceQuestion[] = [
  {
    id: "q1",
    prompt: "Capital of France?",
    options: ["Paris", "Lyon", "Nice", "Lille"],
    correctIndex: 0,
    tier: 1,
  },
  {
    id: "q2",
    prompt: "Capital of Italy?",
    options: ["Milan", "Rome", "Turin", "Naples"],
    correctIndex: 1,
    tier: 1,
  },
];

/** The option button labelled `label`. */
const option = (label: string) => screen.getByText(label).closest("button")!;
const confirmButton = () => screen.queryByRole("button", { name: "Confirm" });

beforeEach(() => {
  vi.useFakeTimers();
  // A live card needs a buffer key and working storage; fresh per test.
  installMemoryStorage();
  render(
    <Composer
      value=""
      onChange={noop}
      onSend={noop}
      questions={questions}
      persistKey="nalu:test:mc-pick"
    />,
  );
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

    // Block body: a void callback picks the sync `act` overload, not the Promise one.
    act(() => {
      vi.advanceTimersByTime(749);
    });
    expect(screen.getByText("Capital of France?")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByText("Capital of Italy?")).toBeTruthy();
    expect(option("Rome").disabled).toBe(false);
  });
});
