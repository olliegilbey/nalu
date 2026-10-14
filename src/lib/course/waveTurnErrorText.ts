import { TRPCError } from "@trpc/server";
import { NotFoundError } from "@/db/queries/errors";

/** What the learner sees when a Wave turn fails for a reason they cannot act on. */
const TURN_FAILED_TEXT = "Something went wrong. Please try again.";

/**
 * The text a failed Wave turn sends to the client, shown in its toast.
 * Guard errors (`TRPCError`) and `NotFoundError` pass through: the harness
 * and query layer write them, and they quote ids only. A `TRPCError` built
 * without a `message` takes its cause's message instead. No such call exists
 * on this path today; keep it that way. Any other message can quote Turn
 * content. A failed DB write lists its query params, and those hold tool
 * inputs with answer keys (#169). So every other error gets fixed text.
 */
export function waveTurnErrorText(error: unknown): string {
  return error instanceof TRPCError || error instanceof NotFoundError
    ? error.message
    : TURN_FAILED_TEXT;
}
