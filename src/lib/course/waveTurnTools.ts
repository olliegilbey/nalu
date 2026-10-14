import { tool } from "ai";
import { z } from "zod/v4";
import type { comprehensionSignalSchema } from "@/lib/prompts/waveTurn";
import {
  GRADED_RUBRIC_RULE,
  MC_OPTION_KEYS,
  isPlaceholderRubric,
  placeholderRubricDirective,
  type Question,
  type Questionnaire,
} from "@/lib/prompts/questionnaire";
import { toToolInputSchema } from "@/lib/llm/toCerebrasJsonSchema";
import { WAVE } from "@/lib/config/tuning";

/** One staged grading signal — inferred from the shared prompt-layer schema. */
export type StagedComprehensionSignal = z.infer<typeof comprehensionSignalSchema>;

/**
 * Mutable per-turn staging area filled by tool executes, drained by
 * `persistWaveMidTurn` after the loop ends. Holds CANONICAL shapes (the
 * discriminated unions persistence types against); the tool inputs arrive
 * flat (see below) and are mapped on staging. Mutation is deliberate and
 * contained: one collector per turn attempt, never shared or persisted.
 */
export interface WaveTurnCollector {
  questionnaire: Questionnaire | null;
  signals: StagedComprehensionSignal[];
}

// ---------------------------------------------------------------------------
// FLAT tool-input schemas (wire + validator).
//
// WHY FLAT: the canonical `questionSchema` / `comprehensionSignalSchema` are
// discriminated unions, which render as `anyOf` on the wire. The Task-1 probe
// (docs/status/2026-07-06-tool-call-probe-verdict.md, finding 2) measured
// anyOf-union tool schemas cratering gpt-oss-120b's valid-call rate from
// ~95% to ~44%, with record→array confusion — and the live Task-7
// verification reproduced exactly that (options emitted as an array, invented
// field names, 4/4 invalid calls). The GO verdict was earned with a FLAT
// question shape; these schemas restore it. Type-dependent requirements that
// the union expressed structurally move into `superRefine` directives the
// model can act on in-loop (the SDK feeds them back as tool errors).
// ---------------------------------------------------------------------------

const toolQuestionSchema = z.object({
  id: z.string().describe("Stable identifier, unique within this questionnaire (e.g. 'q1')."),
  type: z.enum(["multiple_choice", "free_text"]).describe("Question kind."),
  prompt: z.string().describe("The question shown to the learner."),
  conceptName: z
    .string()
    .optional()
    .describe(
      "Concept this question assesses - an existing concept name or a new one. Required for every question.",
    ),
  freetextRubric: z
    .string()
    .describe(
      `How to grade the answer if the learner replies in free text: ${GRADED_RUBRIC_RULE}. Never shown to the learner.`,
    ),
  options: z
    .object({ A: z.string(), B: z.string(), C: z.string(), D: z.string() })
    .optional()
    .describe(
      "Four keyed options shown to the learner. Required for multiple_choice; omit for free_text.",
    ),
  correct: z
    .enum(MC_OPTION_KEYS)
    .optional()
    .describe(
      "Correct option key. Never shown to the learner. Required for multiple_choice; omit for free_text.",
    ),
  tier: z.int().positive().optional().describe("Framework tier this question targets."),
});

/** Flat question shape the model emits into `presentQuestionnaire`. */
export type ToolQuestionInput = z.infer<typeof toolQuestionSchema>;

/**
 * The conceptName/correct tightening lives in a superRefine on the TOOL's
 * inputSchema — the SDK feeds a
 * schema violation back to the model as a tool-error result it can correct
 * in the next loop step, replacing the whole-turn retry directive for this
 * case. Directive strings are verbatim from the mega-schema (they were
 * prompt-engineered). The options/duplicate-id checks cover what the
 * canonical union/refines enforced structurally. The free-text rubric check
 * shares baseline's rule and directive (`isPlaceholderRubric`).
 */
const toolQuestionnaireSchema = z
  .object({
    // `.max` is validator-only: Cerebras strict mode rejects `maxItems`, so
    // `toToolInputSchema` strips it from the wire bytes. The description
    // carries the bound to the model; Zod enforces it (issue #63).
    questions: z
      .array(toolQuestionSchema)
      .min(1)
      .max(WAVE.quizMaxQuestions)
      .describe(
        `1-${WAVE.quizMaxQuestions} questions. Every question's id must be unique within this questionnaire.`,
      ),
  })
  .superRefine((val, ctx) => {
    val.questions.forEach((q, idx) => {
      // `!q.conceptName?.trim()` rejects undefined, "", and whitespace-only
      // values — a blank conceptName would upsert a nameless concept downstream.
      if (!q.conceptName?.trim()) {
        ctx.addIssue({
          code: "custom",
          path: ["questions", idx, "conceptName"],
          message: `question ${q.id} is missing required conceptName. Every teaching-quiz question must name the concept it assesses (reuse an existing concept name or introduce a new one). For an open or reflective question you do NOT want graded, ask it in your teaching prose instead.`,
        });
      }
      // MC must carry `correct` so the client can score the click without a
      // round-trip and the grading path has a key to compare against.
      if (q.type === "multiple_choice" && q.correct === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["questions", idx, "correct"],
          message: `MC question ${q.id} is missing required correct key. Every teaching multiple-choice question must mark which option (A, B, C, or D) is correct.`,
        });
      }
      if (q.type === "multiple_choice" && q.options === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["questions", idx, "options"],
          message: `MC question ${q.id} is missing required options. Every multiple-choice question must carry an options object with keys A, B, C and D.`,
        });
      }
      // The next turn grades free text against this rubric. A placeholder
      // leaves the grader no key (issue #22). Same rule as baseline.
      if (q.type === "free_text" && isPlaceholderRubric(q.freetextRubric)) {
        ctx.addIssue({
          code: "custom",
          path: ["questions", idx, "freetextRubric"],
          message: placeholderRubricDirective(q.id),
        });
      }
    });
    // Unique ids within the questionnaire (mirrors questionnaireSchema's
    // refine): a duplicate breaks response matching and collides two
    // assessment rows on the same question_id.
    const ids = val.questions.map((q) => q.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["questions"],
        message: `duplicate question ids within the questionnaire: ${[...new Set(dupes)].join(", ")}. Each question needs a distinct id.`,
      });
    }
  });

/** Map a validated flat tool question to the canonical `Question` union member. */
function toCanonicalQuestion(q: ToolQuestionInput): Question {
  if (q.type === "multiple_choice") {
    if (q.options === undefined) {
      // Unreachable past the superRefine gate; the throw narrows the type.
      throw new Error(`toCanonicalQuestion: MC question ${q.id} without options`);
    }
    return {
      id: q.id,
      type: "multiple_choice",
      prompt: q.prompt,
      options: q.options,
      correct: q.correct,
      freetextRubric: q.freetextRubric,
      conceptName: q.conceptName,
      tier: q.tier,
    };
  }
  return {
    id: q.id,
    type: "free_text",
    prompt: q.prompt,
    freetextRubric: q.freetextRubric,
    conceptName: q.conceptName,
    tier: q.tier,
  };
}

const toolSignalSchema = z.object({
  kind: z
    .enum(["mc-index", "free-text"])
    .describe(
      "mc-index when the learner clicked a multiple-choice option; free-text when they typed an answer.",
    ),
  questionId: z
    .string()
    .describe("Verbatim question id from the prompt — match the question the learner answered."),
  verdict: z
    .enum(["correct", "partial", "incorrect"])
    .optional()
    .describe(
      "Required for free-text answers. Judge the learner's text. 'correct' captures the key idea; 'partial' some grasp + missing pieces; 'incorrect' misses or wrong.",
    ),
  // Wire-friendly integer range; canonical qualityScoreSchema is a literal
  // union (anyOf on the wire — the exact shape the probe verdict forbids).
  qualityScore: z
    .int()
    .min(0)
    .max(5)
    .optional()
    .describe(
      "Required for free-text answers. 0-5. correct → 4-5, partial → 2-3, incorrect → 0-1.",
    ),
  rationale: z
    .string()
    .describe("Two sentences. First: what the answer tells you. Second: what to teach next."),
});

const toolSignalsInputSchema = z
  .object({
    signals: z
      .array(toolSignalSchema)
      .min(1)
      .describe("One grading signal per question the learner answered last turn."),
  })
  .superRefine((val, ctx) => {
    val.signals.forEach((s, idx) => {
      // The canonical discriminated union requires verdict + qualityScore on
      // free-text signals structurally; flat wire moves it into a directive.
      if (s.kind === "free-text" && (s.verdict === undefined || s.qualityScore === undefined)) {
        ctx.addIssue({
          code: "custom",
          path: ["signals", idx],
          message: `free-text signal for question ${s.questionId} is missing required verdict and/or qualityScore. Every free-text grading signal must carry verdict (correct, partial, or incorrect) and qualityScore (0-5).`,
        });
      }
    });
  });

/** Map a validated flat signal to the canonical discriminated union member. */
function toCanonicalSignal(s: z.infer<typeof toolSignalSchema>): StagedComprehensionSignal {
  if (s.kind === "free-text") {
    if (s.verdict === undefined || s.qualityScore === undefined) {
      // Unreachable past the superRefine gate; the throw narrows the type.
      throw new Error(`toCanonicalSignal: free-text signal ${s.questionId} without verdict/score`);
    }
    return {
      kind: "free-text",
      questionId: s.questionId,
      verdict: s.verdict,
      // Int 0-5 is exactly the canonical literal union's value set.
      qualityScore: s.qualityScore as 0 | 1 | 2 | 3 | 4 | 5,
      rationale: s.rationale,
    };
  }
  return { kind: "mc-index", questionId: s.questionId, rationale: s.rationale };
}

/** Tool set + collector pair returned by {@link buildWaveMidTurnTools}. */
export interface WaveMidTurnToolkit {
  readonly tools: {
    readonly recordComprehensionSignals: ReturnType<typeof buildRecordSignalsTool>;
    readonly presentQuestionnaire: ReturnType<typeof buildPresentQuestionnaireTool>;
  };
  readonly collector: WaveTurnCollector;
}

/** What the Harness knows about one mid-turn before its tool loop starts. */
export interface WaveMidTurnToolScope {
  /** Ids of the questions the learner answered this turn; empty on a chat turn. */
  readonly answeredQuestionIds: readonly string[];
}

/**
 * Refusal text for a repeat signal. With nothing left ungraded it keeps its
 * pre-#144 bytes. With answers still ungraded it drops "continue teaching",
 * which would contradict the nudge to call again.
 */
const repeatSignalReason = (answersStillUngraded: boolean): string =>
  `a grading signal for these questions was already recorded this turn. The first grading stands. Do not resend it${answersStillUngraded ? "." : "; continue teaching."}`;

/**
 * In-loop coverage nudge (issue #144). It names the answered questions that
 * still lack a signal, so the model completes a partial call inside the
 * loop rather than failing the post-loop gate.
 */
const ungradedNextStep = (ids: readonly string[]): string =>
  `Questions ${ids.join(", ")} were answered but have no grading signal yet. Call recordComprehensionSignals again with one signal for each, before you continue teaching.`;

// Tool builders are module-private; splitting them out keeps the exported
// factory small and gives WaveMidTurnToolkit precise inferred tool types.
function buildRecordSignalsTool(collector: WaveTurnCollector, scope: WaveMidTurnToolScope) {
  return tool({
    description:
      "Record your grading of answers the learner just submitted. Call before teaching, when the learner answered questions last turn. Omit for pure teaching turns.",
    // Wire/validator split — union-free wire bytes, null-absorbing Zod
    // validation (docs/status/2026-07-06-tool-call-probe-verdict.md).
    inputSchema: toToolInputSchema(toolSignalsInputSchema, {
      name: "record_comprehension_signals_input",
    }),
    // Staging ONLY — no DB access, no XP, no SM-2 (Core Design Principle:
    // deterministic code consumes the collector after the loop ends).
    execute: async ({ signals }) => {
      // One signal per questionId per turn (issue #61). A second one would
      // grade the same assessment row twice and double the XP floater. The
      // first signal stands; later ones, in this call or an earlier one, are
      // refused. REJECT, not silent dedup: the model learns its re-grade did
      // not land, the same pattern as presentQuestionnaire's refusal.
      // First wins, not last: the coverage nudge below invites a second
      // call, and a model that resends the whole set must not re-grade an
      // answer it already scored.
      const staged = new Set(collector.signals.map((s) => s.questionId));
      const isFirst = (s: (typeof signals)[number], idx: number) =>
        !staged.has(s.questionId) &&
        signals.findIndex((o) => o.questionId === s.questionId) === idx;
      const accepted = signals.filter(isFirst);
      // Each refused id once: three q1 signals refuse "q1", not "q1","q1".
      const rejected = [
        ...new Set(signals.filter((s, idx) => !isFirst(s, idx)).map((s) => s.questionId)),
      ];
      collector.signals.push(...accepted.map(toCanonicalSignal));
      // Coverage over EVERY call so far: calls merge into one collector.
      // Partial signals stay staged; this is a nudge, not a throw. A thrown
      // execute becomes a tool-error part, whose replay is issue #147.
      const graded = new Set(collector.signals.map((s) => s.questionId));
      const ungraded = scope.answeredQuestionIds.filter((id) => !graded.has(id));
      // The common case keeps its old result bytes: `{ recorded }` alone.
      // The refusal fields appear only when something was refused. The
      // reason names the next step, so the model does not resend the ids
      // and burn loop Steps. The coverage fields appear only when answered
      // questions are still ungraded, so a chat turn never carries them.
      return {
        recorded: accepted.length,
        ...(rejected.length > 0
          ? { rejected, reason: repeatSignalReason(ungraded.length > 0) }
          : {}),
        ...(ungraded.length > 0
          ? { stillUngraded: ungraded, nextStep: ungradedNextStep(ungraded) }
          : {}),
      };
    },
  });
}

function buildPresentQuestionnaireTool(collector: WaveTurnCollector) {
  return tool({
    description: `Present a graded concept-check quiz (1-${WAVE.quizMaxQuestions} questions) to the learner. Call at most once per turn, before you write your message. The learner sees the quiz card below your message, so never write the questions in your message. Every question carries conceptName; every multiple-choice question carries options and correct (A, B, C, or D).`,
    inputSchema: toToolInputSchema(toolQuestionnaireSchema, {
      name: "present_questionnaire_input",
    }),
    execute: async (questionnaire) => {
      if (collector.questionnaire !== null) {
        // Model-readable refusal — comes back as the tool result so the
        // model self-corrects within the loop instead of a harness retry.
        return { accepted: false, reason: "a questionnaire was already presented this turn" };
      }
      collector.questionnaire = { questions: questionnaire.questions.map(toCanonicalQuestion) };
      return { accepted: true, questionCount: questionnaire.questions.length };
    },
  });
}

/**
 * Build the mid-turn tool set bound to a fresh collector. Executes are
 * STAGING ONLY — validated input maps to canonical shapes in the collector;
 * the existing post-loop transaction (`persistWaveMidTurn`) consumes it
 * exactly as it consumed the mega-schema fields. Descriptions reuse the
 * `.describe()` guidance from the old mega-schema. The answered ids are
 * bound by closure, as `courseId` is for the lookup tools.
 */
export function buildWaveMidTurnTools(scope: WaveMidTurnToolScope): WaveMidTurnToolkit {
  const collector: WaveTurnCollector = { questionnaire: null, signals: [] };
  return {
    tools: {
      recordComprehensionSignals: buildRecordSignalsTool(collector, scope),
      presentQuestionnaire: buildPresentQuestionnaireTool(collector),
    },
    collector,
  };
}
