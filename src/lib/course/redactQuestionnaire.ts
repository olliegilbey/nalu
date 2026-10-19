import { encodeCorrect } from "@/lib/security/obfuscateCorrect";
import type { BaselineJsonb, ClarificationJsonb, V3Question, V3Response } from "@/lib/types/jsonb";
import { KEY_TO_INDEX, type McOptions } from "@/lib/types/mcOptionKey";

/**
 * Client-safe question: the one shape every scoping and Wave payload sends.
 *
 * It carries no grading key. `freetextRubric` is gone: free text is graded on
 * the server, so the client has no use for it. A graded MC question carries
 * `correctEnc` in place of `correct`, so the Composer can still give instant
 * feedback. The `never` fields bar a stored question, keys and all, from
 * passing as this type.
 */
export type QuestionForClient =
  | {
      readonly id: string;
      readonly type: "multiple_choice";
      readonly prompt: string;
      readonly options: McOptions;
      /**
       * Base64-obfuscated correct index, bound to `id`. NOT cryptographic.
       * Absent on an ungraded MC question, such as clarify's.
       */
      readonly correctEnc?: string;
      /** Concept tier — drives client-side `calculateMcXp`. Optional on the source. */
      readonly tier?: number;
      readonly correct?: never;
      readonly freetextRubric?: never;
    }
  | {
      readonly id: string;
      readonly type: "free_text";
      readonly prompt: string;
      /** Concept tier — present for symmetry; free-text XP is server-graded. */
      readonly tier?: number;
      readonly freetextRubric?: never;
    };

/**
 * Project one stored question to its client-safe shape.
 *
 * Drops `freetextRubric` and `conceptName`, and swaps an MC `correct` for its
 * id-bound `correctEnc`. Server code keeps the stored question for grading;
 * only this projection crosses the wire. Pure.
 */
export function redactQuestion(q: V3Question): QuestionForClient {
  if (q.type === "multiple_choice") {
    return {
      id: q.id,
      type: "multiple_choice",
      prompt: q.prompt,
      options: q.options,
      correctEnc:
        q.correct === undefined ? undefined : encodeCorrect(q.id, KEY_TO_INDEX[q.correct]),
      tier: q.tier,
    };
  }
  return { id: q.id, type: "free_text", prompt: q.prompt, tier: q.tier };
}

/**
 * Client-safe projection of a scoping questionnaire column (`clarification` or
 * `baseline`): the model's framing, the redacted questions, and the saved answers.
 */
export interface ScopingQuestionnaireForClient {
  readonly userMessage: string;
  readonly questions: readonly QuestionForClient[];
  readonly responses: readonly V3Response[];
}

/**
 * Project a stored scoping questionnaire column through {@link redactQuestion}.
 * Drops a closed baseline's gradings and summaries too: no client reads them.
 */
export function redactScopingQuestionnaire(
  stored: ClarificationJsonb | BaselineJsonb | null,
): ScopingQuestionnaireForClient | null {
  if (stored === null) return null;
  return {
    userMessage: stored.userMessage,
    questions: stored.questions.map(redactQuestion),
    responses: stored.responses,
  };
}

/**
 * Client-safe payload of a clarify or baseline Turn, as `course.clarify` and
 * `course.generateBaseline` return it. Keeps the model's nesting.
 */
export interface QuestionnaireTurnForClient {
  readonly userMessage: string;
  readonly questions: { readonly questions: readonly QuestionForClient[] };
}

/** Project a clarify or baseline Turn's parsed payload through {@link redactQuestion}. */
export function redactQuestionnaireTurn(turn: {
  readonly userMessage: string;
  readonly questions: { readonly questions: readonly V3Question[] };
}): QuestionnaireTurnForClient {
  return {
    userMessage: turn.userMessage,
    questions: { questions: turn.questions.questions.map(redactQuestion) },
  };
}
