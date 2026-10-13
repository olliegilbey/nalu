import { adaptQuestionnaire, type ActiveQuestionnaire } from "./adaptQuestionnaire";
import type { CourseState } from "./getState";
import { questionnaireKey } from "./questionnaireKey";

/**
 * Derive the Composer's active questionnaire for scoping from server state. Pure.
 *
 * At most one card is open: clarify, then baseline. Each closes once the
 * learner's answers are saved. The scoping twin of `deriveActiveQuestionnaire`.
 */
export function deriveActiveScopingQuestionnaire(s: CourseState): ActiveQuestionnaire | null {
  // Clarify is active while there's a clarification with no responses AND
  // no framework yet.
  if (s.clarification && s.clarification.responses.length === 0 && !s.framework) {
    const { questions } = adaptQuestionnaire(s.clarification.questions);
    return {
      kind: "clarify",
      questions,
      questionsKey: questionnaireKey(questions),
      persistKey: `nalu:scoping:${s.courseId}:clarify`,
    };
  }

  // Baseline is active while there's a baseline with no responses AND status
  // still 'scoping' (so the close hasn't landed).
  if (s.baseline && s.baseline.responses.length === 0 && s.status === "scoping") {
    const { questions } = adaptQuestionnaire(s.baseline.questions);
    return {
      kind: "baseline",
      questions,
      questionsKey: questionnaireKey(questions),
      persistKey: `nalu:scoping:${s.courseId}:baseline`,
    };
  }

  return null;
}
