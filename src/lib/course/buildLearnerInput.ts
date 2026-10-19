import { typedMcGradingRule } from "@/lib/prompts/questionnaire";
import {
  KEY_TO_INDEX,
  MC_OPTION_KEYS,
  type McOptionKey,
  type McOptions,
} from "@/lib/types/mcOptionKey";
import type { SubmitTurnPayload } from "@/lib/types/waveTurnInput";
import { escapeXmlText } from "@/lib/security/escapeXmlText";
import { sanitiseUserInput } from "@/lib/security/sanitiseUserInput";

/**
 * Minimal shape of an open questionnaire as loaded by `loadWaveContext`.
 * Carries enough to render the envelope and compute mechanical MC correctness
 * server-side. NOT the client projection (which uses `correctEnc`).
 */
export interface OpenQuestionnaireRecord {
  readonly questionnaireId: string;
  readonly questions: readonly {
    readonly id: string;
    readonly type: "multiple_choice" | "free_text";
    readonly prompt: string;
    readonly options?: McOptions;
    readonly correct?: McOptionKey;
    readonly freetextRubric: string;
  }[];
}

/**
 * Compose the per-turn `learnerInput` envelope body.
 *
 * `chat-text` wraps the learner's free-text in `<learner_reply>` (sanitised).
 *
 * `questionnaire-answers` emits one `<questionnaire_answer>` block per answer
 * discriminated by answer kind. MC blocks carry the learner's selected index,
 * mechanical verdict, and the correct index (so the model sees server truth
 * without re-asking). Free-text blocks carry the learner's prose plus a
 * `fromEscape` flag. A typed answer to an MC question also carries an
 * `<mc_answer_key>` block (issue #149), so the grader has the options and key.
 *
 * NOTE: `selected_index` / `correct_index` are emitted as bare integers (no
 * quotes). Tests rely on this exact shape — see `buildLearnerInput.test.ts`.
 */
export function buildLearnerInput(
  payload: SubmitTurnPayload,
  openQuestionnaire: OpenQuestionnaireRecord | null,
): string {
  if (payload.kind === "chat-text") {
    return `<learner_reply>\n${sanitiseUserInput(payload.text)}\n</learner_reply>`;
  }
  if (openQuestionnaire === null) {
    throw new Error(
      "buildLearnerInput: questionnaire-answers payload without an open questionnaire",
    );
  }
  // Index the questions by id so we can validate each answer maps to a known
  // question, and look up the MC `correct` key for mechanical verdicting.
  const byId = new Map(openQuestionnaire.questions.map((q) => [q.id, q]));
  const blocks = payload.answers.map((a) => {
    const q = byId.get(a.id);
    if (!q) throw new Error(`buildLearnerInput: unknown question id '${a.id}'`);
    if (a.kind === "mc") {
      // MC answers require a `correct` key on the question — questions without
      // one are not gradeable as MC (e.g. clarify questions, which never
      // appear in the wave flow but the type permits it).
      if (q.type !== "multiple_choice" || !q.correct) {
        throw new Error(`buildLearnerInput: q '${a.id}' missing correct key`);
      }
      const selectedIdx = KEY_TO_INDEX[a.selected];
      const correctIdx = KEY_TO_INDEX[q.correct];
      const verdict = selectedIdx === correctIdx ? "correct" : "incorrect";
      return `<questionnaire_answer kind="mc-index" questionId="${escapeXmlText(a.id)}" selected_index=${selectedIdx} correct_index=${correctIdx} verdict="${verdict}"/>`;
    }
    // Free-text branch (includes MC-escape free-text). `fromEscape` flags the
    // latter so the model knows the learner deliberately bypassed the buttons.
    // A typed answer to an MC question also carries the answer key: the
    // question type is server truth, so it gates the key, not `fromEscape`.
    return [
      `<questionnaire_answer kind="free-text" questionId="${escapeXmlText(a.id)}" fromEscape="${a.fromEscape}">`,
      sanitiseUserInput(a.text),
      ...(q.type === "multiple_choice" ? [renderMcAnswerKey(q)] : []),
      "</questionnaire_answer>",
    ].join("\n");
  });
  return [
    `<questionnaire_answers questionnaireId="${escapeXmlText(payload.questionnaireId)}">`,
    ...blocks,
    "</questionnaire_answers>",
  ].join("\n");
}

/**
 * The Harness's answer key for a typed answer to an MC question (issue #149):
 * the four options, the correct key, and the rule to grade against it. The
 * MC rubric is unchecked, so the grader cannot rely on it. Built after submit,
 * this block reaches only the model's Context, never `chat_log` or the client.
 */
function renderMcAnswerKey(q: OpenQuestionnaireRecord["questions"][number]): string {
  // Wave MC questions always carry both (the quiz tool's schema requires
  // them); the record type leaves them optional. Fail loud like the MC branch.
  if (!q.options || !q.correct) {
    throw new Error(`buildLearnerInput: MC q '${q.id}' missing options or correct key`);
  }
  const { options, correct } = q;
  return [
    `<mc_answer_key correct="${correct}">`,
    // Options are model-authored, so they are escaped like any other text.
    ...MC_OPTION_KEYS.map((key) => `${key}: ${escapeXmlText(options[key])}`),
    typedMcGradingRule(correct),
    "</mc_answer_key>",
  ].join("\n");
}
