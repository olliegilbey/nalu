import type { Turn } from "@/lib/types/turn";
import type { CourseState } from "./getState";
import type { ClarificationJsonb, BaselineJsonb } from "@/lib/types/jsonb";

/**
 * Project a `CourseState` to the chat scroll `Turn[]`.
 *
 * Deterministic and pure. Each downstream turn depends on the presence of a
 * specific JSONB column on the row, in this order:
 *
 *   topic → clarification → (clarify responses present → framework) → baseline
 *   → (scopingResult present → close + move-on-cta)
 *
 * The active questionnaire (clarify or baseline) is not a turn — the Composer
 * renders it separately from `useScopingState.activeQuestionnaire`.
 */
export function deriveTurns(state: CourseState): readonly Turn[] {
  const turns: Turn[] = [{ kind: "user-topic", content: state.topic }];

  if (state.clarification) {
    turns.push({ kind: "llm-clarify-intro", content: state.clarification.userMessage });
  }

  // Once the framework lands, clarify responses are guaranteed to be saved
  // (generateFramework persists them before calling the LLM — see
  // src/lib/course/generateFramework.ts:86-92). Emit the user-clarify-answers
  // turn from the persisted responses so a reload renders identically.
  if (state.framework && state.clarification) {
    turns.push({
      kind: "user-clarify-answers",
      content: concatClarifyAnswers(state.clarification),
    });
    turns.push({
      kind: "llm-framework",
      userMessage: state.framework.userMessage,
      tiers: state.framework.tiers.map((t) => ({
        number: t.number,
        name: t.name,
        description: t.description,
      })),
    });
  }

  if (state.baseline) {
    turns.push({ kind: "llm-baseline-intro", content: state.baseline.userMessage });
  }

  if (state.scopingResult && state.baseline) {
    turns.push({
      kind: "user-baseline-answers",
      content: concatBaselineAnswers(state.baseline),
    });
    turns.push({ kind: "llm-baseline-close", content: state.scopingResult.closingMessage });
    turns.push({ kind: "move-on-cta", nextWaveNumber: 1 });
  }

  return turns;
}

function concatClarifyAnswers(c: ClarificationJsonb): string {
  const byId = new Map(c.questions.map((q) => [q.id, q]));
  return c.responses
    .map((r, i) => {
      const q = byId.get(r.questionId);
      const prompt = q?.prompt ?? `Q${i + 1}`;
      return `${i + 1}. ${prompt} — ${r.freetext ?? ""}`;
    })
    .join("\n");
}

function concatBaselineAnswers(b: BaselineJsonb): string {
  const byId = new Map(b.questions.map((q) => [q.id, q]));
  return b.responses
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
