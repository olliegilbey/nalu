import { TRPCError } from "@trpc/server";
import { getCourseById } from "@/db/queries/courses";
import { getMessagesForWave } from "@/db/queries/contextMessages";
import { getWaveById } from "@/db/queries/waves";
import { waveMidTurnSchema } from "@/lib/prompts/waveTurn";
import type { Course, Wave } from "@/db/schema";
import type { OpenQuestionnaireRecord } from "./buildLearnerInput";

/**
 * One round-trip fetch of everything `submitWaveTurn` needs:
 *   - Course (with ownership check via `getCourseById`)
 *   - Wave by id, cross-checked to belong to the course
 *   - Open questionnaire reconstructed from the latest `assistant_response`
 *     row's `WaveMidTurn` JSON, if any
 *
 * Why no separate "questionnaire" DB entity? Questionnaires live inside the
 * model's `assistant_response` JSON (validated against `waveMidTurnSchema`).
 * The context_messages row is the canonical source; we reconstruct on demand.
 */
export interface LoadedWaveContext {
  readonly course: Course;
  readonly wave: Wave;
  readonly openQuestionnaire: OpenQuestionnaireRecord | null;
}

/**
 * Load the (course, wave, optional open questionnaire) triple for a wave-turn
 * submission. Throws TRPCError on ownership / containment violations so callers
 * can surface them directly through the tRPC error pipeline.
 */
export async function loadWaveContext(params: {
  readonly userId: string;
  readonly courseId: string;
  readonly waveId: string;
}): Promise<LoadedWaveContext> {
  // Ownership is enforced inside getCourseById: a course owned by a different
  // user is reported as NOT_FOUND (info-leak-safe).
  const course = await getCourseById(params.courseId, params.userId);
  const wave = await getWaveById(params.waveId);
  // Cross-course containment: a wave id that belongs to a different course
  // must not leak into this caller's flow.
  if (wave.courseId !== course.id) {
    throw new TRPCError({ code: "FORBIDDEN", message: "wave does not belong to course" });
  }
  const openQuestionnaire = await reconstructOpenQuestionnaire(wave.id);
  return { course, wave, openQuestionnaire };
}

/**
 * Reconstruct the latest *unanswered* questionnaire from the wave's context
 * message log.
 *
 * Algorithm:
 *   1. Fetch all messages for the wave in (turn_index, seq) order.
 *   2. Walk in reverse to find the latest `assistant_response`.
 *   3. If any user-role `user_message` / `card_answer` follows it, the
 *      questionnaire (if any) was already consumed → return null.
 *   4. Parse the assistant message content as JSON, validate against
 *      `waveMidTurnSchema`. On parse / schema failure → null.
 *   5. If the assistant emitted no `questionnaire` block → null.
 *   6. Otherwise project to `OpenQuestionnaireRecord`, using the
 *      context_messages row id as a stable `questionnaireId` (no separate
 *      DB entity needed — the message row IS the questionnaire's identity).
 */
async function reconstructOpenQuestionnaire(
  waveId: string,
): Promise<OpenQuestionnaireRecord | null> {
  const messages = await getMessagesForWave(waveId);
  // Walk in reverse to find latest assistant_response. `findLastIndex` is the
  // immutable equivalent of the `let i = ...; for; break` pattern — preferred
  // here to satisfy `functional/no-let`.
  const lastAssistantIdx = messages.findLastIndex(
    (m) => m.role === "assistant" && m.kind === "assistant_response",
  );
  if (lastAssistantIdx === -1) return null;
  const lastAssistant = messages[lastAssistantIdx];
  if (!lastAssistant) return null;
  // If a learner reply follows the latest assistant message, the questionnaire
  // (if there was one) has been answered already — nothing open to render.
  const hasFollowup = messages
    .slice(lastAssistantIdx + 1)
    .some((m) => m.role === "user" && (m.kind === "user_message" || m.kind === "card_answer"));
  if (hasFollowup) return null;
  // Parse the assistant_response JSON. Tolerate parse failures (treat as "no
  // open questionnaire") so a malformed historical row never crashes the
  // turn submission flow.
  const parsed = safeJsonParse(lastAssistant.content);
  if (parsed === undefined) return null;
  const result = waveMidTurnSchema.safeParse(parsed);
  if (!result.success || !result.data.questionnaire) return null;
  // Per-branch construction to keep the discriminated-union narrowing clean
  // through `.map`. Widening to a uniform shape inside the closure would lose
  // the per-branch invariants `OpenQuestionnaireRecord` relies on (MC has
  // `options` + `correct`; free_text has neither).
  const questions = result.data.questionnaire.questions.map((q) => {
    if (q.type === "multiple_choice") {
      return {
        id: q.id,
        type: "multiple_choice" as const,
        prompt: q.prompt,
        options: q.options,
        correct: q.correct,
        freetextRubric: q.freetextRubric,
      };
    }
    return {
      id: q.id,
      type: "free_text" as const,
      prompt: q.prompt,
      freetextRubric: q.freetextRubric,
    };
  });
  return {
    // Using the context_messages row id as the questionnaireId means we don't
    // need a separate DB entity for "open questionnaire" — the message row IS
    // the source of truth, and the client echoes this id back in submitTurn.
    questionnaireId: lastAssistant.id,
    questions,
  };
}

/**
 * `JSON.parse` wrapper that returns `undefined` instead of throwing.
 *
 * Hoisted out of the closure so the parse path stays expression-style and
 * avoids `let` for `eslint-plugin-functional`. `undefined` (not `null`)
 * signals parse failure here because `null` is a legal JSON value and we
 * need to distinguish the two in the calling code.
 */
function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}
