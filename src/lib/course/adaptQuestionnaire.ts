import type { Question, McOptionKey } from "@/lib/prompts/questionnaire";
import type { OpenQuestionForClient } from "./redactQuestionnaire";
import { decodeCorrect } from "@/lib/security/obfuscateCorrect";

/** Whispers Composer's question shape. Kept in sync with the upstream type. */
export interface ChoiceQuestion {
  readonly id: string;
  readonly prompt: string;
  /** Empty array means free-text-only. */
  readonly options: readonly string[];
  readonly correctIndex?: number;
}

const KEY_TO_INDEX: Record<McOptionKey, number> = { A: 0, B: 1, C: 2, D: 3 };

export interface AdaptedQuestionnaire {
  readonly mode: "mc" | "free-text" | "mixed";
  readonly questions: readonly ChoiceQuestion[];
}

/**
 * Adapt a Nalu `Question[]` to the whispers Composer's `ChoiceQuestion[]`.
 *
 * - `multiple_choice` → options materialised as a 4-element string array in
 *   A,B,C,D order; `correct` letter (if present) becomes `correctIndex`.
 * - `free_text` → `options: []`. The Composer's pure-free-text branch
 *   renders the textarea instead of the option grid for these.
 *
 * Mode is informational for the caller; the Composer doesn't strictly need it
 * (it inspects `options.length === 0` per question) but `useScopingState`
 * uses it to decide whether to render the MC `chooseLabel` header.
 */
export function adaptQuestionnaire(qs: readonly Question[]): AdaptedQuestionnaire {
  const questions = qs.map((q): ChoiceQuestion => {
    if (q.type === "multiple_choice") {
      return {
        id: q.id,
        prompt: q.prompt,
        options: [q.options.A, q.options.B, q.options.C, q.options.D],
        correctIndex: q.correct !== undefined ? KEY_TO_INDEX[q.correct] : undefined,
      };
    }
    return { id: q.id, prompt: q.prompt, options: [] };
  });

  const hasMc = qs.some((q) => q.type === "multiple_choice");
  const hasFree = qs.some((q) => q.type === "free_text");
  const mode: AdaptedQuestionnaire["mode"] =
    hasMc && hasFree ? "mixed" : hasMc ? "mc" : "free-text";

  return { mode, questions };
}

/**
 * Adapt a client-side `OpenQuestionForClient` (wave-flow questionnaire, with
 * obfuscated `correctEnc` rather than plaintext `correct`) to the Composer's
 * `ChoiceQuestion`.
 *
 * MC branch: decodes the `correctEnc` via `decodeCorrect(id, correctEnc)` —
 * the encoding is bound to the question id (spec §7.8) so the Composer can
 * render the instant-feedback toast locally without round-tripping. A failed
 * decode (`null`) leaves `correctIndex` undefined; the Composer treats that
 * as "no toast, ask the server" — server-side grading is still authoritative.
 *
 * Free-text branch: `options: []`, no `correctIndex` — the Composer renders
 * the textarea path.
 *
 * The discriminated union (`OpenQuestionForClient`) guarantees MC questions
 * carry `options` + `correctEnc`, so no extra truthy guards are needed.
 */
export function adaptOpenQuestion(q: OpenQuestionForClient): ChoiceQuestion {
  if (q.type === "multiple_choice") {
    const decoded = decodeCorrect(q.id, q.correctEnc);
    return {
      id: q.id,
      prompt: q.prompt,
      options: [q.options.A, q.options.B, q.options.C, q.options.D],
      correctIndex: decoded ?? undefined,
    };
  }
  return { id: q.id, prompt: q.prompt, options: [] };
}
