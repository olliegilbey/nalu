import { tool } from "ai";
import { z } from "zod/v4";
import { getDueConceptsByCourse, getConceptByNameForCourse } from "@/db/queries/concepts";
import { getAssessmentsByConcept } from "@/db/queries/assessments";
import { AGENT_LOOKUP } from "@/lib/config/tuning";
import { toToolInputSchema } from "@/lib/llm/toCerebrasJsonSchema";

/** Scope for one turn's lookup tools — always the server-resolved course. */
export interface WaveLookupScope {
  readonly courseId: string;
}

/**
 * Read-only learner-state lookup tools for the mid-Wave teaching agent
 * (agent-loop plan Task 3). Contract: compact capped projections, keyed by
 * concept NAME (never row ids), zero XP and no SM-2 schedule state on the
 * wire (Core Design Principle; `lastQuality` is the one deliberate exception,
 * see below), and `courseId` bound by closure from the server-resolved
 * user context — a tool that took courseId from model input would be a
 * cross-user read primitive.
 *
 * Misses answer with a structured `notFound` instead of throwing: a thrown
 * execute surfaces as `tool-error` and burns a loop step on a situation the
 * model can recover from by itself.
 *
 * Builds both; `buildWaveMidTurnAgent` offers `getDueConcepts` only in
 * `"hint"` due-review mode (audit F4).
 */
export function buildWaveLookupTools(scope: WaveLookupScope) {
  return {
    getDueConcepts: tool({
      description:
        `List concepts currently due for spaced-repetition review in this course ` +
        `(max ${AGENT_LOOKUP.dueConceptsLimit}, most overdue first). Use when deciding ` +
        `what to weave into teaching or quiz next.`,
      inputSchema: toToolInputSchema(z.object({}), { name: "get_due_concepts_input" }),
      execute: async () => {
        // The cap is SQL LIMIT: an overdue backlog is never fetched whole.
        const due = await getDueConceptsByCourse(
          scope.courseId,
          new Date(),
          AGENT_LOOKUP.dueConceptsLimit,
        );
        return {
          dueConcepts: due.map((c) => ({
            name: c.name,
            tier: c.tier,
            // Kept on purpose (Ollie, issue #62): the last 0-5 quality score
            // is a teaching signal, not XP, and the model cannot change it.
            // It lets the tutor target the concepts the learner found weak.
            lastQuality: c.lastQualityScore,
          })),
        };
      },
    }),
    getConceptHistory: tool({
      description:
        `Fetch this learner's assessment history for one named concept ` +
        `(last ${AGENT_LOOKUP.historyAttemptsLimit} attempts, most recent first). ` +
        `Use before re-teaching something they've struggled with.`,
      inputSchema: toToolInputSchema(
        z.object({
          conceptName: z
            .string()
            .min(1)
            .describe("Exact concept name as it appears in this course (case-insensitive)."),
        }),
        { name: "get_concept_history_input" },
      ),
      execute: async ({ conceptName }) => {
        const concept = await getConceptByNameForCourse(scope.courseId, conceptName);
        if (concept === null) {
          return { conceptName, attempts: [], notFound: true };
        }
        const rows = await getAssessmentsByConcept(concept.id, AGENT_LOOKUP.historyAttemptsLimit);
        return {
          conceptName,
          attempts: rows.map((r) => ({
            isCorrect: r.isCorrect,
            qualityScore: r.qualityScore,
          })),
        };
      },
    }),
  } as const;
}
