import type { ChatEntry } from "@/lib/types/chatEntry";
import type { CourseState } from "./getState";
import type { V3Question, V3Response } from "@/lib/types/jsonb";

/**
 * Project a `CourseState` to the chat scroll `ChatEntry[]`.
 *
 * Deterministic and pure. Each downstream entry depends on the presence of a
 * specific JSONB column on the row, in this order:
 *
 *   topic → clarification → (clarify responses present → framework) → baseline
 *   → (scopingResult present → close + move-on-cta)
 *
 * The active questionnaire (clarify or baseline) is not an entry — the Composer
 * renders it separately from `useScopingState.activeQuestionnaire`.
 */
export function deriveChatEntries(state: CourseState): readonly ChatEntry[] {
  const chatEntries: ChatEntry[] = [{ kind: "user-text", content: state.topic }];

  if (state.clarification) {
    chatEntries.push({ kind: "assistant-text", content: state.clarification.userMessage });
  }

  // Once the framework lands, clarify responses are guaranteed to be saved
  // (generateFramework persists them before calling the LLM — see
  // src/lib/course/generateFramework.ts:82-92). Emit the user-questionnaire-answers
  // entry from the persisted responses so a reload renders identically.
  if (state.framework && state.clarification) {
    chatEntries.push({
      kind: "user-questionnaire-answers",
      content: formatAnswers(state.clarification.questions, state.clarification.responses),
    });
    chatEntries.push({
      kind: "assistant-text-with-framework",
      userMessage: state.framework.userMessage,
      tiers: state.framework.tiers.map((t) => ({
        number: t.number,
        name: t.name,
        description: t.description,
      })),
    });
  }

  if (state.baseline) {
    chatEntries.push({ kind: "assistant-text", content: state.baseline.userMessage });
  }

  if (state.scopingResult && state.baseline) {
    chatEntries.push({
      kind: "user-questionnaire-answers",
      content: formatAnswers(state.baseline.questions, state.baseline.responses),
    });
    chatEntries.push({ kind: "assistant-text", content: state.scopingResult.closingMessage });
    chatEntries.push({ kind: "move-on-cta", next: { phase: "wave", n: 1 } });
  }

  return chatEntries;
}

/**
 * Format a `(questions, responses)` pair as a numbered prose list.
 *
 * Shared by scoping clarify, scoping baseline, and wave questionnaire answers.
 * MC responses (`r.choice`) render as the chosen option's text; free-text
 * responses (`r.freetext`) render verbatim. Missing question lookups fall back
 * to `Q{n}` so a corrupted response list still produces readable output rather
 * than a crash.
 *
 * Exported (and renamed from the prior `concatBaselineAnswers`) so wave's
 * `deriveWaveChatEntries` can reuse it. Clarify's prior dedicated helper
 * (`concatClarifyAnswers`) is deleted; clarify responses never carry `choice`
 * so the baseline-shaped formatter handles them identically.
 */
export function formatAnswers(
  questions: readonly V3Question[],
  responses: readonly V3Response[],
): string {
  const byId = new Map(questions.map((q) => [q.id, q]));
  return responses
    .map((r, i) => {
      const q = byId.get(r.questionId);
      const prompt = q?.prompt ?? `Q${i + 1}`;
      const answer =
        r.choice !== undefined
          ? q && q.type === "multiple_choice"
            ? q.options[r.choice]
            : r.choice
          : (r.freetext ?? "");
      return `${i + 1}. ${prompt} — ${answer}`;
    })
    .join("\n");
}
