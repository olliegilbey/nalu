import type { QualityScore } from "@/lib/types/spaced-repetition";

/**
 * The model's grade for one question the learner answered last turn.
 * `recordComprehensionSignals` stages it from a flat tool input
 * (`src/lib/course/waveTurnTools.ts`); `persistWaveMidTurn` grades from it.
 *
 * A plain type, not a Zod schema: the flat tool input schema is the trust
 * boundary that parses. Nothing parses this shape (issue #119).
 *
 * Discriminated by answer kind, not card kind: an MC question answered via
 * the free-text escape is graded as free-text, because the model evaluates
 * the learner's text (spec §4.3 rationale). For a typed MC answer the
 * envelope also carries the Harness's answer key: the options and the
 * correct key (issue #149).
 *
 * Nothing on this path ties `qualityScore` to the `verdict` band. The close
 * turn's schema enforces that band (`closeTurn.ts`).
 */
export type ComprehensionSignal =
  | {
      /** The learner clicked an option. The Harness grades the click itself, so no verdict. */
      kind: "mc-index";
      /** Raw question id the model saw in the prompt. */
      questionId: string;
      /** Two sentences: what the click shows, then what to teach next. */
      rationale: string;
    }
  | {
      /** The learner typed an answer, so the model judges it. */
      kind: "free-text";
      /** Raw question id the model saw in the prompt. */
      questionId: string;
      /** The model's judgement of the learner's text. */
      verdict: "correct" | "partial" | "incorrect";
      /** 0-5. Drives the answer's XP (`calculateXP`). */
      qualityScore: QualityScore;
      /** Two sentences: why this verdict, then what to teach next. */
      rationale: string;
    };
