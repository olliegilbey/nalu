import { MC_OPTION_KEYS, type McOptions } from "@/lib/types/mcOptionKey";
import type { QuestionForClient } from "./redactQuestionnaire";
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

/** Three-way MC feedback: "correct" | "wrong", or null for ungraded (no correctIndex) questions. */
export function deriveMcFeedback(
  correctIndex: number | undefined,
  selectedIndex: number,
): "correct" | "wrong" | null {
  if (correctIndex === undefined) return null;
  return selectedIndex === correctIndex ? "correct" : "wrong";
}

/**
 * Adapt one question of the open card, scoping or Wave, to the Composer's
 * `ChoiceQuestion`. The server sends `QuestionForClient`: an obfuscated
 * `correctEnc` rather than a plaintext `correct`.
 *
 * MC branch: options materialise as a string array in `MC_OPTION_KEYS` order.
 * `decodeCorrect(id, correctEnc)` recovers the correct index. The encoding is
 * bound to the question id (spec §7.8), so the Composer can render the
 * instant-feedback toast locally without round-tripping. An ungraded MC
 * question (clarify) has no `correctEnc`; a failed decode returns `null`. Both
 * leave `correctIndex` undefined, and the Composer shows no verdict; server
 * grading stays authoritative. `tier` carries through for `calculateMcXp`.
 *
 * Free-text branch: `options: []`, no `correctIndex` — the Composer renders
 * the textarea path.
 */
export function adaptOpenQuestion(q: QuestionForClient): ChoiceQuestion {
  if (q.type === "multiple_choice") {
    const decoded = q.correctEnc === undefined ? null : decodeCorrect(q.id, q.correctEnc);
    return {
      id: q.id,
      prompt: q.prompt,
      options: MC_OPTION_KEYS.map((key) => q.options[key]),
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
  readonly options?: McOptions;
  readonly tier?: number;
}

/**
 * Adapt a streamed (redacted) tool-part question to the Composer's shape.
 * No `correctIndex` on purpose: the streamed preview is non-interactive, and
 * instant MC feedback comes only with the committed card's `correctEnc`
 * (`adaptOpenQuestion`) after the turn result lands.
 */
export function adaptStreamedToolQuestion(q: StreamedToolQuestion): ChoiceQuestion {
  // A local const keeps the narrowing inside the `map` callback.
  const { options } = q;
  if (q.type === "multiple_choice" && options) {
    return {
      id: q.id,
      prompt: q.prompt,
      options: MC_OPTION_KEYS.map((key) => options[key]),
      tier: q.tier,
    };
  }
  return { id: q.id, prompt: q.prompt, options: [], tier: q.tier };
}
