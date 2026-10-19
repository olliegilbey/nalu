/**
 * Issue #22 grading diagnosis at the two close paths: one `[grading-debug]`
 * stderr line per grading, beside the learner's Response. A no-op unless
 * `isGradingDebugEnabled()`. Never throws: these run after the Turn's rows are
 * saved, so a debug failure must not abort the close.
 */
import { getMessagesForWave } from "@/db/queries/contextMessages";
import {
  formatGradingDebugLine,
  isGradingDebugEnabled,
  summariseStrippedGradings,
} from "@/lib/observability/gradingDebug";
import type { CloseTurnBase } from "@/lib/prompts/closeTurn";
import type { V3Response } from "@/lib/types/jsonb";
import { loadCloseResponses } from "./persistWaveClose.helpers";

type CloseGradings = CloseTurnBase["gradings"];

/** Issue #22: log a Wave close's gradings, plus any the empty-idSet strip discarded. Never throws. */
export async function logWaveCloseGradings(params: {
  readonly waveId: string;
  readonly openQuestionnaireId: string | undefined;
  readonly questionIds: readonly string[];
  readonly gradings: CloseGradings;
}): Promise<void> {
  if (!isGradingDebugEnabled()) return;
  try {
    // Empty idSet: the close schema's preprocess dropped every grading before
    // Zod saw it (commit c3ed970), so `gradings` is empty here. Read the
    // persisted raw response to name what was discarded.
    if (params.questionIds.length === 0) {
      const strip = await describeStrippedGradings(params.waveId);
      if (strip !== undefined) process.stderr.write(`${strip}\n`);
    }
    const responses = await loadCloseResponses(params.waveId, params.openQuestionnaireId);
    // No xpTier: the formatter shows XP at the grading's own conceptTier. The
    // 0-vs-nonzero split the diagnosis needs is the same at every tier.
    writeGradingLines("wave-close", params.gradings, responses, undefined);
  } catch (err) {
    writeDebugFailure("wave-close", err);
  }
}

/** Issue #22: log a scoping close's gradings beside the learner's baseline Responses. Never throws. */
export function logScopingCloseGradings(params: {
  readonly gradings: CloseGradings;
  readonly responses: readonly V3Response[];
  readonly startingTier: number;
}): void {
  if (!isGradingDebugEnabled()) return;
  try {
    // Baseline XP scores every question at `startingTier` (see
    // `mergeAndComputeXp`), so that is the tier the line shows.
    writeGradingLines("scoping-close", params.gradings, params.responses, params.startingTier);
  } catch (err) {
    writeDebugFailure("scoping-close", err);
  }
}

/** One line per grading, joined to the learner's Response by raw question id. */
function writeGradingLines(
  context: "wave-close" | "scoping-close",
  gradings: CloseGradings,
  responses: readonly V3Response[],
  xpTier: number | undefined,
): void {
  const responseById = new Map(responses.map((r) => [r.questionId, r] as const));
  for (const grading of gradings) {
    const response = responseById.get(grading.questionId);
    process.stderr.write(`${formatGradingDebugLine({ context, grading, response, xpTier })}\n`);
  }
}

/** Strip-path summary from the Wave's latest raw response; undefined when nothing was discarded. */
async function describeStrippedGradings(waveId: string): Promise<string | undefined> {
  const rows = await getMessagesForWave(waveId);
  const raw = rows.findLast((r) => r.kind === "assistant_response")?.content;
  if (raw === undefined) return undefined;
  const parsed: unknown = JSON.parse(raw);
  const gradings =
    parsed !== null && typeof parsed === "object" && "gradings" in parsed
      ? parsed.gradings
      : undefined;
  if (Array.isArray(gradings) && gradings.length === 0) return undefined;
  return summariseStrippedGradings("wave-close", gradings);
}

/** One explicit line when the debug path itself fails; the close carries on. */
function writeDebugFailure(context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  process.stderr.write(
    `[grading-debug] ${context}: debug logging failed, close continues: ${message}\n`,
  );
}
