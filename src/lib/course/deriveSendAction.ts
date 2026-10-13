import type { ChoiceQuestion } from "./adaptQuestionnaire";
import type { ComposerControls } from "./deriveComposerControls";
import { isTypedCorrectMcAnswer } from "./deriveMcXpAward";

/** The control states Send depends on. */
export type SendControls = Pick<
  ComposerControls,
  "hasQuestions" | "current" | "inputValue" | "confirmMode" | "canSend"
>;

/** What one press of Send (or Enter) does. */
export type SendAction =
  | { readonly kind: "ignore" }
  /** Lock in the pending MC pick. */
  | { readonly kind: "confirm" }
  /** Send the parent's chat message. */
  | { readonly kind: "chat" }
  /** Record typed text as the current question's answer. */
  | {
      readonly kind: "answer";
      readonly answer: string;
      /** The question whose MC XP this answer earns; `null` when it earns none. */
      readonly earnsMcXpFor: ChoiceQuestion | null;
    };

/**
 * Decide what Send does: confirm a pick, answer with typed text, send chat,
 * or nothing. Pure; the hook dispatches the result.
 *
 * Confirm mode is checked before `canSend`: nothing is typed in confirm mode,
 * so `canSend` is false there. `disabled` blocks both: `canSend` already folds
 * it in, confirm mode does not.
 */
export function deriveSendAction(
  controls: SendControls,
  disabled: boolean | undefined,
): SendAction {
  if (disabled) return { kind: "ignore" };
  if (controls.confirmMode) return { kind: "confirm" };
  if (!controls.canSend) return { kind: "ignore" };
  if (!controls.hasQuestions) return { kind: "chat" };
  const answer = controls.inputValue.trim();
  const { current } = controls;
  return {
    kind: "answer",
    answer,
    // Typed text naming the correct option verbatim ships as MC; the turn
    // result skips MC XP, so the Composer awards it here, as Confirm would (#18).
    earnsMcXpFor: current && isTypedCorrectMcAnswer(current, answer) ? current : null,
  };
}
