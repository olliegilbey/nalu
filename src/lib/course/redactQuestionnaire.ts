/**
 * Client-safe projection type for a single open question.
 *
 * Historically this module also exported `redactQuestionnaire`, the
 * server→client chokepoint that stripped the raw `correct` key off MC
 * questions before they hit the wire. That projection now lives inside
 * `redactWaveChatLog.ts` (chat_log is the canonical wire shape for waves),
 * and clarify/baseline never emitted a `correct` key in the first place.
 *
 * The `OpenQuestionForClient` type is still consumed by `adaptQuestionnaire`
 * (`adaptOpenQuestion` adapts it for the Composer) and `src/lib/types/turn.ts`,
 * so it remains here. Move it if a more natural home appears.
 */
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
