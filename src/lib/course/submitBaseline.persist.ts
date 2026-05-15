import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { upsertConcept } from "@/db/queries/concepts";
import { openWave } from "@/db/queries/waves";
import { appendMessage } from "@/db/queries/contextMessages";
import {
  baselineClosedJsonbSchema,
  baselineQuestionsJsonbSchema,
  frameworkJsonbSchema,
  type FrameworkJsonb,
} from "@/lib/types/jsonb";
import type { ScopingCloseTurn } from "@/lib/prompts/scopingClose";
import type { MergeAndComputeXpResult } from "@/lib/scoring/baselineMerge";

/**
 * Inputs for {@link persistScopingClose}.
 *
 * `parsed` is the validated LLM close-turn payload (post-Zod).
 * `merged` is the canonical-order gradings + deterministic total XP produced
 * by `mergeAndComputeXp`.
 */
export interface PersistScopingCloseParams {
  readonly courseId: string;
  readonly parsed: ScopingCloseTurn;
  readonly merged: MergeAndComputeXpResult;
}

/** Result handle — Wave 1 id is useful for callers that need to refer to it next. */
export interface PersistScopingCloseResult {
  readonly wave1Id: string;
}

/**
 * Transactional persistence body that closes scoping and seeds Wave 1.
 *
 * Order (top → bottom): re-fetch baseline+framework → widen baseline JSONB →
 * upsert concepts → open Wave 1 → append opening message → flip status +
 * tiers + summary → bump total_xp. Status flip is last so any failure leaves
 * the course in `scoping`, retryable by the orchestrator (status-gated
 * idempotency — NOT enforced here).
 *
 * Every `courses` write uses `tx.execute` so they roll back atomically.
 * Inlined raw SQL for `courses` (not via `setCourseStartingState` /
 * `incrementCourseXp`) is required because those helpers use the `db`
 * singleton and would deadlock against the transaction's row lock — this
 * file is the one place outside `src/db/queries/` permitted to issue raw SQL.
 *
 * `upsertConcept` / `openWave` / `appendMessage` are passed `tx` so their
 * writes participate in the same transaction — a unique-violation on Wave 1
 * (e.g. concurrent submitBaseline race) rolls back the concept upsert and
 * baseline JSONB widen along with everything else. The orchestrator catches
 * the unique-violation and replays from the cached payload.
 */
export async function persistScopingClose(
  params: PersistScopingCloseParams,
): Promise<PersistScopingCloseResult> {
  const { courseId, parsed, merged } = params;

  // App-layer invariants mirroring `setCourseStartingState` — surface a clear
  // error at the boundary rather than as a Postgres CHECK violation.
  if (!Number.isInteger(parsed.startingTier) || parsed.startingTier < 1) {
    throw new Error(
      `persistScopingClose: startingTier must be a positive integer (got ${parsed.startingTier})`,
    );
  }
  if (!Number.isInteger(merged.totalXp) || merged.totalXp < 0) {
    throw new Error(
      `persistScopingClose: totalXp must be a non-negative integer (got ${merged.totalXp})`,
    );
  }

  return db.transaction(async (tx) => {
    // 1. Re-fetch baseline + framework so the widened payload preserves the
    //    full question/response history without re-deriving it from `parsed`.
    //    Raw `tx.execute` returns snake_case rows (no Drizzle camelCase map).
    const rows = await tx.execute<{
      readonly baseline: unknown;
      readonly framework: unknown;
    }>(sql`SELECT baseline, framework FROM courses WHERE id = ${courseId}`);
    const courseRow = rows[0];
    if (!courseRow?.baseline || !courseRow?.framework) {
      throw new Error(
        `persistScopingClose: course ${courseId} missing baseline or framework JSONB`,
      );
    }
    // Trust-boundary parse: re-validate the pre-close shape so a malformed
    // row surfaces here instead of corrupting the widened payload.
    const existingBaseline = baselineQuestionsJsonbSchema.parse(courseRow.baseline);
    const framework: FrameworkJsonb = frameworkJsonbSchema.parse(courseRow.framework);

    // 2. Widen baseline JSONB. Parse-before-persist (defence-in-depth) so a
    //    schema regression on this surface fails loud here, not on later read.
    //    `merged.gradings` is the canonical-ordered grading list — overrides
    //    any gradings that may already sit on the pre-close payload.
    //    `userMessage` is OVERWRITTEN with the model's closing framing
    //    (`parsed.userMessage`) — replacing the baseline-presentation framing
    //    that `generateBaseline` wrote earlier. The presentation message is
    //    NOT lost: it still lives in `context_messages` as the assistant turn
    //    that emitted the baseline questions. The closing message is the one
    //    a cached-replay of `submitBaseline` must return, since `submitBaseline`
    //    is the producer of that payload (cross-task fix per plan §7).
    const widened = baselineClosedJsonbSchema.parse({
      userMessage: parsed.userMessage,
      questions: existingBaseline.questions,
      responses: existingBaseline.responses,
      gradings: merged.gradings,
      immutableSummary: parsed.immutableSummary,
      summarySeed: parsed.summary,
      startingTier: parsed.startingTier,
    });
    await tx.execute(sql`
      UPDATE courses
      SET baseline = ${JSON.stringify(widened)}::jsonb,
          updated_at = NOW()
      WHERE id = ${courseId}
    `);

    // 3. Upsert one concept per distinct `conceptName` (case-insensitive dedup
    //    matches `upsertConcept`'s ON CONFLICT (course_id, lower(name))).
    //    Functional dedup via Map keyed on lower(name) — avoids `for`/`Set.add`
    //    mutation that `eslint-plugin-functional/immutable-data` rejects.
    //    Map preserves first-seen order; that's deterministic for the same
    //    `merged.gradings` input.
    const uniqueConcepts = [
      ...new Map(
        merged.gradings.map((g) => [
          g.conceptName.toLowerCase(),
          { name: g.conceptName, tier: g.conceptTier } as const,
        ]),
      ).values(),
    ];
    // Sequential await — concurrent inserts on the same (course_id, name)
    // could race. ON CONFLICT DO NOTHING makes it safe-ish, but sequential
    // keeps log output deterministic for tests.
    for (const c of uniqueConcepts) {
      await upsertConcept({ courseId, name: c.name, tier: c.tier }, tx);
    }

    // 4. Open Wave 1 with seed_source.scoping_handoff carrying the blueprint
    //    emitted on this close turn.
    //    NOTE: turnBudget hardcoded `10` to match every other call site in
    //    the codebase (no `WAVE_TURN_COUNT` constant exists yet in
    //    `src/lib/config/tuning.ts`). If/when one is introduced, replace.
    const wave1 = await openWave(
      {
        courseId,
        waveNumber: 1,
        tier: parsed.startingTier,
        frameworkSnapshot: framework,
        customInstructionsSnapshot: null,
        dueConceptsSnapshot: [],
        seedSource: {
          kind: "scoping_handoff",
          blueprint: parsed.nextUnitBlueprint,
        },
        turnBudget: 10,
      },
      tx,
    );

    // 5. Insert one context_messages row for Wave 1 with the assistant
    //    openingText so the learner sees a primed first message.
    await appendMessage(
      {
        parent: { kind: "wave", id: wave1.id },
        turnIndex: 0,
        seq: 0,
        kind: "assistant_response",
        role: "assistant",
        content: parsed.nextUnitBlueprint.openingText,
      },
      tx,
    );

    // 6. Flip course status, persist starting/current tier + the evolving
    //    summary seed (NOT the immutable summary — that lives only in the
    //    baseline JSONB column). Inline `tx.execute` instead of
    //    `setCourseStartingState` to keep this write inside the transaction
    //    (the helper uses the `db` singleton, which would deadlock against
    //    the earlier baseline widen's row lock).
    //    WHERE status='scoping' mirrors the helper's scope guard — a no-op
    //    if the course is already active (idempotency at the row level).
    await tx.execute(sql`
      UPDATE courses
      SET status = 'active',
          summary = ${parsed.summary},
          summary_updated_at = NOW(),
          starting_tier = ${parsed.startingTier},
          current_tier = ${parsed.startingTier},
          updated_at = NOW()
      WHERE id = ${courseId}
        AND status = 'scoping'
    `);

    // 7. Bump total_xp atomically. Skip the call when totalXp is 0 — saves a
    //    round-trip on no-XP runs (e.g. all q=0 gradings).
    if (merged.totalXp > 0) {
      await tx.execute(sql`
        UPDATE courses
        SET total_xp = total_xp + ${merged.totalXp},
            updated_at = NOW()
        WHERE id = ${courseId}
      `);
    }

    return { wave1Id: wave1.id } as const;
  });
}
