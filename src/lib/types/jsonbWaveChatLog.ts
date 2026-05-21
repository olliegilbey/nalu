import { z } from "zod";
import { v3Question, v3Response } from "./jsonb";

/**
 * Wave chat-log JSONB shape — split out of `jsonb.ts` to keep both files
 * under the 200-LOC ceiling. Mirrors the existing `jsonbBaseline.ts` split
 * convention. Wire/types are unchanged; this is a surgical move.
 *
 * `v3Question` / `v3Response` are imported back from `./jsonb` because they
 * are scoping primitives that belong with their original definition.
 */

// --- waves.chat_log -----------------------------------------------------

/**
 * One row in `waves.chat_log` — the typed JSONB store the wave UI reads.
 *
 * `Question` / `Response` reused verbatim from the scoping primitives above.
 * Strictly append-only; the four kinds cover:
 *  - user text turn (chat-text mode)
 *  - user questionnaire submission (pre-LLM, paired with assistant emission)
 *  - assistant text turn (no questionnaire)
 *  - assistant text turn that opens a new questionnaire
 *
 * Uses `z.union` (not `z.discriminatedUnion`) because the natural discriminator
 * is the `(role, kind)` pair — `kind: "text"` appears in both the user and
 * assistant arms — and Zod v4 requires single-field discriminator values to be
 * unique across all arms. TS narrowing on `role` + `kind` literals still works
 * identically; only Zod's parse-error messages are slightly less specific.
 *
 * Mirror of scoping's typed JSONB store (`courses.{clarification|baseline}`);
 * wave is variable-cardinality so the column is an array. See
 * `docs/ARCHITECTURE.md` and the spec for why per-row beats per-round.
 */
export const waveChatLogEntrySchema = z.union([
  z.object({
    role: z.literal("user"),
    kind: z.literal("text"),
    content: z.string(),
  }),
  z.object({
    role: z.literal("user"),
    kind: z.literal("answers"),
    questionnaireId: z.string(),
    responses: z.array(v3Response),
  }),
  z.object({
    role: z.literal("assistant"),
    kind: z.literal("text"),
    content: z.string(),
  }),
  z.object({
    role: z.literal("assistant"),
    kind: z.literal("text_with_questionnaire"),
    questionnaireId: z.string(),
    content: z.string(),
    questions: z.array(v3Question),
  }),
]);
export const waveChatLogSchema = z.array(waveChatLogEntrySchema);
export type WaveChatLogEntry = z.infer<typeof waveChatLogEntrySchema>;
export type WaveChatLog = z.infer<typeof waveChatLogSchema>;
