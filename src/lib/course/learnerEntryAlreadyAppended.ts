import type { WaveChatLog, WaveChatLogEntry } from "@/lib/types/jsonbWaveChatLog";

/**
 * Decide whether `chat_log` already ends with the learner entry we are about
 * to append — i.e. whether this is a *retry* of a turn whose pre-LLM append
 * already committed.
 *
 * ## Why this exists
 *
 * `submitWaveTurn` writes the learner's turn to `waves.chat_log` BEFORE the
 * fallible `executeWaveMid` / `executeWaveClose` dispatch (the pre-LLM
 * durability invariant — see `docs/ARCHITECTURE.md`). The append is a raw
 * Postgres JSONB `||` concat, which is non-idempotent: when the LLM dispatch
 * throws, the learner entry is committed and orphaned (no paired assistant
 * entry), and a naive retry appends a *second* copy.
 *
 * Scoping gets idempotency for free because its pre-LLM persist writes
 * *overwrite* columns (`courses.clarification` etc.). The wave store is
 * append-only, so it needs an explicit resume check. This helper is that
 * check: if the trailing entry already represents this exact submission, the
 * caller skips the append, restoring the resume-survives invariant.
 *
 * ## Why the trailing entry suffices
 *
 * The orphan is always the *last* entry: the dispatch that would have written
 * the assistant entry failed before doing so, so no entry can follow the
 * learner's. A single trailing-entry comparison is therefore sufficient — no
 * full scan needed.
 *
 * ## Matching rules (mirror the `WaveChatLogEntry` learner arms)
 *
 *  - chat-text:    same `kind: "text"` + same `content`.
 *  - questionnaire-answers: same `kind: "answers"` + same `questionnaireId`
 *    + structurally-equal `responses` (order-sensitive — `submitWaveTurn`
 *    derives `responses` deterministically from the payload's answer order,
 *    so a retry of the same submission produces the identical array).
 *
 * @param log - the wave's current `chat_log` (typed, post-`waveRowGuard`).
 * @param entry - the learner entry `submitWaveTurn` is about to append.
 * @returns `true` when `log`'s last entry already equals `entry`.
 */
export function learnerEntryAlreadyAppended(log: WaveChatLog, entry: WaveChatLogEntry): boolean {
  const trailing = log.at(-1);
  if (trailing === undefined) return false;
  // Only learner entries are appended pre-LLM; an assistant trailing entry
  // means the previous turn completed — definitely not a retry orphan.
  if (trailing.role !== "user" || entry.role !== "user") return false;

  if (entry.kind === "text") {
    return trailing.kind === "text" && trailing.content === entry.content;
  }

  // entry.kind === "answers"
  if (trailing.kind !== "answers" || trailing.questionnaireId !== entry.questionnaireId) {
    return false;
  }
  return responsesEqual(trailing.responses, entry.responses);
}

/** The `responses` array shape from a learner `answers` chat-log entry. */
type AnswerResponses = Extract<WaveChatLogEntry, { kind: "answers" }>["responses"];

/**
 * Order-sensitive structural equality for two `answers` `responses` arrays.
 *
 * Each response is `{ questionId, choice? | freetext? }` (exactly one of
 * `choice` / `freetext` per `v3Response`). Compares length then field-by-field.
 */
function responsesEqual(a: AnswerResponses, b: AnswerResponses): boolean {
  if (a.length !== b.length) return false;
  return a.every((ra, i) => {
    const rb = b[i];
    return (
      rb !== undefined &&
      ra.questionId === rb.questionId &&
      ra.choice === rb.choice &&
      ra.freetext === rb.freetext
    );
  });
}
