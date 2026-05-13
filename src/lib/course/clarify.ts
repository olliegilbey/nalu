import { sanitiseUserInput } from "@/lib/security/sanitiseUserInput";
import { executeTurn } from "@/lib/turn/executeTurn";
import { createCourse, updateCourseScopingState } from "@/db/queries/courses";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import { parseClarifyResponse, type ParsedClarifyResponse } from "./parsers";
import type { ClarificationJsonb } from "@/lib/types/jsonb";

/** Parameters for {@link clarify}. Object shape keeps the call site future-proof. */
export interface ClarifyParams {
  readonly userId: string;
  readonly topic: string;
}

/** Result of a clarification turn — caller receives questions and the next stage. */
export interface ClarifyResult {
  readonly courseId: string;
  readonly questions: readonly string[];
  readonly nextStage: "framework";
}

/**
 * Drive the clarify turn of new-course onboarding.
 *
 * Pattern (spec §3.4):
 *   create course (or fetch idempotent)
 *   → open scoping pass
 *   → executeTurn(seed = scoping, user msg = sanitised topic, parser = clarify)
 *   → persist parsed questions to courses.clarification (D1 option B: translator)
 *   → return { courseId, questions, nextStage: "framework" }
 */
export async function clarify(params: ClarifyParams): Promise<ClarifyResult> {
  const course = await createCourse({ userId: params.userId, topic: params.topic });

  // Idempotency: if a re-creation path produced a course that already has
  // clarification stored, surface it without re-prompting the LLM.
  // (createCourse returns a fresh row in normal flow; this branch is a
  // belt-and-braces guard against future replays.)
  if (course.clarification !== null) {
    // D1 option B: stored shape uses discriminated union questions; extract .text for callers.
    // Drizzle infers `jsonb` columns as `unknown`; `courseRowGuard` in `createCourse`
    // has already validated the payload against `clarificationJsonbSchema`, so the
    // cast narrows a runtime-guaranteed shape to its TS type without re-parsing.
    const cached = course.clarification as ClarificationJsonb;
    return {
      courseId: course.id,
      questions: cached.questions.map((q) => q.text),
      nextStage: "framework",
    };
  }

  const pass = await ensureOpenScopingPass(course.id);
  // Explicit type param preserves the parsed shape while the parser shim is in place (Task 13 removes both).
  const { parsed } = await executeTurn<ParsedClarifyResponse>({
    parent: { kind: "scoping", id: pass.id },
    seed: { kind: "scoping", topic: params.topic },
    userMessageContent: sanitiseUserInput(params.topic),
    // @ts-expect-error Task 5: parser→responseSchema migration in progress; this caller rewritten in Task 13
    parser: parseClarifyResponse,
    label: "clarify",
    successSummary: (p) => `questions=${p.questions.length}`,
  });

  // D1 option B: translate bare strings from the parser into the JSONB discriminated-union shape.
  // clarificationJsonbSchema.parse() inside updateCourseScopingState validates this.
  await updateCourseScopingState(course.id, {
    clarification: toClarificationJsonb(parsed.questions),
  });

  return {
    courseId: course.id,
    questions: parsed.questions,
    nextStage: "framework",
  };
}

/**
 * Translate parser output (plain strings) to `courses.clarification` JSONB shape.
 *
 * LLM emits plain question text — no options/types. All become `free_text`.
 * Synthetic ids `q1`, `q2`, ... let the framework/baseline steps reference
 * each Q→A pair without the LLM needing to author ids itself.
 *
 * This is a single-use private helper; kept here to avoid premature abstraction.
 */
function toClarificationJsonb(questions: readonly string[]): ClarificationJsonb {
  return {
    questions: questions.map((text, i) => ({
      id: `q${i + 1}`,
      text,
      // free_text: no options field (strict schema forbids it)
      type: "free_text" as const,
    })),
    answers: [],
  };
}
