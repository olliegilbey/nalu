import { sanitiseUserInput } from "@/lib/security/sanitiseUserInput";
import { executeTurn } from "@/lib/turn/executeTurn";
import { createCourse, updateCourseScopingState } from "@/db/queries/courses";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import { clarifySchema, type ClarifyTurn } from "@/lib/prompts/clarify";
import { renderStageEnvelope } from "@/lib/prompts/scoping";
import type { ClarificationJsonb } from "@/lib/types/jsonb";

/** Parameters for {@link clarify}. */
export interface ClarifyParams {
  readonly userId: string;
  readonly topic: string;
}

export interface ClarifyResult {
  readonly courseId: string;
  /** Full Questionnaire payload — the UI renders cards from this. */
  readonly clarification: ClarifyTurn;
  readonly nextStage: "framework";
}

/**
 * Drive the clarify turn.
 *
 * Flow: createCourse → ensureOpenScopingPass → executeTurn(responseSchema=clarifySchema)
 *   → persist wire shape directly (no translator) → return.
 *
 * The persisted JSONB shape is `{ questions, responses: [] }` — responses
 * are populated after the learner submits answers via the next router call.
 */
export async function clarify(params: ClarifyParams): Promise<ClarifyResult> {
  const course = await createCourse({ userId: params.userId, topic: params.topic });

  if (course.clarification !== null) {
    // Idempotency: rebuild ClarifyTurn from stored JSONB. `courseRowGuard`
    // already validated the row against `clarificationJsonbSchema`.
    const stored = course.clarification as ClarificationJsonb;
    return {
      courseId: course.id,
      clarification: {
        userMessage: "", // userMessage not persisted post-clarify — UI shows nothing on replay.
        questions: { questions: stored.questions },
      },
      nextStage: "framework",
    };
  }

  const pass = await ensureOpenScopingPass(course.id);
  const { parsed } = await executeTurn({
    parent: { kind: "scoping", id: pass.id },
    seed: { kind: "scoping", topic: params.topic },
    userMessageContent: renderStageEnvelope({
      stage: "clarify",
      learnerInput: sanitiseUserInput(params.topic),
    }),
    responseSchema: clarifySchema,
    responseSchemaName: "clarify",
    label: "clarify",
    successSummary: (p) => `questions=${p.questions.questions.length}`,
  });

  // Persist wire shape directly. responses start empty; populated after the learner submits.
  await updateCourseScopingState(course.id, {
    clarification: { questions: parsed.questions.questions, responses: [] },
  });

  return { courseId: course.id, clarification: parsed, nextStage: "framework" };
}
