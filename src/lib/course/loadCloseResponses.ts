import type { DbOrTx } from "@/db/client";
import { getWaveChatLog } from "@/db/queries/waves";
import type { V3Response } from "@/lib/types/jsonb";

/**
 * The learner's close-turn Responses: the `user.answers` entry in the live
 * `chat_log` that targets the open questionnaire. Empty when none is open.
 *
 * Reads the LIVE column — not `ctx.wave.chatLog`, which `loadWaveContext`
 * snapshots before `prepareWaveTurn` appends the close-turn answer. The append
 * committed before the close ran, so it is visible here. `applyCloseGradings`
 * passes its tx; the issue #22 debug log (`closeGradingDebug.ts`) reads
 * without one.
 */
export async function loadCloseResponses(
  waveId: string,
  openQuestionnaireId: string | undefined,
  tx?: DbOrTx,
): Promise<readonly V3Response[]> {
  if (openQuestionnaireId === undefined) return [];
  const liveLog = await getWaveChatLog(waveId, tx);
  return liveLog.flatMap((e) =>
    e.role === "user" && e.kind === "answers" && e.questionnaireId === openQuestionnaireId
      ? e.responses
      : [],
  );
}
