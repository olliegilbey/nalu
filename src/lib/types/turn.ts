import type { OpenQuestionForClient } from "@/lib/course/redactQuestionnaire";

/**
 * One entry in the rendered chat scroll. Phase-agnostic: emitted by both the
 * scoping projection (`deriveTurns`) and the wave projection (`deriveWaveTurns`).
 *
 * The active questionnaire is **not** a `Turn` — the Composer renders it from
 * the hook's `activeQuestionnaire` projection (see spec §4.3 / §7.4).
 *
 * Variants:
 * - `user-text` — any free-text user message (topic, clarify answers, wave chat).
 * - `assistant-text` — plain assistant prose (clarify intro, baseline intro/close,
 *   wave teaching prose with no questionnaire).
 * - `assistant-text-with-framework` — scoping framework reveal: tier ladder.
 * - `assistant-text-with-questionnaire` — wave teaching prose paired with an
 *   open questionnaire on the same assistant turn.
 * - `user-questionnaire-answers` — pretty-printed user answers to a questionnaire
 *   (clarify, baseline, or wave card-answer batch).
 * - `move-on-cta` — terminal CTA pointing at a wave by ordinal.
 */
export type Turn =
  | { readonly kind: "user-text"; readonly content: string }
  | { readonly kind: "assistant-text"; readonly content: string }
  | {
      readonly kind: "assistant-text-with-framework";
      readonly userMessage: string;
      readonly tiers: ReadonlyArray<{
        readonly number: number;
        readonly name: string;
        readonly description: string;
      }>;
    }
  | {
      readonly kind: "assistant-text-with-questionnaire";
      readonly content: string;
      readonly questionnaire: {
        readonly questions: readonly OpenQuestionForClient[];
        readonly questionnaireId: string;
      };
    }
  | { readonly kind: "user-questionnaire-answers"; readonly content: string }
  | {
      readonly kind: "move-on-cta";
      readonly next: { readonly phase: "wave"; readonly n: number };
    };
