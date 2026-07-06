import { tool } from "ai";
import { z } from "zod/v4";
import { comprehensionSignalSchema } from "@/lib/prompts/waveTurn";
import { questionnaireSchema, type Questionnaire } from "@/lib/prompts/questionnaire";
import { toToolInputSchema } from "@/lib/llm/toCerebrasJsonSchema";

/** One staged grading signal — inferred from the shared prompt-layer schema. */
export type StagedComprehensionSignal = z.infer<typeof comprehensionSignalSchema>;

/**
 * Mutable per-turn staging area filled by tool executes, drained by
 * `persistWaveMidTurn` after the loop ends. Mutation is deliberate and
 * contained: one collector per turn attempt, never shared or persisted.
 */
export interface WaveTurnCollector {
  questionnaire: Questionnaire | null;
  signals: StagedComprehensionSignal[];
}

/**
 * The conceptName/correct tightening that lived in `waveMidTurnSchema`'s
 * superRefine moves here, onto the TOOL's inputSchema — the SDK feeds a
 * schema violation back to the model as a tool-error result it can correct
 * in the next loop step, replacing the whole-turn retry directive for this
 * case. Directive strings are verbatim from the mega-schema (they were
 * prompt-engineered; only the issue paths changed — the tool input IS the
 * questionnaire, so there is no leading "questionnaire" path segment).
 */
const tightQuestionnaireSchema = questionnaireSchema.superRefine((val, ctx) => {
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
  });
});

const recordSignalsInputSchema = z.object({
  signals: z
    .array(comprehensionSignalSchema)
    .min(1)
    .describe("One grading signal per question the learner answered last turn."),
});

/** Tool set + collector pair returned by {@link buildWaveMidTurnTools}. */
export interface WaveMidTurnToolkit {
  readonly tools: {
    readonly recordComprehensionSignals: ReturnType<typeof buildRecordSignalsTool>;
    readonly presentQuestionnaire: ReturnType<typeof buildPresentQuestionnaireTool>;
  };
  readonly collector: WaveTurnCollector;
}

// Tool builders are module-private; splitting them out keeps the exported
// factory small and gives WaveMidTurnToolkit precise inferred tool types.
function buildRecordSignalsTool(collector: WaveTurnCollector) {
  return tool({
    description:
      "Record your grading of answers the learner just submitted. Call once, before teaching, when the learner answered questions last turn. Omit for pure teaching turns.",
    // Wire/validator split — union-free wire bytes, null-absorbing Zod
    // validation (docs/status/2026-07-06-tool-call-probe-verdict.md).
    inputSchema: toToolInputSchema(recordSignalsInputSchema, {
      name: "record_comprehension_signals_input",
    }),
    // Staging ONLY — no DB access, no XP, no SM-2 (Core Design Principle:
    // deterministic code consumes the collector after the loop ends).
    execute: async ({ signals }) => {
      collector.signals.push(...signals);
      return { recorded: signals.length };
    },
  });
}

function buildPresentQuestionnaireTool(collector: WaveTurnCollector) {
  return tool({
    description:
      "Present a graded concept-check quiz (1-3 questions) to the learner. Call at most once per turn, after your teaching prose. Every question carries conceptName; every multiple-choice question carries correct (A, B, C, or D).",
    inputSchema: toToolInputSchema(tightQuestionnaireSchema, {
      name: "present_questionnaire_input",
    }),
    execute: async (questionnaire) => {
      if (collector.questionnaire !== null) {
        // Model-readable refusal — comes back as the tool result so the
        // model self-corrects within the loop instead of a harness retry.
        return { accepted: false, reason: "a questionnaire was already presented this turn" };
      }
      collector.questionnaire = questionnaire;
      return { accepted: true, questionCount: questionnaire.questions.length };
    },
  });
}

/**
 * Build the mid-turn tool set bound to a fresh collector. Executes are
 * STAGING ONLY — validated input goes into the collector; the existing
 * post-loop transaction (`persistWaveMidTurn`) consumes it exactly as it
 * consumed the mega-schema fields. Descriptions reuse the `.describe()`
 * guidance from the old mega-schema.
 */
export function buildWaveMidTurnTools(): WaveMidTurnToolkit {
  const collector: WaveTurnCollector = { questionnaire: null, signals: [] };
  return {
    tools: {
      recordComprehensionSignals: buildRecordSignalsTool(collector),
      presentQuestionnaire: buildPresentQuestionnaireTool(collector),
    },
    collector,
  };
}
