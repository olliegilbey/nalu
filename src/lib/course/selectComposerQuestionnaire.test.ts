import { describe, it, expect } from "vitest";
import { selectComposerQuestionnaire } from "./selectComposerQuestionnaire";
import type { ActiveQuestionnaire, ChoiceQuestion } from "./adaptQuestionnaire";

const q = (id: string): ChoiceQuestion => ({ id, prompt: `${id}?`, options: [] });
const active: ActiveQuestionnaire = {
  kind: "wave",
  questions: [q("q1")],
  questionsKey: "qA",
  persistKey: "nalu:wave:w1:q:qA",
};
const preview = [q("q1")];

describe("selectComposerQuestionnaire", () => {
  it("shows the committed questionnaire with its own buffer key", () => {
    expect(selectComposerQuestionnaire(active, null, preview)).toEqual({
      questions: active.questions,
      persistKey: "nalu:wave:w1:q:qA",
    });
  });

  it("shows a streaming preview with no buffer key once the committed one is dismissed", () => {
    // The committed questionnaire's key must not travel with the next one's preview.
    expect(selectComposerQuestionnaire(active, "qA", preview)).toEqual({ questions: preview });
  });

  it("shows nothing when the committed one is dismissed and nothing streams", () => {
    expect(selectComposerQuestionnaire(active, "qA", null)).toBeNull();
  });

  it("shows a streaming preview when no questionnaire is committed", () => {
    expect(selectComposerQuestionnaire(null, null, preview)).toEqual({ questions: preview });
  });
});
