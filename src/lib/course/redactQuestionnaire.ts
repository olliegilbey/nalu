import { encodeCorrect } from "@/lib/security/obfuscateCorrect";
import { KEY_TO_INDEX, type OpenQuestionnaireRecord } from "./buildLearnerInput";

/**
 * Server → client chokepoint for the open-questionnaire shape.
 *
 * The server's `OpenQuestionnaireRecord` carries the raw `correct` key on each
 * MC question — that letter is the answer. We must never put it on the wire.
 * This function projects to the client-safe shape: `correct` is dropped and
 * replaced by `correctEnc` (a base64-obfuscated, questionId-bound encoding —
 * spec §7.8 / `obfuscateCorrect.ts`). The server retains truth in the
 * persisted `assistant_response` row and re-derives correctness mechanically
 * on the next turn; the client only uses `correctEnc` to render the instant
 * feedback toast.
 *
 * Free-text questions are projected through unchanged (they have no `correct`
 * key). `freetextRubric` is preserved on both branches — the client uses it
 * to render partial-credit nudges (see plan §13).
 */

/** Client-safe projection of a single open question. */
export type OpenQuestionForClient =
  | {
      readonly id: string;
      readonly type: "multiple_choice";
      readonly prompt: string;
      readonly options: {
        readonly A: string;
        readonly B: string;
        readonly C: string;
        readonly D: string;
      };
      /** Base64-obfuscated correct index, bound to `id`. NOT cryptographic. */
      readonly correctEnc: string;
      readonly freetextRubric: string;
    }
  | {
      readonly id: string;
      readonly type: "free_text";
      readonly prompt: string;
      readonly freetextRubric: string;
    };

/** Client-safe projection of an open questionnaire (the full shape `getWaveState` emits). */
export interface OpenQuestionnaireForClient {
  readonly questionnaireId: string;
  readonly questions: readonly OpenQuestionForClient[];
}

/**
 * Project an `OpenQuestionnaireRecord` to the client-safe shape.
 *
 * Throws on an MC question missing `correct` or `options` — the
 * `OpenQuestionnaireRecord` type permits absence (the union accommodates
 * clarify-style questions in unrelated code paths), but a wave questionnaire
 * MC without those fields is unrenderable on the client. Fail loud rather
 * than emit a half-broken projection.
 */
export function redactQuestionnaire(open: OpenQuestionnaireRecord): OpenQuestionnaireForClient {
  // Per-branch construction keeps the discriminated-union narrowing through
  // `.map` — widening to a uniform shape inside the closure would lose the
  // per-branch invariants the client relies on (MC has options+correctEnc;
  // free_text has neither).
  const questions: readonly OpenQuestionForClient[] = open.questions.map((q) => {
    if (q.type === "multiple_choice") {
      // Defensive guards: a wave MC question must carry both `correct` and
      // `options`. `OpenQuestionnaireRecord` permits absence at the type level
      // (it's the same shape clarify uses), but the wave path never produces
      // an MC without them — fail loud if that invariant breaks.
      if (q.correct === undefined) {
        throw new Error(`redactQuestionnaire: MC question id=${q.id} missing correct key`);
      }
      if (q.options === undefined) {
        throw new Error(`redactQuestionnaire: MC question id=${q.id} missing options`);
      }
      return {
        id: q.id,
        type: "multiple_choice" as const,
        prompt: q.prompt,
        options: q.options,
        // Bind the encoded index to the question id so a determined cheater
        // cannot replay encodings across questions (encodeCorrect docs §7.8).
        correctEnc: encodeCorrect(q.id, KEY_TO_INDEX[q.correct]),
        freetextRubric: q.freetextRubric,
      };
    }
    return {
      id: q.id,
      type: "free_text" as const,
      prompt: q.prompt,
      freetextRubric: q.freetextRubric,
    };
  });
  return {
    questionnaireId: open.questionnaireId,
    questions,
  };
}
