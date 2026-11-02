/**
 * Integration tests for the course scoping router (course.ts).
 *
 * WHY integration (not unit): we want to assert on real DB row trails so we
 * know the persistence contracts hold end-to-end through tRPC → lib → DB.
 * The only mock surface is `generateChat` — the LLM boundary. Everything
 * else (executeTurn, DB queries, parsers) is real.
 *
 * Harness: `withTestDb` — auto-truncates all tables before each call.
 * The testcontainer + migrations are set up once by `setup.ts` (setupFiles).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { expectNoPlaintextAnswerKey } from "@/lib/testing/expectNoPlaintextAnswerKey";
import { NoObjectGeneratedError } from "ai";
import { withTestDb } from "@/db/testing/withTestDb";
import { appRouter } from "./index";
import { userProfiles, contextMessages, courses, scopingPasses } from "@/db/schema";
import { asc } from "drizzle-orm";
import { getCourseById } from "@/db/queries/courses";
import { updateCourseScopingState } from "@/db/queries/courses.scoping";
import { createCourse } from "@/db/queries/courses";
import { appendMessages } from "@/db/queries/contextMessages.writes";
import {
  clarificationJsonbSchema,
  frameworkJsonbSchema,
  baselineJsonbSchema,
} from "@/lib/types/jsonb";
import { decodeCorrect } from "@/lib/security/obfuscateCorrect";
import { KEY_TO_INDEX } from "@/lib/types/mcOptionKey";

// Mock ONLY the LLM boundary — never executeTurn. Real persistence lets us
// assert on context_messages row trails end-to-end.
vi.mock("@/lib/llm/generate", () => ({ generateChat: vi.fn() }));
import { generateChat } from "@/lib/llm/generate";

// Fixed UUIDs per plan §D7 conventions.
const USER = "55555555-5555-5555-5555-555555555555";
const OTHER_USER = "66666666-6666-6666-6666-666666666666";

/**
 * Full AI SDK v5 `LanguageModelUsage` shape.
 * Sub-objects are required by the LlmUsage type; all zeros because the value
 * does not affect any assertion in these tests.
 */
const FAKE_USAGE = {
  inputTokens: 1,
  outputTokens: 1,
  totalTokens: 2,
  inputTokenDetails: { noCacheTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokenDetails: { textTokens: 0, reasoningTokens: 0 },
} as const;

/**
 * Success-path mock payload mirroring generateChat's Output.object result:
 * `parsed` is derived from the JSON fixture the same way the SDK derives it.
 */
function llmSuccess(text: string) {
  return { text, parsed: JSON.parse(text) as unknown, usage: FAKE_USAGE };
}

/** Builds the error generateChat now throws on parse/validation failure. */
function noObjectError(text: string): NoObjectGeneratedError {
  return new NoObjectGeneratedError({
    message: "No object generated: response did not match schema.",
    text,
    response: { id: "test", timestamp: new Date(0), modelId: "mock" },
    usage: FAKE_USAGE,
    finishReason: "stop",
  });
}

// ---------------------------------------------------------------------------
// LLM response payload fixtures
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid MC question for baseline fixtures.
 * `tier` must be within the framework's baseline_scope_tiers ([1, 2]).
 */
function mcQuestion(id: string, tier: 1 | 2) {
  return {
    id,
    tier,
    conceptName: "test-concept",
    type: "multiple_choice" as const,
    prompt: "Which of the following best describes X?",
    options: { A: "opt-a", B: "opt-b", C: "opt-c", D: "opt-d" },
    correct: "A" as const,
    freetextRubric: "A good answer explains X clearly.",
  };
}

/**
 * Valid clarify LLM response — pure JSON matching clarifySchema.
 * Two questions satisfies the 2–4 constraint; no conceptName/tier (elicitation only).
 */
function validClarifyText(): string {
  return JSON.stringify({
    userMessage: "Let me ask you a couple of questions.",
    questions: {
      questions: [
        {
          id: "q1",
          type: "free_text",
          prompt: "What is your goal with Rust?",
          freetextRubric: "no grading — informational",
        },
        {
          id: "q2",
          type: "free_text",
          prompt: "What is your current programming background?",
          freetextRubric: "no grading — informational",
        },
      ],
    },
  });
}

/**
 * Valid framework half of the merged response — matches frameworkSchema.
 * 3+ tiers (FRAMEWORK.minTiers=3); estimatedStartingTier in scope; baselineScopeTiers contiguous.
 */
function validFramework() {
  return {
    userMessage: "Here is the framework.",
    tiers: [
      {
        number: 1,
        name: "Foundations",
        description: "Core ownership concepts.",
        exampleConcepts: ["borrow checker", "lifetimes", "move semantics", "references"],
      },
      {
        number: 2,
        name: "Intermediate",
        description: "Trait-based abstractions.",
        exampleConcepts: ["traits", "generics", "closures", "iterators"],
      },
      {
        number: 3,
        name: "Advanced",
        description: "Advanced patterns.",
        exampleConcepts: ["unsafe", "FFI", "macros", "async"],
      },
    ],
    estimatedStartingTier: 1,
    // baselineScopeTiers must include estimatedStartingTier and be contiguous.
    baselineScopeTiers: [1, 2],
  };
}

/**
 * Valid baseline half of the merged response — matches baselineSchema (flat questions).
 * Exactly 7 questions (BASELINE.minQuestions=7), all tiers in [1, 2] (the framework's scope).
 */
function validBaseline() {
  return {
    userMessage: "Here is the baseline.",
    questions: [
      mcQuestion("b1", 1),
      mcQuestion("b2", 2),
      mcQuestion("b3", 1),
      mcQuestion("b4", 2),
      mcQuestion("b5", 1),
      mcQuestion("b6", 2),
      mcQuestion("b7", 1),
    ],
  };
}

/** Valid merged LLM response (issue #15) — pure JSON matching frameworkAndBaselineSchema. */
function validFrameworkAndBaselineText(): string {
  return JSON.stringify({ framework: validFramework(), baseline: validBaseline() });
}

// Answers matching the 2 questions emitted by validClarifyText.
// Not `as const` — tRPC input schema expects mutable string[].
const CLARIFY_ANSWERS: string[] = ["Learn systems programming.", "C++ background."];

/**
 * Valid scoping-close LLM response — pure JSON matching `makeCloseTurnBaseSchema`.
 * One grading per baseline question (7 total), all conceptTier in scope ([1, 2]),
 * verdict/qualityScore bands aligned (correct → 5 ∈ [4,5]).
 */
function validScopingCloseText(): string {
  // Question ids must exactly match those emitted by validBaseline.
  const questionIds = ["b1", "b2", "b3", "b4", "b5", "b6", "b7"] as const;
  return JSON.stringify({
    userMessage: "Nice work — your first lesson is ready.",
    gradings: questionIds.map((qid, idx) => ({
      kind: "free-text",
      questionId: qid,
      verdict: "correct",
      qualityScore: 5,
      conceptName: "test-concept",
      // Alternate tier 1/2 so we exercise both scope tiers; both are in scope.
      conceptTier: idx % 2 === 0 ? 1 : 2,
      rationale: "Selected the correct option. Start lesson 1 with a deeper probe.",
    })),
    summary: "Learner shows solid grasp of foundations across the baseline.",
    nextUnitBlueprint: {
      topic: "Ownership basics",
      outline: ["intro to ownership", "moves vs copies", "borrowing rules"],
      openingText: "Welcome — given your C++ background, let's start with how Rust differs.",
      plannedConcepts: [],
    },
  });
}

// ---------------------------------------------------------------------------
// Shared seed helper
// ---------------------------------------------------------------------------

/** Seed the test user inside a withTestDb callback (truncated per call). */
async function seedUser(
  db: Parameters<Parameters<typeof withTestDb>[0]>[0],
  id = USER,
): Promise<void> {
  await db.insert(userProfiles).values({ id, displayName: "Test User" });
}

// ---------------------------------------------------------------------------
// Reset mock before each test
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.mocked(generateChat).mockReset();
});

// ===========================================================================
// clarify
// ===========================================================================

describe("course.clarify", () => {
  // -------------------------------------------------------------------------
  // Case 1: happy path
  // -------------------------------------------------------------------------
  it("happy path: returns questions + courseId, persists 2 context_messages and clarification JSONB", async () => {
    await withTestDb(async (db) => {
      await seedUser(db);
      vi.mocked(generateChat).mockResolvedValueOnce(llmSuccess(validClarifyText()));

      const caller = appRouter.createCaller({ userId: USER });
      const result = await caller.course.clarify({ topic: "Rust" });

      // Router return value — clarification is { userMessage, questions: { questions: [...] } }.
      expect(result.clarification.questions.questions).toHaveLength(2);
      expect(result.nextStage).toBe("frameworkAndBaseline");
      expect(result.courseId).toBeTruthy();

      // DB: context_messages for this scoping pass — 2 rows in order.
      const rows = await db
        .select()
        .from(contextMessages)
        .orderBy(asc(contextMessages.turnIndex), asc(contextMessages.seq));
      expect(rows).toHaveLength(2);
      expect(rows[0]?.kind).toBe("user_message");
      expect(rows[1]?.kind).toBe("assistant_response");
      // Both rows belong to the same scoping pass (scopingPassId non-null).
      expect(rows[0]?.scopingPassId).not.toBeNull();
      expect(rows[0]?.scopingPassId).toBe(rows[1]?.scopingPassId);

      // DB: courses.clarification is populated and valid.
      const course = await getCourseById(result.courseId);
      expect(course.clarification).not.toBeNull();
      // Runtime-validate the stored JSONB shape against the schema.
      const parsed = clarificationJsonbSchema.safeParse(course.clarification);
      expect(parsed.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Case 2: retry-then-success
  // -------------------------------------------------------------------------
  it("retry-then-success: persists 4 rows (user, failed, directive, assistant)", async () => {
    await withTestDb(async (db) => {
      await seedUser(db);

      // First call: not valid JSON → generateChat throws NoObjectGeneratedError
      // → executeTurn converts it to ValidationGateFailure.
      vi.mocked(generateChat)
        .mockRejectedValueOnce(noObjectError("<response>thinking...</response>"))
        .mockResolvedValueOnce(llmSuccess(validClarifyText()));

      const caller = appRouter.createCaller({ userId: USER });
      const result = await caller.course.clarify({ topic: "Rust" });

      expect(result.clarification.questions.questions).toHaveLength(2);

      // DB: 4 rows — user, failed, directive, assistant.
      const rows = await db
        .select()
        .from(contextMessages)
        .orderBy(asc(contextMessages.turnIndex), asc(contextMessages.seq));
      expect(rows).toHaveLength(4);
      expect(rows.map((r) => r.kind)).toEqual([
        "user_message",
        "failed_assistant_response",
        "harness_retry_directive",
        "assistant_response",
      ]);
      // The retry directive must be non-empty (authored by the parser).
      expect(rows[2]?.content).toBeTruthy();
    });
  });

  // -------------------------------------------------------------------------
  // Case 3: terminal exhaust (SCOPING.maxParseRetries=2 → 3 attempts → 6 rows)
  // -------------------------------------------------------------------------
  it("terminal exhaust: rejects with ValidationGateFailure, persists 6 rows, clarification stays null", async () => {
    await withTestDb(async (db) => {
      await seedUser(db);

      // All 3 attempts fail — response is not valid JSON.
      vi.mocked(generateChat).mockRejectedValue(
        noObjectError("<response>still no questions</response>"),
      );

      const caller = appRouter.createCaller({ userId: USER });
      await expect(caller.course.clarify({ topic: "Rust" })).rejects.toThrow();

      // DB: user + [failed, directive] + [failed, directive] + failed = 6 rows.
      // Final attempt has no trailing directive (executeTurn.ts:155-161).
      const rows = await db
        .select()
        .from(contextMessages)
        .orderBy(asc(contextMessages.turnIndex), asc(contextMessages.seq));
      expect(rows).toHaveLength(6);
      expect(rows.map((r) => r.kind)).toEqual([
        "user_message",
        "failed_assistant_response",
        "harness_retry_directive",
        "failed_assistant_response",
        "harness_retry_directive",
        "failed_assistant_response",
      ]);

      // courses.clarification must still be null — lib function never persisted.
      const courseRows = await db.select().from(courses);
      expect(courseRows).toHaveLength(1);
      expect(courseRows[0]?.clarification).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Case 4: UNAUTHORIZED — no userId
  // -------------------------------------------------------------------------
  it("UNAUTHORIZED: rejects with code UNAUTHORIZED when userId is undefined", async () => {
    // Middleware fires before any DB call — no withTestDb body needed.
    const caller = appRouter.createCaller({ userId: undefined });
    await expect(caller.course.clarify({ topic: "Rust" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});

// ===========================================================================
// generateFrameworkAndBaseline
// ===========================================================================

describe("course.generateFrameworkAndBaseline", () => {
  /** The clarify answers, in the procedure's wire shape. */
  const RESPONSES = [
    { questionId: "q1", freetext: CLARIFY_ANSWERS[0]! },
    { questionId: "q2", freetext: CLARIFY_ANSWERS[1]! },
  ];

  /** Run clarify for USER and return its caller and course id. */
  async function clarifyCourse(db: Parameters<Parameters<typeof withTestDb>[0]>[0]) {
    await seedUser(db);
    vi.mocked(generateChat).mockResolvedValueOnce(llmSuccess(validClarifyText()));
    const caller = appRouter.createCaller({ userId: USER });
    const { courseId } = await caller.course.clarify({ topic: "Rust" });
    return { caller, courseId };
  }

  /** Every scoping Context row, in replay order. */
  async function contextRows(db: Parameters<Parameters<typeof withTestDb>[0]>[0]) {
    return db
      .select()
      .from(contextMessages)
      .orderBy(asc(contextMessages.turnIndex), asc(contextMessages.seq));
  }

  // -------------------------------------------------------------------------
  // Case 5: happy path after clarify — one LLM call, both artifacts
  // -------------------------------------------------------------------------
  it("happy path: one LLM call returns and persists the framework and the baseline", async () => {
    await withTestDb(async (db) => {
      const { caller, courseId } = await clarifyCourse(db);
      vi.mocked(generateChat).mockResolvedValueOnce(llmSuccess(validFrameworkAndBaselineText()));

      const result = await caller.course.generateFrameworkAndBaseline({
        courseId,
        responses: RESPONSES,
      });

      // Two LLM calls in all: clarify, then the merged Turn.
      expect(generateChat).toHaveBeenCalledTimes(2);
      // Router return value — FrameworkJsonb + the baseline's client projection.
      expect(result.nextStage).toBe("answering");
      expect(result.framework.estimatedStartingTier).toBe(1);
      expect(result.framework.tiers).toHaveLength(3);
      expect(result.baseline.questions.questions).toHaveLength(7);

      // DB: both columns populated, in the shapes the two old steps wrote.
      const course = await getCourseById(courseId);
      expect(frameworkJsonbSchema.safeParse(course.framework).success).toBe(true);
      expect(baselineJsonbSchema.safeParse(course.baseline).success).toBe(true);
      expect(course.framework).toEqual(validFramework());
      expect(course.baseline).toEqual({ ...validBaseline(), responses: [], gradings: [] });

      // The scoping Context gains one Turn: the stage envelope and the raw
      // model output, stored byte for byte (append-only, cache-stable).
      const rows = await contextRows(db);
      expect(rows.map((r) => [r.turnIndex, r.kind])).toEqual([
        [0, "user_message"],
        [0, "assistant_response"],
        [1, "user_message"],
        [1, "assistant_response"],
      ]);
      expect(rows[2]?.content).toContain("<stage>generate framework and baseline</stage>");
      expect(rows[2]?.content).toContain(`A: ${CLARIFY_ANSWERS[0]!}`);
      expect(rows[3]?.content).toBe(validFrameworkAndBaselineText());
    });
  });

  // -------------------------------------------------------------------------
  // Case 6: idempotency — pre-populated framework and baseline, LLM not called
  // -------------------------------------------------------------------------
  it("idempotency: returns the cached framework and baseline, does not call generateChat", async () => {
    await withTestDb(async (db) => {
      const { caller, courseId } = await clarifyCourse(db);
      // Pre-populate both columns — simulates a prior successful call.
      await updateCourseScopingState(courseId, {
        framework: validFramework(),
        baseline: { ...validBaseline(), responses: [], gradings: [] },
      });
      // Reset mock — any call now would be unexpected.
      vi.mocked(generateChat).mockReset();

      const result = await caller.course.generateFrameworkAndBaseline({
        courseId,
        responses: RESPONSES,
      });

      expect(result.framework).toMatchObject({ estimatedStartingTier: 1 });
      expect(result.baseline.questions.questions).toHaveLength(7);
      expect(result.nextStage).toBe("answering");
      expect(generateChat).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Case 7: a course framed before the merge (issue #15)
  // -------------------------------------------------------------------------
  // Production can hold a course whose framework Turn landed under the old
  // two-step flow, but whose baseline Turn never did. Its Context ends with
  // the old framework Turn. The merged Turn must replay that Context byte for
  // byte, append after it, and write a framework and baseline that agree.
  it("a pre-merge course with a framework and no baseline reruns the merged Turn after its old Context", async () => {
    await withTestDb(async (db) => {
      const { caller, courseId } = await clarifyCourse(db);
      const [pass] = await db.select().from(scopingPasses);
      const oldFramework = { ...validFramework(), userMessage: "The old framework." };
      // The old framework Turn, as the two-step flow persisted it.
      await appendMessages([
        {
          parent: { kind: "scoping", id: pass!.id },
          turnIndex: 1,
          seq: 0,
          kind: "user_message",
          role: "user",
          content:
            "<stage>generate framework</stage>\n<learner_input>\nQ: Goal?\nA: Learn\n</learner_input>",
        },
        {
          parent: { kind: "scoping", id: pass!.id },
          turnIndex: 1,
          seq: 1,
          kind: "assistant_response",
          role: "assistant",
          content: JSON.stringify(oldFramework),
        },
      ]);
      await updateCourseScopingState(courseId, {
        clarification: {
          ...(await getCourseById(courseId)).clarification!,
          responses: RESPONSES,
        },
        framework: oldFramework,
      });
      const oldRows = await contextRows(db);
      // The system prompt the clarify Turn sent. The prefix stays byte-stable
      // only if the merged Turn sends the same bytes.
      const [clarifyMessages] = vi.mocked(generateChat).mock.calls.at(-1)!;
      vi.mocked(generateChat).mockClear();
      vi.mocked(generateChat).mockResolvedValueOnce(llmSuccess(validFrameworkAndBaselineText()));

      await caller.course.generateFrameworkAndBaseline({ courseId, responses: RESPONSES });

      // The model saw the old Context unchanged, then the merged envelope.
      const [messages] = vi.mocked(generateChat).mock.calls[0]!;
      const contents = messages.map((m) => m.content);
      expect(messages[0]?.role).toBe("system");
      expect(messages[0]).toEqual(clarifyMessages[0]);
      expect(contents.slice(1, 1 + oldRows.length)).toEqual(oldRows.map((r) => r.content));
      expect(contents.at(-1)).toContain("<stage>generate framework and baseline</stage>");

      // The merged Turn appends at the next turn index.
      const rows = await contextRows(db);
      expect(rows.slice(0, oldRows.length)).toEqual(oldRows);
      expect(rows.slice(oldRows.length).map((r) => [r.turnIndex, r.kind])).toEqual([
        [2, "user_message"],
        [2, "assistant_response"],
      ]);

      // Both columns now come from the merged Turn, so they agree on scope.
      const course = await getCourseById(courseId);
      expect(course.framework).toEqual(validFramework());
      expect(course.baseline).toEqual({ ...validBaseline(), responses: [], gradings: [] });

      // The chat renders: getState projects both columns.
      const state = await caller.course.getState({ courseId });
      expect(state.framework?.userMessage).toBe("Here is the framework.");
      expect(state.baseline?.questions).toHaveLength(7);
    });
  });

  // -------------------------------------------------------------------------
  // Case 8: validation retry — a baseline question outside the framework's scope
  // -------------------------------------------------------------------------
  it("retry-then-success: a baseline off the framework's scope gets a retry directive naming it", async () => {
    await withTestDb(async (db) => {
      const { caller, courseId } = await clarifyCourse(db);
      // First attempt: well-formed, but b7 probes tier 3 outside scope [1, 2].
      const offScope = JSON.stringify({
        framework: validFramework(),
        baseline: {
          ...validBaseline(),
          questions: [
            ...validBaseline().questions.slice(0, 6),
            { ...mcQuestion("b7", 1), tier: 3 },
          ],
        },
      });
      vi.mocked(generateChat)
        .mockRejectedValueOnce(noObjectError(offScope))
        .mockResolvedValueOnce(llmSuccess(validFrameworkAndBaselineText()));

      const result = await caller.course.generateFrameworkAndBaseline({
        courseId,
        responses: RESPONSES,
      });

      expect(result.baseline.questions.questions).toHaveLength(7);
      const rows = (await contextRows(db)).filter((r) => r.turnIndex === 1);
      expect(rows.map((r) => r.kind)).toEqual([
        "user_message",
        "failed_assistant_response",
        "harness_retry_directive",
        "assistant_response",
      ]);
      expect(rows[1]?.content).toBe(offScope);
      // The cross-half refine reaches the model verbatim, with its field path.
      expect(rows[2]?.content).toContain(
        "baseline.questions.6.tier: question b7 tier 3 is outside baselineScopeTiers [1, 2]",
      );
    });
  });

  // -------------------------------------------------------------------------
  // Case 9: PRECONDITION_FAILED — clarification null
  // -------------------------------------------------------------------------
  it("PRECONDITION_FAILED when clarification is null (clarify not run)", async () => {
    await withTestDb(async (db) => {
      await seedUser(db);

      // Create a course without running clarify.
      const course = await createCourse({ userId: USER, topic: "Rust" });
      const caller = appRouter.createCaller({ userId: USER });

      await expect(
        caller.course.generateFrameworkAndBaseline({
          courseId: course.id,
          responses: [
            { questionId: "q1", freetext: "answer one" },
            { questionId: "q2", freetext: "answer two" },
          ],
        }),
      ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
      expect(generateChat).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Case 10: NOT_FOUND for different user
  // -------------------------------------------------------------------------
  it("NOT_FOUND when a different user calls it on another user's course", async () => {
    await withTestDb(async (db) => {
      const { courseId } = await clarifyCourse(db);
      await seedUser(db, OTHER_USER);

      // getCourseById throws NotFoundError on ownership mismatch; the trpc
      // mapNotFound middleware translates that to TRPCError(NOT_FOUND) so the
      // client gets a semantic 404, not a 500. Ownership remains info-leak
      // safe — same response shape whether the id is unknown or owned by
      // another user.
      const callerB = appRouter.createCaller({ userId: OTHER_USER });
      await expect(
        callerB.course.generateFrameworkAndBaseline({ courseId, responses: RESPONSES }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });
});

// ===========================================================================
// submitBaseline
// ===========================================================================

describe("course.submitBaseline", () => {
  // -------------------------------------------------------------------------
  // Case 13: full pipeline end-to-end
  // -------------------------------------------------------------------------
  // Exercises the complete scoping pipeline through the tRPC router:
  // clarify → generateFrameworkAndBaseline → submitBaseline. Each
  // stage mocks `generateChat` (LLM boundary) with a fixture matching the
  // stage's Zod schema. All persistence is real DB so we assert the final
  // course.status flip and the returned wave1Id are consistent end-to-end.
  it("happy path: full pipeline flips status to active and returns wave1Id", async () => {
    await withTestDb(async (db) => {
      await seedUser(db);

      // Stage 1: clarify. Mock returns 2 free-text questions.
      // Stage 2: framework and baseline in one call. Mock returns 3 tiers,
      //          baselineScopeTiers=[1,2], and 7 MC questions, all `correct: "A"`.
      // Stage 3: scoping-close. Mock returns gradings covering all 7 ids
      //          and a valid blueprint. The Harness computes the starting tier.
      vi.mocked(generateChat)
        .mockResolvedValueOnce(llmSuccess(validClarifyText()))
        .mockResolvedValueOnce(llmSuccess(validFrameworkAndBaselineText()))
        .mockResolvedValueOnce(llmSuccess(validScopingCloseText()));

      const caller = appRouter.createCaller({ userId: USER });

      // Stage 1.
      const clarifyResult = await caller.course.clarify({ topic: "Rust" });
      const courseId = clarifyResult.courseId;

      // Stage 2.
      const baselineResult = await caller.course.generateFrameworkAndBaseline({
        courseId,
        responses: [
          { questionId: "q1", freetext: CLARIFY_ANSWERS[0]! },
          { questionId: "q2", freetext: CLARIFY_ANSWERS[1]! },
        ],
      });
      // Sanity: ensure mock emitted 7 questions so the submitBaseline answers
      // below cover every id (precondition enforced server-side).
      expect(baselineResult.baseline.questions.questions).toHaveLength(7);

      // Stage 3: submit one MC answer per question. All `selected: "A"` =
      // correct (matches validBaseline's `correct: "A"` on every q).
      const answers = baselineResult.baseline.questions.questions.map((q) => ({
        id: q.id,
        kind: "mc" as const,
        selected: "A" as const,
      }));
      const result = await caller.course.submitBaseline({ courseId, answers });

      // Returned payload shape.
      expect(result.userMessage).toBe("Nice work — your first lesson is ready.");
      expect(result.wave1Id).toBeTruthy();
      // wave1Id is a UUID — basic shape check (no need to import a regex lib).
      expect(result.wave1Id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/i);

      // Course flipped to active.
      const course = await getCourseById(courseId);
      expect(course.status).toBe("active");
      // Every click was right, so both scope tiers are mastered and the
      // learner starts at the top of scope (issue #94).
      expect(course.startingTier).toBe(2);
    });
  });
});

// ===========================================================================
// Scoping wire: no plaintext answer key
// ===========================================================================

describe("scoping wire", () => {
  // Mirrors the Wave's guard (`getWaveState.integration.test.ts`): every
  // scoping payload the client receives drops rubrics, and a graded MC key
  // arrives only as the id-bound `correctEnc`.
  it("clarify, generateFrameworkAndBaseline and getState ship no plaintext answer key", async () => {
    await withTestDb(async (db) => {
      await seedUser(db);
      vi.mocked(generateChat)
        .mockResolvedValueOnce(llmSuccess(validClarifyText()))
        .mockResolvedValueOnce(llmSuccess(validFrameworkAndBaselineText()))
        .mockResolvedValueOnce(llmSuccess(validScopingCloseText()));
      const caller = appRouter.createCaller({ userId: USER });

      const clarifyResult = await caller.course.clarify({ topic: "Rust" });
      expectNoPlaintextAnswerKey(clarifyResult);
      const { courseId } = clarifyResult;
      const baselineResult = await caller.course.generateFrameworkAndBaseline({
        courseId,
        responses: [
          { questionId: "q1", freetext: CLARIFY_ANSWERS[0]! },
          { questionId: "q2", freetext: CLARIFY_ANSWERS[1]! },
        ],
      });
      expectNoPlaintextAnswerKey(baselineResult);

      // Before submit: the open baseline card's MC keys decode to the stored `A`.
      const open = await caller.course.getState({ courseId });
      expectNoPlaintextAnswerKey(open);
      for (const q of open.baseline?.questions ?? []) {
        if (q.type !== "multiple_choice") throw new Error(`expected MC, got ${q.type}`);
        expect(decodeCorrect(q.id, q.correctEnc ?? "")).toBe(KEY_TO_INDEX.A);
      }

      // After close: the reload wire stays redacted.
      const answers = baselineResult.baseline.questions.questions.map((q) => ({
        id: q.id,
        kind: "mc" as const,
        selected: "A" as const,
      }));
      await caller.course.submitBaseline({ courseId, answers });
      const closed = await caller.course.getState({ courseId });
      expect(closed.status).toBe("active");
      expectNoPlaintextAnswerKey(closed);
    });
  });
});
