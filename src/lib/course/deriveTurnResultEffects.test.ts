import { describe, it, expect } from "vitest";
import { deriveTurnResultEffects } from "./deriveTurnResultEffects";
import type { WaveTurnResultData } from "@/lib/types/waveStream";

const midTurn = (
  gradedSignals: Extract<WaveTurnResultData, { kind: "mid-turn" }>["gradedSignals"],
): WaveTurnResultData => ({
  kind: "mid-turn",
  turnsRemaining: 3,
  assistantContent: "Keep going.",
  newQuestionnaire: null,
  gradedSignals,
  totalXp: 0,
});

const closeTurn = (
  overrides: Partial<Extract<WaveTurnResultData, { kind: "close-turn" }>>,
): WaveTurnResultData => ({
  kind: "close-turn",
  closingMessage: "Nice wave.",
  nextWaveId: "wave-2",
  nextWaveNumber: 2,
  completionXpAwarded: 20,
  tierAdvancedTo: null,
  gradedSignals: [],
  totalXp: 0,
  ...overrides,
});

describe("deriveTurnResultEffects", () => {
  it("mid-turn: a typed answer that earned XP sounds on the tick", () => {
    const result = midTurn([
      { kind: "mc-index", questionId: "q1", xpAwarded: 3 },
      { kind: "free-text", questionId: "q2", xpAwarded: 5 },
    ]);
    expect(deriveTurnResultEffects(result)).toEqual({ typedAnswerEarnedXp: true });
  });

  it("mid-turn: MC XP alone stays silent; its pick sounded at confirm", () => {
    const result = midTurn([{ kind: "mc-index", questionId: "q1", xpAwarded: 9 }]);
    expect(deriveTurnResultEffects(result)).toEqual({ typedAnswerEarnedXp: false });
  });

  it("mid-turn: a typed answer that earned no XP stays silent", () => {
    const result = midTurn([{ kind: "free-text", questionId: "q1", xpAwarded: 0 }]);
    expect(deriveTurnResultEffects(result).typedAnswerEarnedXp).toBe(false);
  });

  it("close-turn: carries closeResult and tier-up, and reads the typed answer's XP", () => {
    const result = closeTurn({
      completionXpAwarded: 20,
      tierAdvancedTo: 2,
      gradedSignals: [
        { kind: "free-text", questionId: "q1", xpAwarded: 4 },
        { kind: "mc-index", questionId: "q2", xpAwarded: 7 },
      ],
    });
    expect(deriveTurnResultEffects(result)).toEqual({
      typedAnswerEarnedXp: true,
      closeResult: {
        closingMessage: "Nice wave.",
        nextWaveNumber: 2,
        completionXpAwarded: 20,
        tierAdvancedTo: 2,
      },
      tierUp: 2,
    });
  });

  it("close-turn: omits tierUp when no tier advanced; completion XP alone is silent", () => {
    const result = closeTurn({ completionXpAwarded: 15, tierAdvancedTo: null });
    const effects = deriveTurnResultEffects(result);
    expect(effects.typedAnswerEarnedXp).toBe(false);
    expect(effects.closeResult).toEqual({
      closingMessage: "Nice wave.",
      nextWaveNumber: 2,
      completionXpAwarded: 15,
      tierAdvancedTo: null,
    });
    expect(effects.tierUp).toBeUndefined();
  });
});
