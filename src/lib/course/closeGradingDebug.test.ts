import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/db/queries/waves", () => ({ getWaveChatLog: vi.fn() }));
vi.mock("@/db/queries/contextMessages", () => ({ getMessagesForWave: vi.fn() }));

import { getMessagesForWave } from "@/db/queries/contextMessages";
import { getWaveChatLog } from "@/db/queries/waves";
import { logScopingCloseGradings, logWaveCloseGradings } from "./closeGradingDebug";

/** stderr writes captured per test. */
const written: string[] = [];

beforeEach(() => {
  written.length = 0;
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    written.push(String(chunk));
    return true;
  });
  vi.mocked(getWaveChatLog).mockReset();
  vi.mocked(getMessagesForWave).mockReset();
  vi.stubEnv("LLM_DEBUG_GRADINGS", "1");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const mcGrading = { kind: "mc-index", questionId: "q1", rationale: "r" } as const;

describe("logWaveCloseGradings", () => {
  it("is a true no-op with the flag off: no reads, no writes", async () => {
    vi.stubEnv("LLM_DEBUG_GRADINGS", undefined);
    await logWaveCloseGradings({
      waveId: "w1",
      openQuestionnaireId: "qn1",
      questionIds: ["q1"],
      gradings: [mcGrading],
    });
    expect(getWaveChatLog).not.toHaveBeenCalled();
    expect(written).toEqual([]);
  });

  it("joins each grading to the live chat_log Response", async () => {
    vi.mocked(getWaveChatLog).mockResolvedValue([
      {
        role: "user",
        kind: "answers",
        questionnaireId: "qn1",
        responses: [{ questionId: "q1", freetext: "prose answer" }],
      },
    ]);
    await logWaveCloseGradings({
      waveId: "w1",
      openQuestionnaireId: "qn1",
      questionIds: ["q1"],
      gradings: [mcGrading],
    });
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("responseKind=freetext");
    expect(written[0]).toContain("KIND-MISMATCH");
  });

  it("does not throw when the debug read fails; writes one explicit line", async () => {
    vi.mocked(getWaveChatLog).mockRejectedValue(new Error("db down"));
    await expect(
      logWaveCloseGradings({
        waveId: "w1",
        openQuestionnaireId: "qn1",
        questionIds: ["q1"],
        gradings: [mcGrading],
      }),
    ).resolves.toBeUndefined();
    expect(written).toEqual([
      "[grading-debug] wave-close: debug logging failed, close continues: db down\n",
    ]);
  });

  it("names the gradings the empty-idSet strip discarded, from the raw response", async () => {
    vi.mocked(getMessagesForWave).mockResolvedValue([
      { kind: "assistant_response", content: JSON.stringify({ gradings: [mcGrading] }) },
    ] as never);
    await logWaveCloseGradings({
      waveId: "w1",
      openQuestionnaireId: undefined,
      questionIds: [],
      gradings: [],
    });
    expect(written).toHaveLength(1);
    expect(written[0]).toContain("strip: idSet empty, discarding 1 grading(s): [q1(mc-index)]");
  });

  it("stays quiet on the strip path when nothing was discarded", async () => {
    vi.mocked(getMessagesForWave).mockResolvedValue([
      { kind: "assistant_response", content: JSON.stringify({ gradings: [] }) },
    ] as never);
    await logWaveCloseGradings({
      waveId: "w1",
      openQuestionnaireId: undefined,
      questionIds: [],
      gradings: [],
    });
    expect(written).toEqual([]);
  });
});

describe("logScopingCloseGradings", () => {
  it("does not throw when formatting fails; writes one explicit line", () => {
    // An out-of-range tier makes calculateXP throw inside the formatter.
    expect(() =>
      logScopingCloseGradings({
        gradings: [
          {
            kind: "free-text",
            questionId: "q1",
            verdict: "correct",
            qualityScore: 4,
            conceptName: "c",
            conceptTier: 1,
            rationale: "r",
          },
        ],
        responses: [{ questionId: "q1", freetext: "answer" }],
        startingTier: 0,
      }),
    ).not.toThrow();
    expect(written).toHaveLength(1);
    expect(written[0]).toMatch(/^\[grading-debug\] scoping-close: debug logging failed/);
  });
});
