/**
 * Namespace a model-generated question id to its emitting questionnaire.
 *
 * WHY: the `assessments` partial unique index `assessments_wave_question_unique`
 * keys on `(wave_id, question_id)` only — it does NOT include `turn_index`. The
 * model's per-question `id` (e.g. `q1`/`q2`) is only documented as stable
 * *within one questionnaire*, and LLMs naturally restart numbering at `q1` for
 * every new questionnaire. A wave drops ~2-3 questionnaires over its 10 turns,
 * so raw `q.id` reuse across them is near-inevitable and collides on the index,
 * 500-ing the teaching turn (bug_004).
 *
 * FIX: the value stored in the `question_id` column is namespaced by the
 * emitting questionnaire's id (the `assistant_response` row id, which is also
 * `WaveChatLogEntry.questionnaireId` and `OpenQuestionnaireRecord.questionnaireId`).
 * Two questionnaires within a wave always have distinct ids, so namespacing
 * makes cross-questionnaire AND intra-questionnaire collisions structurally
 * impossible while the model keeps emitting simple ids.
 *
 * The model never sees this form: it is applied at insert time and re-derived
 * at grading time. Anything that LOOKS UP an assessment row by question id
 * (`getAssessmentByWaveAndQuestionId`) MUST pass the namespaced value; anything
 * the model or client sees keeps the raw `q.id`.
 *
 * Pure — typed strings in, namespaced string out.
 *
 * @param questionnaireId The emitting questionnaire's id (assistant_response
 *   row id). Stable UUID, unique per questionnaire emission.
 * @param rawQuestionId The model-generated per-question id, verbatim.
 */
export function namespaceQuestionId(questionnaireId: string, rawQuestionId: string): string {
  return `${questionnaireId}:${rawQuestionId}`;
}
