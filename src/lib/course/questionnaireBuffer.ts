import { z } from "zod";

/** Per-question state restored from a persisted questionnaire buffer. */
export interface QuestionnaireBuffer {
  /** Recorded answers, indexed by question; `null` for an unanswered question. */
  readonly answers: readonly (string | null)[];
  /** The question index the learner was last on. */
  readonly questionIndex: number;
  /** Per-question free-text drafts, indexed by question. */
  readonly drafts: readonly string[];
}

// The on-disk shape. `drafts` is optional: buffers written before the
// free-text-draft feature lack it. The question index is stored as `step`,
// its name before the glossary reserved Step for one LLM API call. Renaming
// the key would orphan every buffer already saved in a learner's browser.
const bufferSchema = z.object({
  questionsKey: z.string(),
  answers: z.array(z.string().nullable()),
  step: z.number(),
  drafts: z.array(z.string()).optional(),
});

/**
 * Parse a persisted questionnaire buffer from its raw localStorage string.
 *
 * Returns the restored state only when the buffer is well-formed AND matches
 * the current question set — same `questionsKey`, same length, in-range index.
 * Returns `null` for any mismatch, malformed JSON, or `null`/empty input.
 * localStorage is an untrusted boundary, so the parse never throws.
 *
 * `drafts` is defaulted to blank strings when the persisted buffer predates
 * the free-text-draft feature.
 *
 * @param raw - The raw string from `localStorage.getItem`, or `null`.
 * @param questionsKey - Identity of the currently-active question set.
 * @param questionCount - Number of questions currently active.
 * @returns The restored buffer, or `null` if it cannot be safely restored.
 */
export function parseQuestionnaireBuffer(
  raw: string | null,
  questionsKey: string,
  questionCount: number,
): QuestionnaireBuffer | null {
  if (raw === null || raw === "") return null;

  const json = safeJsonParse(raw);
  if (json === undefined) return null;

  const parsed = bufferSchema.safeParse(json);
  if (!parsed.success) return null;

  const buffer = parsed.data;
  // Reject a buffer that belongs to a different question set or has drifted
  // out of sync with the current question count.
  if (buffer.questionsKey !== questionsKey) return null;
  if (buffer.answers.length !== questionCount) return null;
  if (buffer.step < 0 || buffer.step >= questionCount) return null;
  if (buffer.drafts && buffer.drafts.length !== questionCount) return null;

  return {
    answers: buffer.answers,
    questionIndex: buffer.step,
    drafts: buffer.drafts ?? Array.from({ length: questionCount }, () => ""),
  };
}

/**
 * The state an answer card opens with: its persisted buffer when one matches,
 * otherwise blank on the first question. Restore-or-blank is one decision, so
 * a refresh never loses the learner's answers to a later blank fill.
 */
export function restoreQuestionnaireBuffer(
  raw: string | null,
  questionsKey: string,
  questionCount: number,
): QuestionnaireBuffer {
  return (
    parseQuestionnaireBuffer(raw, questionsKey, questionCount) ?? {
      answers: Array.from({ length: questionCount }, () => null),
      questionIndex: 0,
      drafts: Array.from({ length: questionCount }, () => ""),
    }
  );
}

/** The localStorage string for a card's buffer; the inverse of {@link parseQuestionnaireBuffer}. */
export function serializeQuestionnaireBuffer(
  questionsKey: string,
  buffer: QuestionnaireBuffer,
): string {
  return JSON.stringify({
    questionsKey,
    answers: buffer.answers,
    step: buffer.questionIndex,
    drafts: buffer.drafts,
  });
}

/** `JSON.parse` that returns `undefined` instead of throwing on bad input. */
function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}
