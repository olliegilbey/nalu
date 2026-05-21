import { sql } from "drizzle-orm";
import type { DbOrTx } from "@/db/client";
import { getAssessmentByWaveAndQuestionId } from "@/db/queries/assessments";
import { getConceptById } from "@/db/queries/concepts";
import { getWaveChatLog } from "@/db/queries/waves";
import { checkTierAdvancement } from "@/lib/scoring/progression";
import type { ConceptState } from "@/lib/types/scoring";
import type { WaveCloseTurn } from "@/lib/prompts/waveClose";
import type { WaveChatLog } from "@/lib/types/jsonbWaveChatLog";
import { applyAssessmentGrading, type GradedSignal } from "./applyAssessmentGrading";
import { findOpenQuestionnaire, buildMcCorrectKeyMap } from "./findOpenQuestionnaire";
import { namespaceQuestionId } from "./namespaceQuestionId";
import type { LoadedWaveContext } from "./loadWaveContext";

/**
 * Internal helpers for `persistWaveClose` — split out to keep both files under
 * the ~200-line ceiling. Mirrors the `executeWaveMid.{ts,grade.ts,insert.ts}`
 * pattern. Not re-exported via the barrel; only `persistWaveClose` calls these.
 */

/**
 * Per-question grading projection surfaced back to the orchestrator. Mirrors
 * the mid-turn shape so the upstream `submitWaveTurn` union can be uniform.
 */
export interface PersistedGradedSignal {
  readonly kind: GradedSignal["kind"];
  readonly questionId: string;
  readonly xpAwarded: number;
}

/**
 * Build the learner's MC-click map from the live `chat_log`: raw question id →
 * selected key letter (only `user.answers` responses with a `choice` targeting
 * the open questionnaire).
 *
 * Reads the LIVE column via the tx — not `ctx.wave.chatLog`, which
 * `loadWaveContext` snapshots before `submitWaveTurn` appends the close-turn
 * answer. The append committed before this tx opened, so it is visible here.
 */
async function buildCloseMcChoiceMap(
  tx: DbOrTx,
  waveId: string,
  openQuestionnaireId: string,
): Promise<ReadonlyMap<string, "A" | "B" | "C" | "D">> {
  const liveLog = await getWaveChatLog(waveId, tx);
  const entries = liveLog.flatMap((e) =>
    e.role === "user" && e.kind === "answers" && e.questionnaireId === openQuestionnaireId
      ? e.responses
          .filter(
            (r): r is typeof r & { readonly choice: "A" | "B" | "C" | "D" } =>
              r.choice !== undefined,
          )
          .map((r) => [r.questionId, r.choice] as const)
      : [],
  );
  return new Map(entries);
}

/**
 * Apply each close-grading to the corresponding assessment row.
 *
 * Free-text path: route through `applyAssessmentGrading` with the parsed
 * payload's verdict + qualityScore. `conceptTier` is read from the persisted
 * concept row — NOT the LLM-emitted `g.conceptTier` — so the model cannot
 * influence XP (core design principle). Mirrors the MC path's tier lookup.
 *
 * MC path (bug_003): a questionnaire posed on the final mid-turn has no later
 * mid-turn, so its MC questions are answered — and graded — at close. The model
 * emits an `mc-index` grading (the coverage refine forces a grading; the click
 * renders `kind="mc-index"`). We grade it MECHANICALLY: the model's grading is
 * trusted only for *which* question, never for correctness. `correct` is
 * computed server-side — learner's persisted click (live `chat_log`) vs the
 * questionnaire's persisted `correct` key — mirroring `executeWaveMid.grade.ts`.
 * Honours the core design principle: the LLM never controls scoring.
 *
 * The stored `question_id` column is namespaced per questionnaire
 * (`namespaceQuestionId`), but the model grades using the RAW `q.id`. We
 * re-derive the namespace prefix from the open questionnaire's id so the row
 * lookup hits; the surfaced `questionId` stays raw for the client.
 */
export async function applyCloseGradings(
  tx: DbOrTx,
  ctx: LoadedWaveContext,
  parsed: WaveCloseTurn,
): Promise<readonly PersistedGradedSignal[]> {
  // Re-derive the open questionnaire being graded — its id namespaces the
  // stored `question_id` lookup AND carries the server-side `correct` keys for
  // MC grading. `ctx.wave.chatLog` is `unknown` at the Drizzle JSONB boundary;
  // runtime shape is guaranteed by `waveRowGuard` upstream.
  const openQuestionnaire = findOpenQuestionnaire(ctx.wave.chatLog as WaveChatLog);
  // raw id → server-side correct key (MC only). Empty when no questionnaire is
  // open. Shared with the mid-turn grading path via `buildMcCorrectKeyMap`.
  const correctByQuestionId = openQuestionnaire
    ? buildMcCorrectKeyMap(openQuestionnaire)
    : new Map<string, "A" | "B" | "C" | "D">();
  // raw id → learner's clicked key. `buildCloseMcChoiceMap` reads the live
  // `chat_log` (not the snapshot) so the close-turn answer is visible. Only
  // fetched when there is an open questionnaire to grade against.
  const clickByQuestionId = openQuestionnaire
    ? await buildCloseMcChoiceMap(tx, ctx.wave.id, openQuestionnaire.questionnaireId)
    : new Map<string, "A" | "B" | "C" | "D">();
  // Reduce keeps `eslint-plugin-functional/immutable-data` happy when we need
  // to accumulate results; the awaited accumulator threads them through.
  // Sequential by design — writes share one tx handle and grading counts at
  // close are tiny (0–1 free-text items). The SM-2 loop in
  // `persistWaveClose.ts` uses a plain `for…of` because it's purely effectful
  // (no accumulation), so the reduce-vs-for-of split is driven by whether we
  // need to thread a value, not by lint policy.
  return parsed.gradings.reduce<Promise<readonly PersistedGradedSignal[]>>(async (accP, g) => {
    const acc = await accP;
    // Namespace the raw `g.questionId` with the open questionnaire's id to hit
    // the stored row. If no questionnaire is open there is nothing to grade —
    // fall through to the null-row skip below (the model emitted a stale id).
    const storedQuestionId = openQuestionnaire
      ? namespaceQuestionId(openQuestionnaire.questionnaireId, g.questionId)
      : g.questionId;
    const row = await getAssessmentByWaveAndQuestionId(ctx.wave.id, storedQuestionId, tx);
    if (!row) {
      process.stderr.write(
        `[executeWaveClose] no assessment row for wave=${ctx.wave.id} questionId=${g.questionId}; skipping\n`,
      );
      return acc;
    }
    if (g.kind === "mc-index") {
      // bug_003: grade MC mechanically — see this function's TSDoc.
      const click = clickByQuestionId.get(g.questionId);
      const correctKey = correctByQuestionId.get(g.questionId);
      if (click === undefined || correctKey === undefined) {
        // No persisted click or no `correct` key — not mechanically scorable.
        // Skip + log rather than corrupt the row with an unverifiable verdict.
        process.stderr.write(
          `[executeWaveClose] mc-index grading for questionId=${g.questionId} but no learner click / correct key; skipping\n`,
        );
        return acc;
      }
      // Concept tier drives MC XP — MC carries no tier on the wire (unlike
      // free-text), so read it from the row's concept (mirrors the mid-turn path).
      const concept = await getConceptById(row.conceptId, tx);
      const applied = await applyAssessmentGrading({
        assessmentId: row.id,
        conceptTier: concept.tier,
        signal: { kind: "mc-index", questionId: g.questionId, correct: click === correctKey },
        tx,
        userAnswer: click,
      });
      return [
        ...acc,
        { kind: applied.kind, questionId: applied.questionId, xpAwarded: applied.xpAwarded },
      ];
    }
    // Concept tier drives free-text XP. The close payload carries an
    // LLM-emitted `g.conceptTier`, but the LLM must never influence scoring
    // (core design principle): read the authoritative tier from the persisted
    // concept row instead — mirrors the `mc-index` branch above.
    const concept = await getConceptById(row.conceptId, tx);
    const applied = await applyAssessmentGrading({
      assessmentId: row.id,
      conceptTier: concept.tier,
      signal: {
        kind: "free-text",
        questionId: g.questionId,
        verdict: g.verdict,
        qualityScore: g.qualityScore,
      },
      tx,
    });
    return [
      ...acc,
      { kind: applied.kind, questionId: applied.questionId, xpAwarded: applied.xpAwarded },
    ];
  }, Promise.resolve([]));
}

/**
 * Run `checkTierAdvancement` against current-tier concepts with a known
 * lastQualityScore. On advance, bump `courses.current_tier` inside the same
 * tx (raw UPDATE — the helper `updateCourseTier` uses the `db` singleton and
 * would deadlock here, same rationale as in `persistScopingClose`).
 *
 * Returns the new tier number on advance; null otherwise.
 */
export async function maybeAdvanceTier(
  tx: DbOrTx,
  courseId: string,
  currentTier: number,
  allConcepts: readonly { readonly tier: number; readonly lastQualityScore: number | null }[],
): Promise<number | null> {
  // ConceptState requires a concrete QualityScore — never-assessed concepts
  // (lastQualityScore null) are excluded so they don't drag the passing ratio.
  // The cast at the end is safe because lastQualityScore is constrained to
  // 0..5 by a DB CHECK (`concepts_last_quality_score_range`).
  const conceptStates: readonly ConceptState[] = allConcepts
    .filter((c) => c.tier === currentTier && c.lastQualityScore !== null)
    .map((c) => ({ lastQualityScore: c.lastQualityScore as 0 | 1 | 2 | 3 | 4 | 5 }));
  const advancement = checkTierAdvancement(conceptStates);
  if (!advancement.canAdvance) return null;
  const newTier = currentTier + 1;
  await tx.execute(sql`
    UPDATE courses
    SET current_tier = ${newTier},
        updated_at = NOW()
    WHERE id = ${courseId}
  `);
  return newTier;
}
