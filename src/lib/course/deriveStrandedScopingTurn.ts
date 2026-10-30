import type { CourseState } from "./getState";
import type { ShapedClarifyAnswer } from "./shapeClarifyAnswers";
import type { QuestionnaireAnswer } from "@/lib/types/questionnaireAnswer";
import type { V3Response } from "@/lib/types/jsonb";

/**
 * A scoping Turn whose learner answers the server saved, but whose model reply
 * never landed. Carries the saved answers in the procedure's wire shape, so a
 * Retry can re-send them.
 */
export type StrandedScopingTurn =
  | { readonly kind: "framework"; readonly responses: readonly ShapedClarifyAnswer[] }
  | { readonly kind: "scopingClose"; readonly answers: readonly QuestionnaireAnswer[] };

/**
 * Find the scoping Turn a reload would strand (issue #103), from server state alone.
 *
 * `generateFramework` and `submitBaseline` save the learner's answers before the
 * LLM call. Saved answers with no model output after them mean that Turn failed.
 * Its question card does not come back, because the card shows only while no
 * answers are saved. So the caller offers a Retry that re-sends the saved
 * answers. Both procedures replay idempotently, so a re-send is safe.
 *
 * The same state also holds while the Turn is still in flight. The caller must
 * skip this check while it has a Turn pending.
 *
 * The baseline Turn needs no entry here: it takes no learner input, and the
 * hook re-fires it on mount.
 */
export function deriveStrandedScopingTurn(state: CourseState): StrandedScopingTurn | null {
  // An active course has closed scoping; nothing is stranded.
  if (state.status !== "scoping") return null;
  const { clarification, framework, baseline } = state;

  if (clarification && clarification.responses.length > 0 && framework === null) {
    return {
      kind: "framework",
      responses: clarification.responses.map((r) => ({
        questionId: r.questionId,
        freetext: requireFreetext(r),
      })),
    };
  }

  // Status 'scoping' means the baseline is still the pre-close shape
  // (`getState` and `persistScopingClose` hold that invariant).
  if (baseline && baseline.responses.length > 0) {
    const mcIds = new Set(
      baseline.questions.filter((q) => q.type === "multiple_choice").map((q) => q.id),
    );
    return {
      kind: "scopingClose",
      answers: baseline.responses.map((r): QuestionnaireAnswer => {
        if (r.choice !== undefined) {
          return { id: r.questionId, kind: "mc", selected: r.choice };
        }
        return {
          id: r.questionId,
          kind: "freetext",
          text: requireFreetext(r),
          // Typed text on an MC question came through the free-text escape.
          // Mirrors `shapeQuestionnaireAnswers`, which built the original send.
          fromEscape: mcIds.has(r.questionId),
        };
      }),
    };
  }

  return null;
}

/** The response's free text. A saved response holds a choice or free text, never neither. */
function requireFreetext(r: V3Response): string {
  if (r.freetext === undefined) {
    throw new Error(
      `deriveStrandedScopingTurn: saved response ${r.questionId} has no free text to re-send`,
    );
  }
  return r.freetext;
}
