import { TRPCError } from "@trpc/server";

/** What the learner sees when a Wave turn fails for a reason they cannot act on. */
const TURN_FAILED_TEXT = "Something went wrong. Please try again.";

/**
 * The text a failed Wave turn sends to the client, shown in its toast.
 * Guard errors (`TRPCError`) pass through: the harness writes them, and they
 * quote ids only. Any other message can quote Turn content. A failed DB
 * write lists its query params, and those hold tool inputs with answer keys
 * (#169). So every other error gets fixed text.
 */
export function waveTurnErrorText(error: unknown): string {
  return error instanceof TRPCError ? error.message : TURN_FAILED_TEXT;
}
