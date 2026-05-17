/**
 * One entry in the rendered chat scroll. Derived from a `courses` row by
 * `deriveTurns`; never mutated by the client.
 *
 * The active questionnaire is **not** a `Turn` — the Composer renders it from
 * `useScopingState.activeQuestionnaire` (see spec §4.3).
 */
export type Turn =
  | { readonly kind: "user-topic"; readonly content: string }
  | { readonly kind: "llm-clarify-intro"; readonly content: string }
  | { readonly kind: "user-clarify-answers"; readonly content: string }
  | {
      readonly kind: "llm-framework";
      readonly userMessage: string;
      readonly tiers: ReadonlyArray<{
        readonly number: number;
        readonly name: string;
        readonly description: string;
      }>;
    }
  | { readonly kind: "llm-baseline-intro"; readonly content: string }
  | { readonly kind: "user-baseline-answers"; readonly content: string }
  | { readonly kind: "llm-baseline-close"; readonly content: string }
  | { readonly kind: "move-on-cta"; readonly nextWaveNumber: number };
