// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import type { UseWaveStateResult } from "@/hooks/useWaveState";
import type { ActiveQuestionnaire, ChoiceQuestion } from "@/lib/course/adaptQuestionnaire";
import { installMemoryStorage } from "@/lib/testing/memoryStorage";

/*
 * Regression coverage for issue #118. A Wave's questionnaires reuse raw ids
 * (q1..q3). While questionnaire B streams in as a preview, A is still the
 * committed one. The preview must not restore A's answer buffer into B.
 *
 * Renders the real WaveSession and Composer. `useWaveState` is mocked so the
 * test can step through: A open, B streaming, B committed.
 */

vi.mock("./ChatShell", () => ({
  ChatShell: ({ children, composer }: { children: React.ReactNode; composer: React.ReactNode }) => (
    <div>
      {children}
      {composer}
    </div>
  ),
}));
vi.mock("./MessageBubble", () => ({ MessageBubble: () => null, TypingBubble: () => null }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
// Confirming an MC plays a sound; WebAudio is absent in jsdom.
vi.mock("@/lib/sound", () => ({ playWrong: vi.fn(), playCorrect: vi.fn() }));

const wave = vi.hoisted(() => ({ value: {} as UseWaveStateResult }));
vi.mock("@/hooks/useWaveState", () => ({ useWaveState: () => wave.value }));

import { WaveSession } from "./WaveSession";
import { waveStateFixture } from "./WaveSession.fixtures";

/** Three MC questions with ids q1..q3, labelled by questionnaire. */
function questionsFor(label: string): ChoiceQuestion[] {
  return [1, 2, 3].map((n) => ({
    id: `q${n}`,
    prompt: `${label}${n} prompt`,
    options: ["w", "x", "y", "z"].map((o) => `${label}${n}-${o}`),
  }));
}
const qsA = questionsFor("A");
const qsB = questionsFor("B");

/** A committed Wave questionnaire, as `deriveActiveQuestionnaire` builds it. */
function committed(id: string, questions: ChoiceQuestion[]): ActiveQuestionnaire {
  return { kind: "wave", questions, questionsKey: id, persistKey: `nalu:wave:w1:q:${id}` };
}

const submit = vi.fn();

/** A `useWaveState` result for an open Wave; tests override the questionnaire fields. */
function waveState(overrides: Partial<UseWaveStateResult>): UseWaveStateResult {
  return waveStateFixture({ submitQuestionnaireAnswers: submit, ...overrides });
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

beforeEach(() => {
  vi.useFakeTimers();
  // A working, empty Storage per test: the buffer restore needs one.
  installMemoryStorage();
  submit.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WaveSession questionnaire swap (issue #118)", () => {
  it("opens questionnaire B blank when it reuses A's question ids", () => {
    wave.value = waveState({ activeQuestionnaire: committed("qA", qsA) });
    const { rerender } = render(<WaveSession courseId="c1" waveNumber={1} />);
    confirmOption("A1-w");
    confirmOption("A2-w");
    confirmOption("A3-w");
    expect(submit).toHaveBeenCalledTimes(1);

    // The next turn streams B as a preview. A is still the committed one.
    wave.value = waveState({
      activeQuestionnaire: committed("qA", qsA),
      isPending: true,
      streamingQuestions: qsB,
    });
    rerender(<WaveSession courseId="c1" waveNumber={1} />);
    // Even the preview must not show A's answers.
    expect(screen.queryByText("B1 prompt")).not.toBeNull();
    // The turn lands, and the refetch commits B.
    wave.value = waveState({ activeQuestionnaire: committed("qB", qsB) });
    rerender(<WaveSession courseId="c1" waveNumber={1} />);

    // B opens at its first question, with nothing carried over from A.
    expect(screen.queryByText("B1 prompt")).not.toBeNull();
    confirmOption("B1-x");
    confirmOption("B2-x");
    confirmOption("B3-x");
    expect(submit).toHaveBeenLastCalledWith(
      [
        { id: "q1", kind: "mc", selected: "B" },
        { id: "q2", kind: "mc", selected: "B" },
        { id: "q3", kind: "mc", selected: "B" },
      ],
      expect.anything(),
    );
  });

  it("keeps a keyless preview read-only, so its commit wipes no draft", () => {
    // A Wave's first questionnaire: nothing committed yet, B streams in.
    wave.value = waveState({ isPending: true, streamingQuestions: qsB });
    const { rerender } = render(<WaveSession courseId="c1" waveNumber={1} />);
    const textbox = () => screen.getByRole("textbox") as HTMLTextAreaElement;
    const next = () => screen.getByRole("button", { name: "Next question" }) as HTMLButtonElement;

    // The commit brings B's key and re-inits the card, so a preview draft
    // would be lost. jsdom's fireEvent ignores readOnly; a browser does not.
    expect(textbox().readOnly).toBe(true);
    expect(next().disabled).toBe(true);

    wave.value = waveState({ activeQuestionnaire: committed("qB", qsB) });
    rerender(<WaveSession courseId="c1" waveNumber={1} />);

    expect(textbox().readOnly).toBe(false);
    expect(next().disabled).toBe(false);
    fireEvent.change(textbox(), { target: { value: "draft" } });
    expect(textbox().value).toBe("draft");
  });

  it("restores A's buffer when the turn fails after B's preview showed", () => {
    wave.value = waveState({ activeQuestionnaire: committed("qA", qsA) });
    const { rerender } = render(<WaveSession courseId="c1" waveNumber={1} />);
    confirmOption("A1-w");
    confirmOption("A2-w");
    confirmOption("A3-w");

    wave.value = waveState({
      activeQuestionnaire: committed("qA", qsA),
      isPending: true,
      streamingQuestions: qsB,
    });
    rerender(<WaveSession courseId="c1" waveNumber={1} />);
    // The stream fails: useWaveState runs the submit's onError and drops the preview.
    const opts = submit.mock.calls[0]![1] as { readonly onError: () => void };
    act(() => opts.onError());
    wave.value = waveState({ activeQuestionnaire: committed("qA", qsA) });
    rerender(<WaveSession courseId="c1" waveNumber={1} />);

    // A's buffer comes back minus the final answer: only A3 is left to redo.
    expect(screen.queryByText("A3 prompt")).not.toBeNull();
    confirmOption("A3-w");
    expect(submit).toHaveBeenLastCalledWith(
      [
        { id: "q1", kind: "mc", selected: "A" },
        { id: "q2", kind: "mc", selected: "A" },
        { id: "q3", kind: "mc", selected: "A" },
      ],
      expect.anything(),
    );
  });
});
