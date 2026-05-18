import { escapeXmlText } from "@/lib/security/escapeXmlText";
import { sanitiseUserInput } from "@/lib/security/sanitiseUserInput";

/** A single answer in a questionnaire-answers submission. */
export type SubmittedAnswer =
  | { readonly id: string; readonly kind: "mc"; readonly selected: "A" | "B" | "C" | "D" }
  | {
      readonly id: string;
      readonly kind: "freetext";
      readonly text: string;
      readonly fromEscape: boolean;
    };

/** The discriminated payload `wave.submitTurn` accepts (router input type). */
export type SubmitTurnPayload =
  | { readonly kind: "chat-text"; readonly text: string }
  | {
      readonly kind: "questionnaire-answers";
      readonly questionnaireId: string;
      readonly answers: readonly SubmittedAnswer[];
    };

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
    readonly options?: {
      readonly A: string;
      readonly B: string;
      readonly C: string;
      readonly D: string;
    };
    readonly correct?: "A" | "B" | "C" | "D";
    readonly freetextRubric: string;
  }[];
}

// Stable letter→index mapping for MC keys. Mirrors the order used everywhere
// in the codebase (A=0 .. D=3). Centralised here so the envelope emits exactly
// the same numerical encoding the grading path uses.
const KEY_TO_INDEX = { A: 0, B: 1, C: 2, D: 3 } as const;

/**
 * Compose the per-turn `learnerInput` envelope body.
 *
 * `chat-text` wraps the learner's free-text in `<learner_reply>` (sanitised).
 *
 * `questionnaire-answers` emits one `<questionnaire_answer>` block per answer
 * discriminated by answer kind. MC blocks carry the learner's selected index,
 * mechanical verdict, and the correct index (so the model sees server truth
 * without re-asking). Free-text blocks carry the learner's prose plus a
 * `fromEscape` flag.
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
    return [
      `<questionnaire_answer kind="free-text" questionId="${escapeXmlText(a.id)}" fromEscape="${a.fromEscape}">`,
      sanitiseUserInput(a.text),
      "</questionnaire_answer>",
    ].join("\n");
  });
  return [
    `<questionnaire_answers questionnaireId="${escapeXmlText(payload.questionnaireId)}">`,
    ...blocks,
    "</questionnaire_answers>",
  ].join("\n");
}
