import { describe, expect, it } from "vitest";
import { decodeCorrect } from "@/lib/security/obfuscateCorrect";
import { KEY_TO_INDEX, type OpenQuestionnaireRecord } from "./buildLearnerInput";
import { redactQuestionnaire } from "./redactQuestionnaire";

/**
 * Unit tests for `redactQuestionnaire`. Pure function — no DB, no network.
 *
 * Coverage:
 *   1. MC question → drops `correct`, emits `correctEnc` that decodes back
 *      to the right index when paired with the same questionId.
 *   2. Free-text question → no `options`/`correctEnc`; `freetextRubric` preserved.
 *   3. Mixed questionnaire → both branches coexist; ordering preserved.
 *   4. Defensive: MC question without `correct` throws (invariant violation).
 *   5. Defensive: MC question without `options` throws.
 */

describe("redactQuestionnaire", () => {
  it("MC question: correct dropped, correctEnc round-trips", () => {
    const open: OpenQuestionnaireRecord = {
      questionnaireId: "q-msg-1",
      questions: [
        {
          id: "q1",
          type: "multiple_choice",
          prompt: "Pick the rule",
          options: { A: "alpha", B: "beta", C: "gamma", D: "delta" },
          correct: "C",
          freetextRubric: "rubric-mc",
        },
      ],
    };

    const out = redactQuestionnaire(open);

    expect(out.questionnaireId).toBe("q-msg-1");
    expect(out.questions).toHaveLength(1);
    const q = out.questions[0]!;
    expect(q.type).toBe("multiple_choice");
    // Plaintext `correct` must be absent on the wire shape.
    expect(q).not.toHaveProperty("correct");
    // The encoded blob decodes only when bound to the same questionId.
    if (q.type !== "multiple_choice") throw new Error("type narrow");
    expect(q.options).toEqual({ A: "alpha", B: "beta", C: "gamma", D: "delta" });
    expect(decodeCorrect("q1", q.correctEnc)).toBe(KEY_TO_INDEX.C);
    // Replay across questionIds must fail (binding holds).
    expect(decodeCorrect("q2", q.correctEnc)).toBeNull();
    expect(q.freetextRubric).toBe("rubric-mc");
  });

  it("free-text question: no options/correctEnc, rubric preserved", () => {
    const open: OpenQuestionnaireRecord = {
      questionnaireId: "q-msg-2",
      questions: [
        {
          id: "qft",
          type: "free_text",
          prompt: "Explain it",
          freetextRubric: "ft-rubric",
        },
      ],
    };

    const out = redactQuestionnaire(open);

    expect(out.questions).toHaveLength(1);
    const q = out.questions[0]!;
    expect(q.type).toBe("free_text");
    expect(q).not.toHaveProperty("options");
    expect(q).not.toHaveProperty("correctEnc");
    expect(q.freetextRubric).toBe("ft-rubric");
  });

  it("mixed MC + free-text: ordering preserved, per-branch shape intact", () => {
    const open: OpenQuestionnaireRecord = {
      questionnaireId: "q-mixed",
      questions: [
        {
          id: "qmc",
          type: "multiple_choice",
          prompt: "?",
          options: { A: "a", B: "b", C: "c", D: "d" },
          correct: "A",
          freetextRubric: "rmc",
        },
        {
          id: "qft",
          type: "free_text",
          prompt: "Why?",
          freetextRubric: "rft",
        },
      ],
    };

    const out = redactQuestionnaire(open);

    // Ordering: MC first, free-text second, matching input.
    expect(out.questions.map((q) => q.id)).toEqual(["qmc", "qft"]);
    expect(out.questions[0]!.type).toBe("multiple_choice");
    expect(out.questions[1]!.type).toBe("free_text");
  });

  it("throws when an MC question is missing `correct`", () => {
    const open: OpenQuestionnaireRecord = {
      questionnaireId: "q-bad",
      questions: [
        {
          id: "qmc",
          type: "multiple_choice",
          prompt: "?",
          options: { A: "a", B: "b", C: "c", D: "d" },
          // intentionally omit `correct`
          freetextRubric: "r",
        },
      ],
    };
    expect(() => redactQuestionnaire(open)).toThrow(/missing correct/);
  });

  it("throws when an MC question is missing `options`", () => {
    const open: OpenQuestionnaireRecord = {
      questionnaireId: "q-bad-opts",
      questions: [
        {
          id: "qmc",
          type: "multiple_choice",
          prompt: "?",
          correct: "A",
          freetextRubric: "r",
        },
      ],
    };
    expect(() => redactQuestionnaire(open)).toThrow(/missing options/);
  });
});
