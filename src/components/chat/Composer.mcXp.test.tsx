// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { calculateMcXp } from "@/lib/scoring/xp";
import { installMemoryStorage } from "@/lib/testing/memoryStorage";
import { Composer, type ChoiceQuestion } from "./Composer";

/*
 * MC XP display award. The Composer awards a correct MC answer's XP at answer
 * time, and the turn result skips `mc-index` XP. So the Composer must award
 * each correct MC answer exactly once, or the header badge drifts from the
 * server's total.
 *
 * The harness mirrors WaveSession and Onboarding. `onComplete` hides the card,
 * as the submit starts. "Fail submit" re-shows it, as the submit's onError
 * does. The Composer then restores its buffer, minus the final answer.
 */

const noop = () => {};

const capital: ChoiceQuestion = {
  id: "q1",
  prompt: "Capital of France?",
  options: ["Paris", "Lyon", "Nice", "Lille"],
  correctIndex: 0,
  tier: 2,
};
const capitalXp = calculateMcXp(2, true);

const italy: ChoiceQuestion = {
  id: "q2",
  prompt: "Capital of Italy?",
  options: ["Milan", "Rome", "Turin", "Naples"],
  correctIndex: 1,
  tier: 1,
};

/** A question card whose submit the test can fail. One question by default. */
function Harness({
  persistKey,
  onCorrectAnswer,
  questions = [capital],
}: {
  readonly persistKey: string;
  readonly onCorrectAnswer: (amount: number) => void;
  readonly questions?: ChoiceQuestion[];
}) {
  // Same dismiss model as WaveSession: hide the submitted card by key.
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  return (
    <>
      <Composer
        value=""
        onChange={noop}
        onSend={noop}
        questions={persistKey === dismissedKey ? null : questions}
        persistKey={persistKey}
        onCorrectAnswer={onCorrectAnswer}
        onComplete={() => setDismissedKey(persistKey)}
      />
      <button onClick={() => setDismissedKey(null)}>Fail submit</button>
    </>
  );
}

/** Pick an option, confirm it, and let the 750ms pulse finish. */
function confirmOption(label: string) {
  fireEvent.click(screen.getByText(label).closest("button")!);
  fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  // Block body: a void callback picks the sync `act` overload, not the Promise one.
  act(() => {
    vi.advanceTimersByTime(750);
  });
}

/** Type an answer into the textarea and press Enter. */
function typeAnswer(text: string) {
  const box = screen.getByRole("textbox");
  fireEvent.change(box, { target: { value: text } });
  fireEvent.keyDown(box, { key: "Enter" });
}

beforeEach(() => {
  vi.useFakeTimers();
  // A working, empty Storage per test: the buffer restore needs one.
  installMemoryStorage();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Composer MC XP award", () => {
  it("awards a confirmed final MC once across a failed submit and retry (#21)", () => {
    const award = vi.fn();
    render(<Harness persistKey="nalu:wave:w1:q:a" onCorrectAnswer={award} />);

    confirmOption("Paris");
    fireEvent.click(screen.getByText("Fail submit"));
    // The restored buffer drops the final answer, so the learner confirms again.
    confirmOption("Paris");

    expect(award).toHaveBeenCalledTimes(1);
    expect(award).toHaveBeenCalledWith(capitalXp);
  });

  it("awards a new questionnaire that reuses the same question ids", () => {
    const award = vi.fn();
    const { rerender } = render(<Harness persistKey="nalu:wave:w1:q:a" onCorrectAnswer={award} />);
    confirmOption("Paris");

    // A Wave's next questionnaire often restarts at q1. Its persistKey differs.
    rerender(<Harness persistKey="nalu:wave:w1:q:b" onCorrectAnswer={award} />);
    confirmOption("Paris");

    expect(award).toHaveBeenCalledTimes(2);
  });

  it("awards each correct question on a two-question card", () => {
    const award = vi.fn();
    render(
      <Harness
        persistKey="nalu:wave:w1:q:a"
        onCorrectAnswer={award}
        questions={[capital, italy]}
      />,
    );

    // The key carries the question id, so q2 is not mistaken for q1.
    confirmOption("Paris");
    confirmOption("Rome");

    expect(award.mock.calls).toEqual([[capitalXp], [calculateMcXp(1, true)]]);
  });

  it("awards a correct MC answered by typing its option text (#18)", () => {
    const award = vi.fn();
    render(<Harness persistKey="nalu:wave:w1:q:a" onCorrectAnswer={award} />);

    // Verbatim option text ships as an MC answer; the server grades it as one.
    typeAnswer("Paris");

    expect(award).toHaveBeenCalledTimes(1);
    expect(award).toHaveBeenCalledWith(capitalXp);
  });

  // "Lyon" ships as a wrong MC answer. "paris" is not verbatim, so it ships as
  // free text, and the turn result counts its XP instead.
  it.each(["Lyon", "paris"])("awards nothing for the typed answer %s", (text) => {
    const award = vi.fn();
    render(<Harness persistKey="nalu:wave:w1:q:a" onCorrectAnswer={award} />);

    typeAnswer(text);

    expect(award).not.toHaveBeenCalled();
  });

  it("awards a typed final MC once across a failed submit and retry", () => {
    const award = vi.fn();
    render(<Harness persistKey="nalu:wave:w1:q:a" onCorrectAnswer={award} />);

    typeAnswer("Paris");
    fireEvent.click(screen.getByText("Fail submit"));
    typeAnswer("Paris");

    expect(award).toHaveBeenCalledTimes(1);
  });
});
