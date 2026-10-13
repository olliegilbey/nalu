import type { Question, McOptionKey } from "@/lib/prompts/questionnaire";
import type { OpenQuestionForClient } from "./redactQuestionnaire";
import { decodeCorrect } from "@/lib/security/obfuscateCorrect";

/** The Composer's question shape: one card question, MC or free text. */
export interface ChoiceQuestion {
  readonly id: string;
  readonly prompt: string;
  /** Empty array means free-text-only. */
  readonly options: readonly string[];
  readonly correctIndex?: number;
  /** Concept tier — drives client-side `calculateMcXp` for correct MC answers. */
  readonly tier?: number;
}

/**
 * Composer binding for the open questionnaire, in scoping and in a Wave.
 *
 * `kind` is an informational tag; nothing switches on it exhaustively.
 */
export interface ActiveQuestionnaire {
  readonly kind: "clarify" | "baseline" | "wave";
  readonly questions: readonly ChoiceQuestion[];
  /** Stable identity for the active question set — the screens' dismiss key. The Composer keys on question ids + `persistKey`. */
  readonly questionsKey: string;
  /**
   * localStorage key for the Composer's refresh-resilient draft buffer, one per
   * questionnaire: `nalu:scoping:{courseId}:{stage}` or `nalu:wave:{waveId}:q:{questionnaireId}`.
   */
  readonly persistKey: string;
}

const KEY_TO_INDEX: Record<McOptionKey, number> = { A: 0, B: 1, C: 2, D: 3 };

/** Three-way MC feedback: "correct" | "wrong", or null for ungraded (no correctIndex) questions. */
export function deriveMcFeedback(
  correctIndex: number | undefined,
  selectedIndex: number,
): "correct" | "wrong" | null {
  if (correctIndex === undefined) return null;
  return selectedIndex === correctIndex ? "correct" : "wrong";
}

/**
 * Adapt a Nalu `Question[]` to the Composer's `ChoiceQuestion[]`.
 *
 * - `multiple_choice` → options materialised as a 4-element string array in
 *   A,B,C,D order; `correct` letter (if present) becomes `correctIndex`.
 * - `free_text` → `options: []`. The Composer's pure-free-text branch
 *   renders the textarea instead of the option grid for these.
 */
export function adaptQuestionnaire(qs: readonly Question[]): readonly ChoiceQuestion[] {
  return qs.map((q): ChoiceQuestion => {
    if (q.type === "multiple_choice") {
      return {
        id: q.id,
        prompt: q.prompt,
        options: [q.options.A, q.options.B, q.options.C, q.options.D],
        correctIndex: q.correct !== undefined ? KEY_TO_INDEX[q.correct] : undefined,
        // Carried through so the Composer's `calculateMcXp` can award exact XP
        // for a correct MC answer — including in the scoping baseline flow.
        tier: q.tier,
      };
    }
    return { id: q.id, prompt: q.prompt, options: [], tier: q.tier };
  });
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
      tier: q.tier,
    };
  }
  return { id: q.id, prompt: q.prompt, options: [], tier: q.tier };
}

/**
 * Streamed `tool-presentQuestionnaire` part question as it reaches the
 * client: the server allowlist-redacts grading keys (`correct`,
 * `freetextRubric`) before forwarding (`streamWaveTurn`), so this is a
 * strict subset of the tool's input shape.
 */
export interface StreamedToolQuestion {
  readonly id: string;
  readonly type: "multiple_choice" | "free_text";
  readonly prompt: string;
  readonly options?: {
    readonly A: string;
    readonly B: string;
    readonly C: string;
    readonly D: string;
  };
  readonly tier?: number;
}

/**
 * Adapt a streamed (redacted) tool-part question to the Composer's shape.
 * No `correctIndex` on purpose: the streamed preview is non-interactive, and
 * instant MC feedback comes only with the committed card's `correctEnc`
 * (`adaptOpenQuestion`) after the turn result lands.
 */
export function adaptStreamedToolQuestion(q: StreamedToolQuestion): ChoiceQuestion {
  if (q.type === "multiple_choice" && q.options) {
    return {
      id: q.id,
      prompt: q.prompt,
      options: [q.options.A, q.options.B, q.options.C, q.options.D],
      tier: q.tier,
    };
  }
  return { id: q.id, prompt: q.prompt, options: [], tier: q.tier };
}
