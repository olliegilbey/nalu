// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import { installMemoryStorage } from "@/lib/testing/memoryStorage";
import { Composer, type ChoiceQuestion } from "./Composer";

/*
 * Colour of a confirmed ungraded MC pick. An ungraded question (a clarify
 * preference question) carries no answer key, so no pick is "correct". Green
 * after Confirm would read as graded feedback. Once confirmed, the pick must
 * freeze in neutral crystal: during the 750ms lock pulse and on revisit.
 * Before Confirm it stays green, the shared selection indicator.
 *
 * Assertions check exact class tokens with `classList`. A substring check
 * would also match the unselected hover classes (`hover:border-crystal/50`).
 */

const noop = () => {};

// Two ungraded questions (no `correctIndex`), so confirming the first one
// advances to the second and Previous can revisit the first.
const questions: ChoiceQuestion[] = [
  { id: "q1", prompt: "How do you like to learn?", options: ["Reading", "Doing", "Watching"] },
  { id: "q2", prompt: "How much time per day?", options: ["5 min", "15 min", "30 min"] },
];

/** The option button whose label is `label`, plus its letter badge. */
function optionParts(label: string) {
  const button = screen.getByText(label).closest("button")!;
  const letter = within(button).getByText(/^[A-D]$/);
  return { button, letter };
}

beforeEach(() => {
  vi.useFakeTimers();
  // A live card needs a buffer key; a keyless one is a read-only preview.
  // Fresh storage per test keeps one test's buffer out of the next.
  installMemoryStorage();
  render(
    <Composer
      value=""
      onChange={noop}
      onSend={noop}
      questions={questions}
      persistKey="nalu:test:ungraded"
    />,
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Composer ungraded MC confirm colour", () => {
  it("keeps a picked but unconfirmed option green", () => {
    fireEvent.click(optionParts("Doing").button);

    const { button, letter } = optionParts("Doing");
    expect(button.classList.contains("border-spring-green")).toBe(true);
    expect(letter.classList.contains("text-spring-green")).toBe(true);
  });

  it("freezes a confirmed pick in crystal during the lock pulse", () => {
    fireEvent.click(optionParts("Doing").button);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));

    // Still inside the 750ms pulse: the answer is not yet recorded.
    const { button, letter } = optionParts("Doing");
    expect(button.classList.contains("border-crystal")).toBe(true);
    expect(button.classList.contains("border-spring-green")).toBe(false);
    expect(letter.classList.contains("text-crystal")).toBe(true);
    expect(letter.classList.contains("text-spring-green")).toBe(false);
  });

  it("keeps a confirmed pick in crystal on revisit", () => {
    fireEvent.click(optionParts("Doing").button);
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    // Let the pulse finish: the answer records and the card advances to q2.
    // Block body: a void callback picks the sync `act` overload, not the Promise one.
    act(() => {
      vi.advanceTimersByTime(750);
    });
    expect(screen.getByText("How much time per day?")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Previous question" }));

    const { button, letter } = optionParts("Doing");
    expect(button.classList.contains("border-crystal")).toBe(true);
    expect(button.classList.contains("border-spring-green")).toBe(false);
    expect(letter.classList.contains("text-crystal")).toBe(true);
    expect(letter.classList.contains("text-spring-green")).toBe(false);
  });
});
