import { encodeCorrect } from "@/lib/security/obfuscateCorrect";
import { KEY_TO_INDEX } from "./buildLearnerInput";
import type { V3Response } from "@/lib/types/jsonb";
import type { WaveChatLogEntry } from "@/lib/types/jsonbWaveChatLog";

/**
 * Server → client projection of `waves.chat_log`.
 *
 * The on-disk schema stores raw MC `correct` keys (the LLM-facing path needs
 * them for grading + envelope rendering). The wire must never carry the raw
 * key — we substitute `correctEnc` (questionId-bound base64) the same way
 * `redactQuestionnaire` does for the currently-open questionnaire. The
 * substitution applies to BOTH currently-open and already-answered
 * questionnaire entries — the wire is uniformly redacted; the UI never sees
 * plaintext `correct`.
 *
 * Free-text branches pass through (no `correct` to hide). User-side entries
 * (text + answers) carry no secret; they pass through.
 *
 * Pure function. Single-pass map; no DB, no env. Tested in
 * `redactWaveChatLog.test.ts`.
 */

/** One client-safe question shape inside an `assistant.text_with_questionnaire`. */
export type WaveQuestionForClient =
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

/** Wire-safe projection of one `WaveChatLogEntry`. */
export type WaveChatLogEntryForClient =
  | { readonly role: "user"; readonly kind: "text"; readonly content: string }
  | {
      readonly role: "user";
      readonly kind: "answers";
      readonly questionnaireId: string;
      readonly responses: readonly V3Response[];
    }
  | { readonly role: "assistant"; readonly kind: "text"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly kind: "text_with_questionnaire";
      readonly questionnaireId: string;
      readonly content: string;
      readonly questions: readonly WaveQuestionForClient[];
    };

/**
 * Project the chat_log to its client-safe wire shape.
 *
 * Throws on an MC question missing `correct` — chat_log MC questions are
 * always LLM-graded so the field must be present. Absence indicates a corrupt
 * row or schema regression; fail loud rather than emit an unrenderable wire.
 */
export function redactWaveChatLog(
  entries: readonly WaveChatLogEntry[],
): readonly WaveChatLogEntryForClient[] {
  return entries.map((entry): WaveChatLogEntryForClient => {
    if (entry.role === "user") return entry;
    if (entry.kind === "text") return entry;

    // entry.kind === "text_with_questionnaire" — redact every MC question.
    const questions = entry.questions.map((q): WaveQuestionForClient => {
      if (q.type === "multiple_choice") {
        // The chat_log entry is the LLM-graded MC: `correct` must be set. If
        // somehow absent (corrupt row, schema regression), fail loud rather
        // than emit an unrenderable wire shape.
        if (q.correct === undefined) {
          throw new Error(`redactWaveChatLog: MC question id=${q.id} missing correct key`);
        }
        return {
          id: q.id,
          type: "multiple_choice",
          prompt: q.prompt,
          options: q.options,
          correctEnc: encodeCorrect(q.id, KEY_TO_INDEX[q.correct]),
          freetextRubric: q.freetextRubric,
        };
      }
      return {
        id: q.id,
        type: "free_text",
        prompt: q.prompt,
        freetextRubric: q.freetextRubric,
      };
    });

    return {
      role: "assistant",
      kind: "text_with_questionnaire",
      questionnaireId: entry.questionnaireId,
      content: entry.content,
      questions,
    };
  });
}
