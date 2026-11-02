// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { playCorrect, playWrong } from "@/lib/sound";
import { installMemoryStorage } from "@/lib/testing/memoryStorage";
import { Composer, type ChoiceQuestion } from "./Composer";

/*
 * The Composer's answer sounds. One sound per answer: a correct MC pick
 * plays `playCorrect` at confirm, and that is its only sound. The Composer
 * awards no XP: the header badge shows the server total. A typed answer has
 * no click, so the Composer plays nothing for it; its sound comes with the
 * badge's tick once the server grades it.
 */

// WebAudio is not under test: spy on the two answer sounds.
vi.mock("@/lib/sound", () => ({ playCorrect: vi.fn(), playWrong: vi.fn() }));

const noop = () => {};

const capital: ChoiceQuestion = {
  id: "q1",
  prompt: "Capital of France?",
  options: ["Paris", "Lyon", "Nice", "Lille"],
  correctIndex: 0,
};

/** A one-question card. */
function renderCard() {
  render(
    <Composer
      value=""
      onChange={noop}
      onSend={noop}
      questions={[capital]}
      persistKey="nalu:wave:w1:q:a"
      onComplete={noop}
    />,
  );
}

/** Pick an option and confirm it. */
function confirmOption(label: string) {
  fireEvent.click(screen.getByText(label).closest("button")!);
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
}

beforeEach(() => {
  vi.useFakeTimers();
  // A working, empty Storage per test: the buffer restore needs one.
  installMemoryStorage();
  vi.mocked(playCorrect).mockClear();
  vi.mocked(playWrong).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Composer answer sounds", () => {
  it("a correct confirm plays the correct sound", () => {
    renderCard();
    confirmOption("Paris");
    expect(playCorrect).toHaveBeenCalledTimes(1);
    expect(playWrong).not.toHaveBeenCalled();
  });

  it("a wrong confirm plays the wrong sound", () => {
    renderCard();
    confirmOption("Lyon");
    expect(playWrong).toHaveBeenCalledTimes(1);
    expect(playCorrect).not.toHaveBeenCalled();
  });

  it("a typed answer plays nothing at the Composer", () => {
    // Even verbatim option text: the badge's tick owns a typed answer's sound.
    renderCard();
    const box = screen.getByRole("textbox");
    fireEvent.change(box, { target: { value: "Paris" } });
    fireEvent.keyDown(box, { key: "Enter" });
    // Block body: a void callback picks the sync `act` overload.
    act(() => {
      vi.advanceTimersByTime(750);
    });
    expect(playCorrect).not.toHaveBeenCalled();
    expect(playWrong).not.toHaveBeenCalled();
  });
});
