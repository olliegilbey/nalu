/**
 * Shared fixture for the WaveSession tests, which mock `useWaveState`.
 *
 * Test-only module: never imported by production code.
 */

import { vi } from "vitest";
import type { UseWaveStateResult } from "@/hooks/useWaveState";

/** A `useWaveState` result for an open Wave on turn 1 of 10; tests override single fields. */
export function waveStateFixture(overrides: Partial<UseWaveStateResult> = {}): UseWaveStateResult {
  return {
    chatEntries: [],
    activeQuestionnaire: null,
    closeResult: null,
    status: "active",
    topic: "T",
    turnsRemaining: 10,
    turnBudget: 10,
    xp: 0,
    xpPulseKey: 0,
    xpGainAmount: 0,
    isPending: false,
    failedTurn: null,
    waveNotFound: false,
    streamingText: "",
    streamingQuestions: null,
    submitChatText: vi.fn(),
    submitQuestionnaireAnswers: vi.fn(),
    ...overrides,
  };
}
