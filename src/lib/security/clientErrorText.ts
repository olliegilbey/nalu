import { TRPCError } from "@trpc/server";
import { z } from "zod/v4";
import { NotFoundError } from "@/db/queries/errors";

/** What the learner sees when a request fails for a reason they cannot act on. */
const REQUEST_FAILED_TEXT = "Something went wrong. Please try again.";

/**
 * The error text safe to send to the client. The Wave-turn route's stream
 * `onError` and the tRPC `errorFormatter` both send it. Text the server wrote
 * on purpose passes. Any other message can quote learner text, model prose or
 * answer keys: a failed DB write's message lists its params (issues #169,
 * #171). So every other error gets fixed text.
 */
export function clientErrorText(error: unknown): string {
  return isSafeToShow(error) ? error.message : REQUEST_FAILED_TEXT;
}

/**
 * True when the error's message is safe to show.
 * - A `NotFoundError`: the query layer writes it, and it quotes ids only.
 * - A `TRPCError` with its own message: a guard threw it on purpose. Guard
 *   messages quote ids and statuses only; keep it that way.
 * - A `TRPCError` built without a message copies its cause's message, so the
 *   cause decides. tRPC wraps every unexpected throw this way, as
 *   INTERNAL_SERVER_ERROR. `mapNotFound` copies a `NotFoundError`'s message.
 * - tRPC's input validation: a BAD_REQUEST around a `ZodError`. Its issues
 *   describe the requester's own input against a static schema. Zod v4 drops
 *   the input value unless `reportInput` is set, and no input schema sets a
 *   custom message. A `ZodError` thrown inside a procedure is not this case:
 *   tRPC wraps it as INTERNAL_SERVER_ERROR.
 * - A cause whose `message` is not a string is unsafe. tRPC copies a thrown
 *   object's fields onto its cause, and `Error()` stringifies the wrapper's
 *   copy, so the two messages differ yet carry the same content.
 */
function isSafeToShow(error: unknown): error is Error {
  if (error instanceof NotFoundError) return true;
  if (!(error instanceof TRPCError)) return false;
  const cause = error.cause;
  if (cause === undefined) return true;
  // Typed `string`, but a thrown object's fields arrive unchecked.
  const causeMessage: unknown = cause.message;
  if (typeof causeMessage !== "string") return false;
  if (error.message !== causeMessage) return true;
  if (error.code === "BAD_REQUEST" && cause instanceof z.ZodError) return true;
  return isSafeToShow(cause);
}
