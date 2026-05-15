/**
 * Live-smoke end-of-test snapshot.
 *
 * Reconstructs and emits to stderr the FINAL prompt that succeeded for
 * `courseId` — the full system + cumulative user/assistant conversation
 * as the LLM saw it on the last attempt of the last turn — plus a
 * one-line retry summary by step (clarify / framework / baseline / close).
 *
 * Use case: scroll to the bottom of `just smoke` output and read exactly
 * what the model answered, without sifting through any retry diagnoses
 * that may appear earlier in the log.
 *
 * Test-only. Gated on `CEREBRAS_LIVE=1` via `isLive()`; no-op otherwise.
 * Reuses `formatPromptBlock` from `formatTurn.ts` so role separators
 * (system / user / assistant) get the same ANSI colours as the per-attempt
 * banners — visual consistency for human readers.
 */

import { eq, asc } from "drizzle-orm";
import type { drizzle } from "drizzle-orm/postgres-js";
import { contextMessages, scopingPasses } from "@/db/schema";
import type * as schema from "@/db/schema";
import { renderContext } from "@/lib/llm/renderContext";
import type { LlmMessage } from "@/lib/types/llm";
import { formatPromptBlock, isLive } from "@/lib/turn/formatTurn";

/** Drizzle handle compatible with both the prod proxy and `withTestDb`'s test client. */
type DrizzleClient = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Turn-index → step label for scoping. Matches the fixed order
 * clarify(0) → framework(1) → baseline(2) → close(3). Reused for the
 * retry-count summary line.
 */
const SCOPING_STEP_BY_TURN: Readonly<Record<number, string>> = {
  0: "clarify",
  1: "framework",
  2: "baseline",
  3: "close",
};

export interface SmokeFinalSnapshotArgs {
  readonly db: DrizzleClient;
  readonly courseId: string;
  readonly topic: string;
}

/**
 * Reconstruct and print the cumulative scoping conversation for `courseId`.
 *
 * No-op when `CEREBRAS_LIVE=1` is unset, so calling from a non-live test
 * (or production code path) is safe and silent.
 */
export async function emitSmokeFinalSnapshot(args: SmokeFinalSnapshotArgs): Promise<void> {
  if (!isLive()) return;
  const { db, courseId, topic } = args;

  // Resolve the scoping pass for this course. One-to-one (unique index on
  // course_id), so .limit(1) is exact. Bail silently if absent — keeps the
  // helper robust against being called from a test that aborts before
  // scoping was created.
  const passRows = await db
    .select({ id: scopingPasses.id })
    .from(scopingPasses)
    .where(eq(scopingPasses.courseId, courseId))
    .limit(1);
  const scopingPassId = passRows[0]?.id;
  if (!scopingPassId) return;

  // All persisted rows for this pass, in turn order. Includes any
  // failed_assistant_response + harness_retry_directive rows — those are
  // filtered out by renderContext below for successful turns, but we count
  // them first to build the retry summary.
  const rows = await db
    .select()
    .from(contextMessages)
    .where(eq(contextMessages.scopingPassId, scopingPassId))
    .orderBy(asc(contextMessages.turnIndex), asc(contextMessages.seq));

  // Retry count per step = number of failed_assistant_response rows at that
  // turn_index. Plain object accumulator (spread, not Map.set) keeps the
  // fold immutable under functional/immutable-data.
  const retryCounts: Readonly<Record<number, number>> = rows.reduce<
    Readonly<Record<number, number>>
  >((acc, r) => {
    if (r.kind !== "failed_assistant_response") return acc;
    return { ...acc, [r.turnIndex]: (acc[r.turnIndex] ?? 0) + 1 };
  }, {});
  const summary = Object.keys(SCOPING_STEP_BY_TURN)
    .map(Number)
    .sort((a, b) => a - b)
    .map((idx) => `${SCOPING_STEP_BY_TURN[idx]!}=${retryCounts[idx] ?? 0}`)
    .join(" ");

  // Re-render via the same pure function executeTurn uses for live turns.
  // It strips retry-exhaust rows from groups that recovered, so what we
  // emit is byte-faithful to the FINAL successful attempt's wire payload.
  const rendered = renderContext({ kind: "scoping", topic }, rows);
  const llmMessages: readonly LlmMessage[] = [
    { role: "system", content: rendered.system } satisfies LlmMessage,
    ...rendered.messages.map((m): LlmMessage => {
      // Mirror the narrow in executeTurn: 'tool' would need ToolContent.
      // Scoping never emits tool rows today; throw rather than silently
      // mis-rendering if that changes.
      if (m.role === "assistant") return { role: "assistant", content: m.content };
      if (m.role === "system") return { role: "system", content: m.content };
      if (m.role === "tool") {
        throw new Error("smokeFinalSnapshot: tool-role row is not supported");
      }
      return { role: "user", content: m.content };
    }),
  ];

  // Banner uses ═ (double bar) to visually distinguish this end-of-test
  // block from the per-attempt headers (which use ━). Same 80-col width
  // as the existing banners for grep-friendliness.
  const bar = "═".repeat(80);
  process.stderr.write(`\n${bar}\n`);
  process.stderr.write(
    `▼ FINAL SUCCESSFUL CONVERSATION  topic=${JSON.stringify(topic)}  retries: ${summary}\n`,
  );
  process.stderr.write(`${bar}\n`);
  process.stderr.write(formatPromptBlock(llmMessages));
  process.stderr.write(`${bar}\n\n`);
}
