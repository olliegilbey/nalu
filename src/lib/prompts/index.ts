export {
  CLARIFICATION_SYSTEM_PROMPT,
  buildClarificationPrompt,
  clarifyingQuestionsSchema,
  type ClarificationPromptParams,
} from "./clarification";

export {
  buildClarificationAssistantMessage,
  buildFrameworkPrompt,
  buildFrameworkTurnUserContent,
  frameworkSchema,
  type ClarificationExchange,
  type Framework,
  type FrameworkPromptParams,
} from "./framework";

export {
  MC_OPTION_KEYS,
  baselineSchema,
  buildBaselinePrompt,
  buildBaselineTurnUserContent,
  buildFrameworkAssistantMessage,
  type BaselineAssessment,
  type BaselinePromptParams,
  type BaselineQuestion,
  type McOptionKey,
} from "./baseline";

export {
  FREETEXT_ESCAPE_PREFIX,
  baselineEvaluationSchema,
  buildBaselineAssistantMessage,
  buildBaselineEvaluationPrompt,
  buildBaselineEvaluationTurnUserContent,
  type BaselineEvaluationItem,
  type BaselineEvaluationPromptParams,
} from "./baselineEvaluation";

/**
 * New JSON-everywhere surface — legacy block above is kept until Task 18 deletes the migration's
 * source files. Tasks 13-16 will migrate consumers off the legacy block.
 */

export {
  questionSchema,
  questionnaireSchema,
  responseSchema,
  responsesSchema,
  type Question,
  type Questionnaire,
  type Response,
  type Responses,
} from "./questionnaire";

export { clarifySchema, type ClarifyTurn } from "./clarify";

export { makeBaselineSchema, type BaselineTurn, type MakeBaselineSchemaParams } from "./baseline";

export { renderScopingSystem, renderStageEnvelope } from "./scoping";

export { gradeBaselineSchema, type GradeBaselineTurn } from "./baselineGrading";
