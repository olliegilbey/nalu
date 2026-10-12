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
  ...overrides,
});

describe("deriveTurnResultEffects", () => {
  it("mid-turn: sums free-text XP and skips mc-index signals", () => {
    const result = midTurn([
      { kind: "free-text", questionId: "q1", xpAwarded: 5 },
      { kind: "mc-index", questionId: "q2", xpAwarded: 3 },
      { kind: "free-text", questionId: "q3", xpAwarded: 2 },
    ]);
    expect(deriveTurnResultEffects(result)).toEqual({ xpGain: 7 });
  });

  it("mid-turn: xpGain is 0 when there are no free-text signals", () => {
    const result = midTurn([{ kind: "mc-index", questionId: "q1", xpAwarded: 9 }]);
    expect(deriveTurnResultEffects(result)).toEqual({ xpGain: 0 });
  });

  it("close-turn: folds completion + free-text XP, carries closeResult and tier-up", () => {
    const result = closeTurn({
      completionXpAwarded: 20,
      tierAdvancedTo: 2,
      gradedSignals: [
        { kind: "free-text", questionId: "q1", xpAwarded: 4 },
        { kind: "mc-index", questionId: "q2", xpAwarded: 7 },
      ],
    });
    expect(deriveTurnResultEffects(result)).toEqual({
      xpGain: 24,
      closeResult: {
        closingMessage: "Nice wave.",
        nextWaveNumber: 2,
        completionXpAwarded: 20,
        tierAdvancedTo: 2,
      },
      tierUp: 2,
    });
  });

  it("close-turn: omits tierUp when no tier advanced", () => {
    const result = closeTurn({ completionXpAwarded: 15, tierAdvancedTo: null });
    const effects = deriveTurnResultEffects(result);
    expect(effects.xpGain).toBe(15);
    expect(effects.closeResult).toEqual({
      closingMessage: "Nice wave.",
      nextWaveNumber: 2,
      completionXpAwarded: 15,
      tierAdvancedTo: null,
    });
    expect(effects.tierUp).toBeUndefined();
  });
});
