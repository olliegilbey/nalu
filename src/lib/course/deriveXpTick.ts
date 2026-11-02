import type { QuestionnaireAnswer } from "@/lib/types/questionnaireAnswer";

/** What one new server total does to the header XP badge. */
export type XpTick = { readonly pulse: true; readonly gain: number } | { readonly pulse: false };

/**
 * Decide whether the badge ticks when the server total moves. Pure.
 *
 * The badge shows the server's course total; the client computes no XP.
 * Only a rise pulses, and the gain is the difference. `previous` is
 * undefined for the first total after mount: a reload or a new page shows
 * the stored total, which the learner did not just earn. An equal total is
 * the refetch repeating the turn result. A drop never pulses.
 */
export function deriveXpTick(previous: number | undefined, next: number): XpTick {
  if (previous === undefined || next <= previous) return { pulse: false };
  return { pulse: true, gain: next - previous };
}

/**
 * Whether a submitted card held a typed answer. Pure.
 *
 * The scoping close returns no per-answer grading, so a typed baseline
 * answer's sound plays on the tick when the card held one. A tapped MC pick
 * already played its sound at confirm, so an all-MC card ticks silently.
 */
export function holdsTypedAnswer(answers: readonly QuestionnaireAnswer[]): boolean {
  return answers.some((answer) => answer.kind === "freetext");
}
