import { z } from "zod/v4";
import { PROFILE } from "@/lib/config/tuning";

/**
 * Input schema for `profile.setCustomInstructions`: the one rule for trim,
 * cap and clear. It trims first, so the cap counts the trimmed text. Empty
 * text after trim parses to null, which clears the preference. Over-cap text
 * fails the parse, so tRPC answers BAD_REQUEST and nothing is written.
 */
export const setCustomInstructionsInputSchema = z.object({
  customInstructions: z
    .string()
    .trim()
    .max(PROFILE.maxCustomInstructionsLength)
    .transform((text) => (text === "" ? null : text)),
});
