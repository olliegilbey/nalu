import { describe, it, expect } from "vitest";
import { redactWaveChatLog } from "./redactWaveChatLog";
import { decodeCorrect } from "@/lib/security/obfuscateCorrect";
import { KEY_TO_INDEX } from "./buildLearnerInput";
import type { WaveChatLogEntry } from "@/lib/types/jsonbWaveChatLog";

describe("redactWaveChatLog", () => {
  it("passes user-text entries through unchanged", () => {
    const log: WaveChatLogEntry[] = [{ role: "user", kind: "text", content: "hi" }];
    expect(redactWaveChatLog(log)).toEqual(log);
  });

  it("passes user-answers entries through unchanged", () => {
    const log: WaveChatLogEntry[] = [
      {
        role: "user",
        kind: "answers",
        questionnaireId: "q-1",
        responses: [{ questionId: "qid-a", choice: "A" }],
      },
    ];
    expect(redactWaveChatLog(log)).toEqual(log);
  });

  it("passes assistant-text entries through unchanged", () => {
    const log: WaveChatLogEntry[] = [{ role: "assistant", kind: "text", content: "Welcome." }];
    expect(redactWaveChatLog(log)).toEqual(log);
  });

  it("substitutes correctEnc for MC questions; preserves free-text branch", () => {
    const log: WaveChatLogEntry[] = [
      {
        role: "assistant",
        kind: "text_with_questionnaire",
        questionnaireId: "q-1",
        content: "Try these:",
        questions: [
          {
            id: "qid-mc",
            type: "multiple_choice",
            prompt: "2+2?",
            options: { A: "3", B: "4", C: "5", D: "6" },
            correct: "B",
            freetextRubric: "n/a",
          },
          {
            id: "qid-ft",
            type: "free_text",
            prompt: "Why?",
            freetextRubric: "rubric",
          },
        ],
      },
    ];
    const [entry] = redactWaveChatLog(log);
    if (!entry || entry.role !== "assistant" || entry.kind !== "text_with_questionnaire") {
      throw new Error("expected text_with_questionnaire entry");
    }
    const [mc, ft] = entry.questions;
    if (!mc || mc.type !== "multiple_choice") throw new Error("MC expected");
    if (!ft || ft.type !== "free_text") throw new Error("free_text expected");
    expect("correct" in mc).toBe(false);
    expect(decodeCorrect("qid-mc", mc.correctEnc)).toBe(KEY_TO_INDEX.B);
    expect(ft.prompt).toBe("Why?");
  });

  it("throws if an MC question is missing the correct key", () => {
    const log: WaveChatLogEntry[] = [
      {
        role: "assistant",
        kind: "text_with_questionnaire",
        questionnaireId: "q-1",
        content: "x",
        questions: [
          {
            id: "qid-mc",
            type: "multiple_choice",
            prompt: "?",
            options: { A: "1", B: "2", C: "3", D: "4" },
            // correct: missing
            freetextRubric: "n/a",
          },
        ],
      },
    ];
    expect(() => redactWaveChatLog(log)).toThrow(/correct/);
  });
});
