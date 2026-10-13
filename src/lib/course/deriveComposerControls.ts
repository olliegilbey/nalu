import type { ChoiceQuestion } from "./adaptQuestionnaire";

/** The Composer state its controls depend on. */
export interface ComposerControlsInput {
  /** The answer card's questions; `null`, absent or empty means the plain chat input. */
  readonly questions: readonly ChoiceQuestion[] | null | undefined;
  readonly questionIndex: number;
  /** Recorded answers, indexed by question; `null` while unanswered. */
  readonly answers: readonly (string | null)[];
  /** Free-text drafts, indexed by question. */
  readonly drafts: readonly string[];
  /** The option picked but not yet confirmed, indexed by question. */
  readonly pending: readonly (number | null)[];
  /** The parent-owned chat-input text. */
  readonly chatValue: string;
  readonly disabled: boolean | undefined;
  /** The card's buffer key. A card without one is a streaming preview. */
  readonly persistKey: string | undefined;
}

/** Which Composer controls show, and which are enabled, for one render. */
export interface ComposerControls {
  /** True while an answer card replaces the plain chat input. */
  readonly hasQuestions: boolean;
  /** The question on screen; `null` without a card. */
  readonly current: ChoiceQuestion | null;
  readonly total: number;
  /** The textarea's text: the current question's draft, or the chat input. */
  readonly inputValue: string;
  /** The current question's unconfirmed option pick, if any. */
  readonly currentPending: number | null;
  /** The current question has a recorded answer, so its pick can no longer change. */
  readonly answerLocked: boolean;
  /** Send confirms the pending MC pick instead of sending text. */
  readonly confirmMode: boolean;
  readonly canSend: boolean;
  /** The textarea is disabled: a recorded MC answer. Free text stays editable. */
  readonly textareaLocked: boolean;
  /** A keyless card is a Wave's streaming preview: read-only. */
  readonly isPreview: boolean;
  readonly canGoPrev: boolean;
  readonly canGoNext: boolean;
}

/**
 * Derive the Composer's control states from its answer-card state. Pure.
 *
 * Every card flag is guarded by `hasQuestions`: the card state outlives the
 * card, so the plain chat input must ignore what the last card left behind.
 */
export function deriveComposerControls(input: ComposerControlsInput): ComposerControls {
  const { questions, questionIndex } = input;
  const hasQuestions = !!questions && questions.length > 0;
  const current = hasQuestions ? (questions[questionIndex] ?? null) : null;
  const total = hasQuestions ? questions.length : 0;
  // One textarea serves both modes. A card keeps a draft per question, so
  // free text survives navigation; otherwise the parent owns the text.
  const inputValue = hasQuestions ? (input.drafts[questionIndex] ?? "") : input.chatValue;
  const hasText = inputValue.trim().length > 0;

  const currentPending = hasQuestions ? (input.pending[questionIndex] ?? null) : null;
  const answerLocked = hasQuestions && input.answers[questionIndex] != null;
  // A free-text question (no options) never locks its textarea — its answer
  // stays editable on revisit. MC questions lock on confirm.
  const currentIsFreeText = !!current && current.options.length === 0;

  return {
    hasQuestions,
    current,
    total,
    inputValue,
    currentPending,
    answerLocked,
    // An option is picked, nothing is typed, and the question is still open.
    confirmMode: hasQuestions && currentPending != null && !answerLocked && !hasText,
    canSend: hasText && !input.disabled,
    textareaLocked: answerLocked && !currentIsFreeText,
    // A card with no buffer key is a Wave's streaming preview: no questionnaire
    // id yet. Its commit brings a key and re-inits the card, which would wipe
    // a draft typed into the preview (#118).
    isPreview: hasQuestions && !input.persistKey,
    canGoPrev: hasQuestions && questionIndex > 0,
    canGoNext: hasQuestions && questionIndex < total - 1,
  };
}
