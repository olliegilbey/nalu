import { getUserCustomInstructions, updateUserCustomInstructions } from "@/db/queries/userProfiles";

/**
 * Read the learner's custom instructions. Null means none set.
 *
 * @throws {NotFoundError} when the learner has no profile row. Callers run
 * behind `protectedProcedure`, which provisions it first.
 */
export async function getCustomInstructions(userId: string): Promise<string | null> {
  return getUserCustomInstructions(userId);
}

/**
 * Save the learner's custom instructions and return the value stored. Null
 * clears them. `value` arrives already trimmed and capped by
 * `setCustomInstructionsInputSchema`, so this stores it as-is. No log line
 * carries the text: learner preferences stay out of telemetry.
 */
export async function saveCustomInstructions(
  userId: string,
  value: string | null,
): Promise<string | null> {
  return updateUserCustomInstructions({ userId, customInstructions: value });
}
