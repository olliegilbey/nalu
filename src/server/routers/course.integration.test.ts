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
import { withTestDb } from "@/db/testing/withTestDb";
import { appRouter } from "./index";
import { userProfiles, contextMessages, courses } from "@/db/schema";
import { asc } from "drizzle-orm";
import { getCourseById, updateCourseScopingState } from "@/db/queries/courses";
import { createCourse } from "@/db/queries/courses";
import {
  clarificationJsonbSchema,
  frameworkJsonbSchema,
  baselineJsonbSchema,
} from "@/lib/types/jsonb";

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
 * Valid framework LLM response — pure JSON matching frameworkSchema.
 * 3+ tiers (FRAMEWORK.minTiers=3); estimatedStartingTier in scope; baselineScopeTiers contiguous.
 */
function validFrameworkText(): string {
  return JSON.stringify({
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
  });
}

/**
 * Valid baseline LLM response — pure JSON matching makeBaselineSchema.
 * Exactly 7 questions (BASELINE.minQuestions=7), all tiers in [1, 2] (scope from validFrameworkText).
 */
function validBaselineText(): string {
  return JSON.stringify({
    userMessage: "Here is the baseline.",
    questions: {
      questions: [
        mcQuestion("b1", 1),
        mcQuestion("b2", 2),
        mcQuestion("b3", 1),
        mcQuestion("b4", 2),
        mcQuestion("b5", 1),
        mcQuestion("b6", 2),
        mcQuestion("b7", 1),
      ],
    },
  });
}

// Answers matching the 2 questions emitted by validClarifyText.
// Not `as const` — tRPC input schema expects mutable string[].
const CLARIFY_ANSWERS: string[] = ["Learn systems programming.", "C++ background."];

/**
 * Valid scoping-close LLM response — pure JSON matching `makeScopingCloseSchema`.
 * One grading per baseline question (7 total), all conceptTier in scope ([1, 2]),
 * verdict/qualityScore bands aligned (correct → 5 ∈ [4,5]).
 */
function validScopingCloseText(): string {
  // Question ids must exactly match those emitted by validBaselineText.
  const questionIds = ["b1", "b2", "b3", "b4", "b5", "b6", "b7"] as const;
  return JSON.stringify({
    userMessage: "Nice work — your first lesson is ready.",
    gradings: questionIds.map((qid, idx) => ({
      questionId: qid,
      verdict: "correct" as const,
      qualityScore: 5,
      conceptName: "test-concept",
      // Alternate tier 1/2 so we exercise both scope tiers; both are in scope.
      conceptTier: (idx % 2 === 0 ? 1 : 2) as 1 | 2,
      rationale: "Selected the correct option. Start lesson 1 with a deeper probe.",
    })),
    summary: "Learner shows solid grasp of foundations across the baseline.",
    immutableSummary:
      "C++ background; aims to learn systems programming. Comfortable with manual memory models.",
    startingTier: 2,
    nextUnitBlueprint: {
      topic: "Ownership basics",
      outline: ["intro to ownership", "moves vs copies", "borrowing rules"],
      openingText: "Welcome — given your C++ background, let's start with how Rust differs.",
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
      vi.mocked(generateChat).mockResolvedValueOnce({
        text: validClarifyText(),
        usage: FAKE_USAGE,
      });

      const caller = appRouter.createCaller({ userId: USER });
      const result = await caller.course.clarify({ topic: "Rust" });

      // Router return value — clarification is { userMessage, questions: { questions: [...] } }.
      expect(result.clarification.questions.questions).toHaveLength(2);
      expect(result.nextStage).toBe("framework");
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

      // First call: not valid JSON → JSON.parse throws → ValidationGateFailure.
      vi.mocked(generateChat)
        .mockResolvedValueOnce({ text: "<response>thinking...</response>", usage: FAKE_USAGE })
        .mockResolvedValueOnce({ text: validClarifyText(), usage: FAKE_USAGE });

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
      vi.mocked(generateChat).mockResolvedValue({
        text: "<response>still no questions</response>",
        usage: FAKE_USAGE,
      });

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

      // courses.clarification must still be null — lib step never persisted.
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
// generateFramework
// ===========================================================================

describe("course.generateFramework", () => {
  // -------------------------------------------------------------------------
  // Case 5: happy path after clarify
  // -------------------------------------------------------------------------
  it("happy path: runs after clarify, returns FrameworkJsonb, persists to DB", async () => {
    await withTestDb(async (db) => {
      await seedUser(db);

      // Step 1: clarify to populate the course.
      vi.mocked(generateChat).mockResolvedValueOnce({
        text: validClarifyText(),
        usage: FAKE_USAGE,
      });
      const caller = appRouter.createCaller({ userId: USER });
      const clarifyResult = await caller.course.clarify({ topic: "Rust" });

      // Step 2: mock framework LLM call.
      vi.mocked(generateChat).mockResolvedValueOnce({
        text: validFrameworkText(),
        usage: FAKE_USAGE,
      });

      const result = await caller.course.generateFramework({
        courseId: clarifyResult.courseId,
        responses: [
          { questionId: "q1", freetext: CLARIFY_ANSWERS[0]! },
          { questionId: "q2", freetext: CLARIFY_ANSWERS[1]! },
        ],
      });

      // Router return value — camelCase FrameworkJsonb.
      expect(result.nextStage).toBe("baseline");
      expect(result.framework.estimatedStartingTier).toBe(1);
      expect(result.framework.tiers).toHaveLength(3);

      // DB: courses.framework is populated and valid.
      const course = await getCourseById(clarifyResult.courseId);
      expect(course.framework).not.toBeNull();
      const parsed = frameworkJsonbSchema.safeParse(course.framework);
      expect(parsed.success).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Case 6: idempotency — pre-populated framework, LLM not called
  // -------------------------------------------------------------------------
  it("idempotency: returns cached framework, does not call generateChat", async () => {
    await withTestDb(async (db) => {
      await seedUser(db);

      // Run clarify to create the course.
      vi.mocked(generateChat).mockResolvedValueOnce({
        text: validClarifyText(),
        usage: FAKE_USAGE,
      });
      const caller = appRouter.createCaller({ userId: USER });
      const clarifyResult = await caller.course.clarify({ topic: "Rust" });

      // Pre-populate the framework directly — simulates a prior successful call.
      const storedFramework = {
        userMessage: "Cached framework framing.",
        estimatedStartingTier: 1,
        baselineScopeTiers: [1, 2],
        tiers: [
          {
            number: 1,
            name: "Foundations",
            description: "Core.",
            exampleConcepts: ["borrow checker", "lifetimes", "move semantics", "references"],
          },
          {
            number: 2,
            name: "Intermediate",
            description: "Traits.",
            exampleConcepts: ["traits", "generics", "closures", "iterators"],
          },
          {
            number: 3,
            name: "Advanced",
            description: "Advanced.",
            exampleConcepts: ["unsafe", "FFI", "macros", "async"],
          },
        ],
      };
      await updateCourseScopingState(clarifyResult.courseId, { framework: storedFramework });

      // Reset mock — any call now would be unexpected.
      vi.mocked(generateChat).mockReset();

      const result = await caller.course.generateFramework({
        courseId: clarifyResult.courseId,
        responses: [
          { questionId: "q1", freetext: CLARIFY_ANSWERS[0]! },
          { questionId: "q2", freetext: CLARIFY_ANSWERS[1]! },
        ],
      });

      // Returns the pre-populated framework unchanged.
      expect(result.framework).toMatchObject({ estimatedStartingTier: 1 });
      expect(result.nextStage).toBe("baseline");
      // LLM must NOT be called.
      expect(generateChat).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Case 7: PRECONDITION_FAILED — clarification null
  // -------------------------------------------------------------------------
  it("PRECONDITION_FAILED when clarification is null (clarify not run)", async () => {
    await withTestDb(async (db) => {
      await seedUser(db);

      // Create a course without running clarify.
      const course = await createCourse({ userId: USER, topic: "Rust" });
      const caller = appRouter.createCaller({ userId: USER });

      await expect(
        caller.course.generateFramework({
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
  // Case 8: NOT_FOUND for different user
  // -------------------------------------------------------------------------
  it("NOT_FOUND when a different user attempts generateFramework on another user's course", async () => {
    await withTestDb(async (db) => {
      await seedUser(db, USER);
      await seedUser(db, OTHER_USER);

      // UserA creates and clarifies a course.
      vi.mocked(generateChat).mockResolvedValueOnce({
        text: validClarifyText(),
        usage: FAKE_USAGE,
      });
      const callerA = appRouter.createCaller({ userId: USER });
      const clarifyResult = await callerA.course.clarify({ topic: "Rust" });

      // UserB attempts to run generateFramework on UserA's course.
      // getCourseById throws NotFoundError on ownership mismatch; the trpc
      // mapNotFound middleware translates that to TRPCError(NOT_FOUND) so the
      // client gets a semantic 404, not a 500. Ownership remains info-leak
      // safe — same response shape whether the id is unknown or owned by
      // another user.
      const callerB = appRouter.createCaller({ userId: OTHER_USER });
      await expect(
        callerB.course.generateFramework({
          courseId: clarifyResult.courseId,
          responses: [
            { questionId: "q1", freetext: CLARIFY_ANSWERS[0]! },
            { questionId: "q2", freetext: CLARIFY_ANSWERS[1]! },
          ],
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });
});

// ===========================================================================
// generateBaseline
// ===========================================================================

describe("course.generateBaseline", () => {
  /**
   * Seed a course with clarification + framework already populated.
   * Avoids two extra generateChat mocks just to reach baseline state.
   */
  async function seedCourseWithFramework(
    db: Parameters<Parameters<typeof withTestDb>[0]>[0],
  ): Promise<string> {
    await seedUser(db);
    const course = await createCourse({ userId: USER, topic: "Rust" });
    // Populate clarification — camelCase v3 shape.
    await updateCourseScopingState(course.id, {
      clarification: {
        userMessage: "Let me ask you a few questions.",
        questions: [
          {
            id: "q1",
            prompt: "What is your goal?",
            type: "free_text" as const,
            freetextRubric: "r",
          },
          { id: "q2", prompt: "Your background?", type: "free_text" as const, freetextRubric: "r" },
        ],
        responses: [],
      },
    });
    // Populate framework — camelCase FrameworkJsonb.
    await updateCourseScopingState(course.id, {
      framework: {
        userMessage: "Here's the framework.",
        estimatedStartingTier: 1,
        baselineScopeTiers: [1, 2],
        tiers: [
          {
            number: 1,
            name: "Foundations",
            description: "Core.",
            exampleConcepts: ["borrow checker", "lifetimes", "move semantics", "references"],
          },
          {
            number: 2,
            name: "Intermediate",
            description: "Traits.",
            exampleConcepts: ["traits", "generics", "closures", "iterators"],
          },
          {
            number: 3,
            name: "Advanced",
            description: "Advanced.",
            exampleConcepts: ["unsafe", "FFI", "macros", "async"],
          },
        ],
      },
    });
    return course.id;
  }

  // -------------------------------------------------------------------------
  // Case 9: happy path after framework
  // -------------------------------------------------------------------------
  it("happy path: returns baseline with >=7 questions, nextStage=answering, persists BaselineJsonb", async () => {
    await withTestDb(async (db) => {
      const courseId = await seedCourseWithFramework(db);

      vi.mocked(generateChat).mockResolvedValueOnce({
        text: validBaselineText(),
        usage: FAKE_USAGE,
      });

      const caller = appRouter.createCaller({ userId: USER });
      const result = await caller.course.generateBaseline({ courseId });

      // Router return value — baseline is BaselineTurn: { userMessage, questions: { questions: [...] } }.
      expect(result.nextStage).toBe("answering");
      expect(result.baseline.questions.questions.length).toBeGreaterThanOrEqual(7);

      // DB: courses.baseline is populated and valid.
      const course = await getCourseById(courseId);
      expect(course.baseline).not.toBeNull();
      const parsed = baselineJsonbSchema.safeParse(course.baseline);
      expect(parsed.success).toBe(true);
      // responses and gradings initialised to [].
      expect((course.baseline as { responses: unknown[] }).responses).toEqual([]);
      expect((course.baseline as { gradings: unknown[] }).gradings).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Case 10: idempotency — pre-populated baseline, LLM not called
  // -------------------------------------------------------------------------
  it("idempotency: returns cached baseline, does not call generateChat", async () => {
    await withTestDb(async (db) => {
      const courseId = await seedCourseWithFramework(db);

      // Pre-populate baseline directly — camelCase BaselineJsonb.
      const storedBaseline = {
        userMessage: "Here is your baseline.",
        questions: [
          mcQuestion("b1", 1),
          mcQuestion("b2", 2),
          mcQuestion("b3", 1),
          mcQuestion("b4", 2),
          mcQuestion("b5", 1),
          mcQuestion("b6", 2),
          mcQuestion("b7", 1),
        ],
        responses: [],
        gradings: [],
      };
      await updateCourseScopingState(courseId, { baseline: storedBaseline });

      vi.mocked(generateChat).mockReset();

      const caller = appRouter.createCaller({ userId: USER });
      const result = await caller.course.generateBaseline({ courseId });

      expect(result.nextStage).toBe("answering");
      // baseline is BaselineTurn: { userMessage, questions: { questions: [...] } }
      expect(result.baseline.questions.questions).toHaveLength(7);
      // LLM must NOT be called.
      expect(generateChat).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Case 11: PRECONDITION_FAILED — framework null
  // -------------------------------------------------------------------------
  it("PRECONDITION_FAILED when framework is null", async () => {
    await withTestDb(async (db) => {
      await seedUser(db);
      // Create a course with only clarification — no framework.
      const course = await createCourse({ userId: USER, topic: "Rust" });
      await updateCourseScopingState(course.id, {
        clarification: {
          userMessage: "Let me ask you a few questions.",
          questions: [
            { id: "q1", prompt: "Goal?", type: "free_text" as const, freetextRubric: "r" },
          ],
          responses: [],
        },
      });

      const caller = appRouter.createCaller({ userId: USER });
      await expect(caller.course.generateBaseline({ courseId: course.id })).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
      });
      expect(generateChat).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Case 12: retry-then-success for baseline
  // -------------------------------------------------------------------------
  it("retry-then-success: first response is invalid JSON, second valid — returns success", async () => {
    await withTestDb(async (db) => {
      const courseId = await seedCourseWithFramework(db);

      // First call: not valid JSON → executeTurn surfaces a ValidationGateFailure.
      vi.mocked(generateChat)
        .mockResolvedValueOnce({ text: "<response>thinking...</response>", usage: FAKE_USAGE })
        .mockResolvedValueOnce({ text: validBaselineText(), usage: FAKE_USAGE });

      const caller = appRouter.createCaller({ userId: USER });
      const result = await caller.course.generateBaseline({ courseId });

      expect(result.nextStage).toBe("answering");
      expect(result.baseline.questions.questions.length).toBeGreaterThanOrEqual(7);

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
  // clarify → generateFramework → generateBaseline → submitBaseline. Each
  // stage mocks `generateChat` (LLM boundary) with a fixture matching the
  // stage's Zod schema. All persistence is real DB so we assert the final
  // course.status flip and the returned wave1Id are consistent end-to-end.
  it("happy path: full pipeline flips status to active and returns wave1Id", async () => {
    await withTestDb(async (db) => {
      await seedUser(db);

      // Stage 1: clarify. Mock returns 2 free-text questions.
      // Stage 2: framework. Mock returns 3 tiers, baselineScopeTiers=[1,2].
      // Stage 3: baseline. Mock returns 7 MC questions, all `correct: "A"`.
      // Stage 4: scoping-close. Mock returns gradings covering all 7 ids,
      //          startingTier=2 (in scope), valid blueprint + immutableSummary.
      vi.mocked(generateChat)
        .mockResolvedValueOnce({ text: validClarifyText(), usage: FAKE_USAGE })
        .mockResolvedValueOnce({ text: validFrameworkText(), usage: FAKE_USAGE })
        .mockResolvedValueOnce({ text: validBaselineText(), usage: FAKE_USAGE })
        .mockResolvedValueOnce({ text: validScopingCloseText(), usage: FAKE_USAGE });

      const caller = appRouter.createCaller({ userId: USER });

      // Stage 1.
      const clarifyResult = await caller.course.clarify({ topic: "Rust" });
      const courseId = clarifyResult.courseId;

      // Stage 2.
      await caller.course.generateFramework({
        courseId,
        responses: [
          { questionId: "q1", freetext: CLARIFY_ANSWERS[0]! },
          { questionId: "q2", freetext: CLARIFY_ANSWERS[1]! },
        ],
      });

      // Stage 3.
      const baselineResult = await caller.course.generateBaseline({ courseId });
      // Sanity: ensure mock emitted 7 questions so the submitBaseline answers
      // below cover every id (precondition enforced server-side).
      expect(baselineResult.baseline.questions.questions).toHaveLength(7);

      // Stage 4: submit one MC answer per question. All `selected: "A"` =
      // correct (matches validBaselineText's `correct: "A"` on every q).
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
    });
  });
});
