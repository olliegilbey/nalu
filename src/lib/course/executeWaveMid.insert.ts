import type { DbOrTx } from "@/db/client";
import { insertOpenAssessments } from "@/db/queries/assessments";
import { upsertConcept } from "@/db/queries/concepts";
import { encodeCorrect } from "@/lib/security/obfuscateCorrect";
import { KEY_TO_INDEX } from "./buildLearnerInput";
import type { Questionnaire } from "@/lib/prompts/questionnaire";

/**
 * Internal helper for `executeWaveMid` — insert N placeholder assessment rows
 * for a newly-emitted questionnaire, upsert any new concepts, and project to
 * the client-safe shape with `correctEnc` for MC questions.
 *
 * Split out of `executeWaveMid.ts` to keep both under the ~200-line ceiling.
 * Not re-exported via the barrel; only `executeWaveMid` calls it.
 */

/**
 * Client-safe projection of a newly-emitted questionnaire. MC questions carry
 * `correctEnc` (base64 bound to questionId) so the client can show instant
 * feedback without the raw correct key on the wire. The server holds the
 * truth in the persisted `assistant_response` row and re-derives correctness
 * mechanically when the learner replies on the next turn.
 */
export interface NewQuestionnaireProjection {
  readonly questionnaireId: string;
  readonly questions: readonly {
    readonly id: string;
    readonly type: "multiple_choice" | "free_text";
    readonly prompt: string;
    readonly options?: {
      readonly A: string;
      readonly B: string;
      readonly C: string;
      readonly D: string;
    };
    readonly correctEnc?: string;
  }[];
}

/** Inputs to `insertNewQuestionnaire`. */
export interface InsertNewQuestionnaireParams {
  readonly tx: DbOrTx;
  readonly courseId: string;
  readonly waveId: string;
  /**
   * Row id of the just-persisted `assistant_response` message. Becomes the
   * `questionnaireId` returned to the client and matches the value
   * `loadWaveContext` reconstructs on subsequent loads.
   */
  readonly assistantMessageId: string;
  /** turn_index the assistant_response landed at — assessments align to this. */
  readonly assistantTurnIndex: number;
  /** Schema-validated questionnaire from `waveMidTurnSchema`. */
  readonly questionnaire: Questionnaire;
  /** Default tier for upsertConcept when the question omits its own tier. */
  readonly waveTier: number;
}

/**
 * Insert placeholder assessment rows for a new questionnaire and project to
 * the client-safe shape. Each question:
 *   - REQUIRES `conceptName` (we throw clearly if absent — TODO.md tracks
 *     adding a schema-layer superRefine to waveMidTurnSchema).
 *   - Upserts the concept at `q.tier ?? waveTier` (immutable post-first-sight).
 *   - Maps to one assessment row with `assessment_kind = card_mc|card_freetext`,
 *     placeholder grading fields, and the model-generated `q.id` as `question_id`.
 *
 * `questionnaireId` is the just-persisted `assistant_response` row id. This
 * matches what `loadWaveContext` reconstructs (`loadWaveContext.ts:117`), so
 * the value the client receives on emission is the same value it would see
 * after a page reload. The client passes it back verbatim in `submitTurn`.
 */
export async function insertNewQuestionnaire(
  params: InsertNewQuestionnaireParams,
): Promise<NewQuestionnaireProjection> {
  // --- Concept upsert (per-question) ----------------------------------------
  // Sequential await on the same tx handle. Question count is small (~1-3
  // per turn), so the latency cost is negligible vs the clarity of a flat
  // for-of vs Promise.all error-attribution dance.
  // Build a parallel array of { question, conceptId } pairs so the batch
  // insert below can read both without re-correlating.
  const resolved: ReadonlyArray<{
    readonly q: Questionnaire["questions"][number];
    readonly conceptId: string;
  }> = await params.questionnaire.questions.reduce<
    Promise<
      ReadonlyArray<{ readonly q: Questionnaire["questions"][number]; readonly conceptId: string }>
    >
  >(async (accP, q) => {
    const acc = await accP;
    if (!q.conceptName) {
      // waveMidTurn questions must carry conceptName so we know which
      // concept to upsert + bind grading to. The shared base questionSchema
      // permits absence (clarify questions have none), so the invariant is
      // application-layer here. TODO.md tracks a schema-layer superRefine.
      throw new Error(
        `executeWaveMid: questionnaire question id=${q.id} missing required conceptName`,
      );
    }
    const concept = await upsertConcept(
      { courseId: params.courseId, name: q.conceptName, tier: q.tier ?? params.waveTier },
      params.tx,
    );
    return [...acc, { q, conceptId: concept.id }];
  }, Promise.resolve([]));

  // --- Batch insert assessment rows ----------------------------------------
  // One round-trip via `insertOpenAssessments`. The kind discriminator picks
  // card_mc vs card_freetext from the question's type literal.
  await insertOpenAssessments(
    {
      waveId: params.waveId,
      turnIndex: params.assistantTurnIndex,
      rows: resolved.map(({ q, conceptId }) => ({
        conceptId,
        questionId: q.id,
        question: q.prompt,
        assessmentKind: q.type === "multiple_choice" ? "card_mc" : "card_freetext",
      })),
    },
    params.tx,
  );

  // --- Project to client-safe shape ----------------------------------------
  // MC: compute correctEnc from the question's `correct` letter (must be
  // present on graded MC). Free-text: no `options`/`correctEnc` emitted.
  // The discriminated-union narrowing inside .map preserves per-branch
  // invariants without a uniform widening cast.
  const questions = params.questionnaire.questions.map((q) => {
    if (q.type === "multiple_choice") {
      if (q.correct === undefined) {
        // Graded MC must have a correct key — schema permits absence for
        // clarify-style elicitation, which doesn't happen in wave teaching.
        // Fail loud rather than emit a useless projection.
        throw new Error(`executeWaveMid: MC question id=${q.id} missing required correct key`);
      }
      return {
        id: q.id,
        type: "multiple_choice" as const,
        prompt: q.prompt,
        options: q.options,
        correctEnc: encodeCorrect(q.id, KEY_TO_INDEX[q.correct]),
      };
    }
    return {
      id: q.id,
      type: "free_text" as const,
      prompt: q.prompt,
    };
  });

  return {
    // questionnaireId IS the assistant_response message row id — same
    // addressing scheme `loadWaveContext` uses (see `loadWaveContext.ts:117`).
    // Keeping the two paths byte-identical means a mid-turn emission and a
    // subsequent page reload both surface the same id.
    questionnaireId: params.assistantMessageId,
    questions,
  };
}
