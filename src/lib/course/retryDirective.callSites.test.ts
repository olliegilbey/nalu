import { describe, it, expect, vi, beforeEach } from "vitest";
import { NoObjectGeneratedError } from "ai";
import { ValidationGateFailure } from "@/lib/turn/validationGateFailure";
import { toSchemaJsonString } from "@/lib/llm/toCerebrasJsonSchema";
import { clarifySchema } from "@/lib/prompts/clarify";
import { makeWaveCloseSchema } from "@/lib/prompts/waveClose";
import type { Course, Wave } from "@/db/schema";
import { clarify } from "./clarify";
import { executeWaveClose } from "./executeWaveClose";

/**
 * Byte-identity guard for the retry directive at real call sites (issue #105).
 *
 * The directive persists as a `harness_retry_directive` row, and the model
 * reads it on the next attempt. Each test drives a call site through the
 * real `executeTurn`, fails every Step, and pins the persisted directive to
 * an exact string: fixed prose plus the call site's wire schema body.
 * The schema body comes from `toSchemaJsonString`, so a `.describe()` edit
 * does not churn this test; a change to the prose or the schema choice does.
 */

// LLM boundary: every Step fails structured output (set per test).
vi.mock("@/lib/llm/generate", () => ({ generateChat: vi.fn() }));
// Context rows: start empty, capture the persisted batch.
vi.mock("@/db/queries/contextMessages", () => ({
  appendMessages: vi.fn(),
  getMessagesForWave: vi.fn(),
  getMessagesForScopingPass: vi.fn(),
  getNextTurnIndex: vi.fn(),
}));
// Rendering has its own tests; the directive bytes come from the batch rows.
vi.mock("@/lib/llm/renderContext", () => ({
  renderContext: vi.fn(() => ({ system: "SYS", messages: [] })),
}));
// clarify's DB + operator ping.
vi.mock("@/db/queries/courses", () => ({
  createCourse: vi.fn(),
  updateCourseScopingState: vi.fn(),
}));
vi.mock("@/db/queries/scopingPasses", () => ({ ensureOpenScopingPass: vi.fn() }));
vi.mock("@/lib/notify/ntfy", () => ({ notifyEvent: vi.fn() }));
// executeWaveClose's concept reads (the scheduler calls these too).
vi.mock("@/db/queries/concepts", () => ({
  getConceptsByCourse: vi.fn(),
  getDueConceptsByCourse: vi.fn(),
}));

import { generateChat } from "@/lib/llm/generate";
import {
  appendMessages,
  getMessagesForScopingPass,
  getMessagesForWave,
  getNextTurnIndex,
} from "@/db/queries/contextMessages";
import { createCourse } from "@/db/queries/courses";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import { getConceptsByCourse, getDueConceptsByCourse } from "@/db/queries/concepts";

/** Full LanguageModelUsage shape; the detail sub-objects are required. */
const FAKE_USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
};

/** The error `generateChat` throws when the response fails parse or validation. */
function noObjectError(text: string): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
    message: "No object generated: response did not match schema.",
    text,
    response: { id: "test", timestamp: new Date(0), modelId: "mock" },
    usage: FAKE_USAGE,
    finishReason: "stop",
  });
}

/** Content of the first `harness_retry_directive` row in the persisted batch. */
function firstPersistedDirective(): string {
  const batch = vi.mocked(appendMessages).mock.calls[0]![0];
  const row = batch.find((b) => b.kind === "harness_retry_directive");
  if (!row) throw new Error("no harness_retry_directive row persisted");
  return row.content;
}

const FRAMEWORK = {
  userMessage: "fw",
  estimatedStartingTier: 1,
  baselineScopeTiers: [1, 2],
  tiers: [
    { number: 1, name: "Basics", description: "Intro", exampleConcepts: ["a"] },
    { number: 2, name: "Borrowing", description: "Refs", exampleConcepts: ["b"] },
  ],
};

beforeEach(() => {
  vi.mocked(generateChat).mockReset();
  vi.mocked(appendMessages).mockReset().mockResolvedValue([]);
  vi.mocked(getMessagesForScopingPass).mockReset().mockResolvedValue([]);
  vi.mocked(getMessagesForWave).mockReset().mockResolvedValue([]);
  vi.mocked(getNextTurnIndex).mockReset().mockResolvedValue(0);
});

describe("retry directive bytes at call sites", () => {
  it("clarify: a Zod failure yields the issue bullets plus the clarify schema", async () => {
    vi.mocked(createCourse).mockResolvedValue({
      id: "c1",
      topic: "Rust",
      clarification: null,
    } as unknown as Course);
    vi.mocked(ensureOpenScopingPass).mockResolvedValue({ id: "p1" } as never);
    // Valid JSON, wrong shape: `questions` is missing.
    vi.mocked(generateChat).mockRejectedValue(noObjectError('{"userMessage":"hi"}'));

    await expect(clarify({ userId: "u1", topic: "Rust" })).rejects.toBeInstanceOf(
      ValidationGateFailure,
    );

    const schemaJson = toSchemaJsonString(clarifySchema, { name: "clarify" });
    expect(firstPersistedDirective()).toBe(
      [
        "Your previous response did not match the required JSON schema.",
        "The decoded JSON had these issues, listed by field path:",
        "- field questions: Invalid input: expected object, received undefined",
        "",
        "Here is the schema your reply must match. Emit exactly one JSON object matching this schema, with no surrounding prose:",
        `<response_schema>\n${schemaJson}\n</response_schema>`,
      ].join("\n"),
    );
  });

  it("executeWaveClose: a JSON-parse failure yields the prose plus the wave_close schema", async () => {
    vi.mocked(getConceptsByCourse).mockResolvedValue([]);
    vi.mocked(getDueConceptsByCourse).mockResolvedValue([]);
    // Only the fields executeWaveClose and buildWaveSeed read.
    const course = { id: "c1", topic: "Rust", clarification: null, summary: "s" };
    const wave = {
      id: "w1",
      tier: 1,
      frameworkSnapshot: FRAMEWORK,
      chatLog: [],
      customInstructionsSnapshot: null,
      dueConceptsSnapshot: [],
      seedSource: { kind: "scoping_handoff" },
    };
    vi.mocked(generateChat).mockRejectedValue(noObjectError("not json at all"));

    await expect(
      executeWaveClose(
        { course: course as unknown as Course, wave: wave as unknown as Wave },
        "bye",
      ),
    ).rejects.toBeInstanceOf(ValidationGateFailure);

    // Same inputs executeWaveClose derives from the mocks above.
    const schema = makeWaveCloseSchema({
      scopeTiers: [1, 2],
      questionIds: [],
      freshConceptNames: [],
      reviewDueNames: [],
      existingConceptNames: [],
    });
    const schemaJson = toSchemaJsonString(schema, { name: "wave_close" });
    expect(firstPersistedDirective()).toBe(
      [
        "Your previous response did not parse as JSON. Reply with a single JSON object — no prose, no Markdown fences, no leading commentary.",
        "",
        "Here is the schema your reply must match. Emit exactly one JSON object matching this schema:",
        `<response_schema>\n${schemaJson}\n</response_schema>`,
      ].join("\n"),
    );
  });
});
