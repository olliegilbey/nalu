import type { SubmitTurnPayload } from "@/lib/types/waveTurnInput";

/*
 * The Composer's text around a failed Wave chat-text Turn (issue #231). Pure.
 *
 * The server saves a learner entry before its LLM call. Only the identical text
 * re-sent reuses that entry; any other text spends a second Turn. So a failed
 * send hands the text back, and a re-send of it leaves the Composer empty.
 */

/** The Composer text after a chat-text Turn fails: the sent text, unless the learner typed since. */
export function composerTextAfterFailure(composerValue: string, sentText: string): string {
  // The textarea stays editable while a Turn runs. Never overwrite new typing.
  return composerValue.trim().length === 0 ? sentText : composerValue;
}

/** True when sending `text` re-sends the failed Turn, whose entry the server already shows. */
export function resendsFailedTurn(failedPayload: SubmitTurnPayload | null, text: string): boolean {
  return failedPayload?.kind === "chat-text" && failedPayload.text === text;
}

/** The Composer text once Retry re-sends `failedPayload`: its restored text goes with it; other text stays. */
export function composerTextAfterRetry(
  composerValue: string,
  failedPayload: SubmitTurnPayload,
): string {
  // Left in place, the restored text invites a second send: a new entry.
  return resendsFailedTurn(failedPayload, composerValue.trim()) ? "" : composerValue;
}
