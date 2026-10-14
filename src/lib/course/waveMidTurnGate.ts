import { ValidationGateFailure } from "@/lib/turn/validationGateFailure";
import { findBracesOutsideCode, opensJsonKey } from "@/lib/turn/proseBraces";
import { escapeXmlText } from "@/lib/security/escapeXmlText";
import type { WaveCloseTurn } from "@/lib/prompts/waveClose";
import type { ToolQuestionInput, WaveTurnCollector } from "./waveTurnTools";
import type { SubmitTurnPayload } from "./buildLearnerInput";

/**
 * Post-loop validation gate for a streamed tool mid-turn — the tool-channel
 * replacement for the mega-schema's whole-object guarantees. Runs AFTER the
 * loop ends, over the staged collector + the prose the learner actually saw
 * (all steps' streamed text, not just the final step's).
 *
 * Failure detail strings are model-readable retry directives —
 * `executeToolTurnStream` persists each one verbatim inside
 * `<harness_feedback>` as the `harness_retry_directive` row.
 *
 * Checks (each replaces a mega-schema invariant, in order):
 * 1. Non-empty prose — was `userMessage: z.string().min(1)`.
 * 2. No raw response-JSON in the prose — waves opened under the mega-schema
 *    contract carry JSON assistant turns (and sometimes an inline
 *    `<response_schema>`) in their replayed context; the model imitates the
 *    history and dumps the old JSON envelope as text instead of calling
 *    tools (observed live, 2026-07-08). The directive breaks the few-shot
 *    pattern so the retry recovers. A mid-turn can also take itself for the
 *    close and dump the close JSON or its bare blueprint (#172). Two parts:
 *    a fence-blind secret check on the tool's field names, and an envelope
 *    check outside code on the old envelope, tool and close-only keys. The
 *    secret check also keeps an answer key out of chat_log: accepted prose
 *    persists whole, even past the stream guard's cut (#156).
 * 3. Grading coverage — every answered question carries a staged signal.
 *    The old schema left `comprehensionSignals` optional, silently skipping
 *    grading when the model forgot; the tool channel makes the omission
 *    detectable (probe finding: ~5% no-call rate), so gate it.
 */
export function validateWaveMidToolTurn(
  collector: WaveTurnCollector,
  visibleProse: string,
  payload: SubmitTurnPayload,
): ValidationGateFailure | null {
  if (visibleProse.trim().length === 0) {
    return new ValidationGateFailure(
      "tool_turn_gate",
      "Your response ended without any teaching prose. The learner sees your plain text output — after any tool calls finish, always write the teaching message for this turn.",
    );
  }

  if (containsResponseJsonBlob(visibleProse)) {
    return new ValidationGateFailure(
      "tool_turn_gate",
      "Your message to the learner contained a raw JSON object. Your plain text output goes to the learner verbatim: write natural conversational prose only, and emit structured actions (grading, quizzes) ONLY by calling the provided tools (recordComprehensionSignals, presentQuestionnaire). Rewrite this turn: call the tools for any grading or quiz first, then write your teaching prose as plain text.",
    );
  }

  if (payload.kind === "questionnaire-answers") {
    const gradedIds = new Set(collector.signals.map((s) => s.questionId));
    const ungraded = payload.answers.map((a) => a.id).filter((id) => !gradedIds.has(id));
    if (ungraded.length > 0) {
      // Ids are escaped: the directive persists inside `<harness_feedback>`,
      // and a raw closing tag would split that trusted block (#123).
      return new ValidationGateFailure(
        "tool_turn_gate",
        `The learner submitted answers to questions ${escapeXmlText(ungraded.join(", "))} but you did not record grading signals for them. Call recordComprehensionSignals FIRST with one signal per answered question, then write your teaching prose.`,
      );
    }
  }

  return null;
}

/** True when the prose holds a questionnaire secret or a response envelope. */
function containsResponseJsonBlob(prose: string): boolean {
  return containsQuestionnaireSecret(prose) || containsResponseEnvelope(prose);
}

// Field names the presentQuestionnaire input requires on every question.
// `satisfies` pins each to the tool schema, so a rename breaks the build.
const RUBRIC_FIELD = "freetextRubric" satisfies keyof ToolQuestionInput;
const ANSWER_KEY_FIELD = "correct" satisfies keyof ToolQuestionInput;
const CONCEPT_FIELD = "conceptName" satisfies keyof ToolQuestionInput;

/** Matches `"name"` used as a JSON key: the quoted name, optional whitespace, `:`. */
const jsonKeyPattern = (name: string): RegExp => new RegExp(`"${name}"\\s*:`);
const RUBRIC_KEY = jsonKeyPattern(RUBRIC_FIELD);
const ANSWER_KEY = jsonKeyPattern(ANSWER_KEY_FIELD);
const CONCEPT_KEY = jsonKeyPattern(CONCEPT_FIELD);

/**
 * Secret check: true when the prose uses the questionnaire tool's own field
 * names as JSON keys, `"freetextRubric":`, or `"correct":` together with
 * `"conceptName":`. Any imitation dump of the tool input carries them;
 * teaching JSON does not. Matched by name on the whole prose, with no brace
 * walk, so it catches fenced, backticked, wrapped, nested and truncated
 * dumps alike. Fence-blind on purpose: the stream guard exempts code, so
 * this is the backstop that keeps an answer key out of chat_log (#156).
 * A dump under invented field names slips past it.
 */
function containsQuestionnaireSecret(prose: string): boolean {
  return RUBRIC_KEY.test(prose) || (ANSWER_KEY.test(prose) && CONCEPT_KEY.test(prose));
}

/** The close turn's next-lesson blueprint, as the Wave close schema emits it. */
type CloseBlueprint = WaveCloseTurn["nextUnitBlueprint"];

/**
 * Top-level keys of the retired mega-schema envelope, the tool inputs, and
 * the close turn. A mid-turn can mistake itself for the close and dump the
 * close's JSON or its bare blueprint as prose (#172). Only close keys that
 * teaching JSON will not use are listed: generic ones (`topic`, `outline`,
 * `summary`, `gradings`) stay out, since a teaching example may use them.
 * `satisfies` pins each close key to its schema, so a rename breaks the build.
 */
const RESPONSE_ENVELOPE_KEYS = [
  "userMessage",
  "questionnaire",
  "questions",
  "comprehensionSignals",
  "nextUnitBlueprint" satisfies keyof WaveCloseTurn,
  "conceptUpdates" satisfies keyof WaveCloseTurn,
  "openingText" satisfies keyof CloseBlueprint,
  "plannedConcepts" satisfies keyof CloseBlueprint,
] as const;

/** At most this many key-opening braces are parsed as candidates. */
const MAX_ENVELOPE_CANDIDATES = 20;

/**
 * Envelope check: true when prose OUTSIDE code holds a JSON object with an
 * envelope key at top level. Observed live as the whole message, as a blob
 * trailing the prose, and mid-line (#156). Candidates are braces that open
 * a quoted key, so decoys (LaTeX, set notation) do not use up the cap. Each
 * parses only its balanced `{…}`, so prose after the object cannot hide it.
 * Code is skipped: a fenced `{"questions": …}` is a teaching example, and
 * the secret check already covers a fenced Nalu dump.
 */
function containsResponseEnvelope(prose: string): boolean {
  const trimmed = prose.trim();
  // Pathological-length guard: the scan is O(candidates × length). FAIL
  // CLOSED — beyond the bound we cannot prove the prose is clean, and legit
  // teaching prose never approaches 20k chars; reject rather than let an
  // oversized JSON-imitation leak through the gate.
  if (trimmed.length > 20_000) return true;
  return findBracesOutsideCode(trimmed)
    .filter((brace) => opensJsonKey(trimmed, brace.index))
    .slice(0, MAX_ENVELOPE_CANDIDATES)
    .some((brace) => {
      const candidate = parseJsonObjectAt(trimmed, brace.index);
      return candidate !== null && RESPONSE_ENVELOPE_KEYS.some((key) => key in candidate);
    });
}

/**
 * The JSON object whose `{` sits at `start`, parsed, or null. Parses only up
 * to the matching `}`, so trailing prose does not break the parse.
 */
function parseJsonObjectAt(text: string, start: number): object | null {
  const end = findMatchingBrace(text, start);
  if (end === null) return null;
  try {
    const value: unknown = JSON.parse(text.slice(start, end + 1));
    return typeof value === "object" && value !== null ? value : null;
  } catch {
    // Not JSON (set notation, `{{name}}`, prose braces): not a candidate.
    return null;
  }
}

/**
 * Index of the `}` that closes the `{` at `start`, or null if it never
 * closes. JSON-string aware: braces inside "…" do not count, and a `\`
 * escapes the next character, so `"\"}"` stays one string.
 */
function findMatchingBrace(text: string, start: number): number | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return null;
}
