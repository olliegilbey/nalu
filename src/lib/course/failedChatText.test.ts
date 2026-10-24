import { describe, it, expect } from "vitest";
import {
  composerTextAfterFailure,
  composerTextAfterRetry,
  resendsFailedTurn,
} from "./failedChatText";
import type { SubmitTurnPayload } from "@/lib/types/waveTurnInput";

const failed: SubmitTurnPayload = { kind: "chat-text", text: "why?" };
const answers: SubmitTurnPayload = {
  kind: "questionnaire-answers",
  questionnaireId: "q-1",
  answers: [{ id: "q1", kind: "mc", selected: "B" }],
};

describe("composerTextAfterFailure", () => {
  it("puts the sent text back into an empty Composer", () => {
    expect(composerTextAfterFailure("", "why?")).toBe("why?");
    expect(composerTextAfterFailure("  ", "why?")).toBe("why?");
  });

  it("keeps text the learner typed while the Turn ran", () => {
    expect(composerTextAfterFailure("and also", "why?")).toBe("and also");
  });
});

describe("resendsFailedTurn", () => {
  it("is true for the failed Turn's exact text", () => {
    expect(resendsFailedTurn(failed, "why?")).toBe(true);
  });

  it("is false for edited text, a failed answers Turn, or no failure", () => {
    expect(resendsFailedTurn(failed, "why not?")).toBe(false);
    expect(resendsFailedTurn(answers, "why?")).toBe(false);
    expect(resendsFailedTurn(null, "why?")).toBe(false);
  });
});

describe("composerTextAfterRetry", () => {
  it("empties a Composer holding the re-sent text", () => {
    expect(composerTextAfterRetry("why?", failed)).toBe("");
    expect(composerTextAfterRetry("why? ", failed)).toBe("");
  });

  it("keeps anything else the learner typed", () => {
    expect(composerTextAfterRetry("why not?", failed)).toBe("why not?");
    expect(composerTextAfterRetry("why?", answers)).toBe("why?");
  });
});
