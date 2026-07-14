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
 * concept NAME (never row ids), zero XP/SM-2 internals on the wire (Core
 * Design Principle), and `courseId` bound by closure from the server-resolved
 * user context — a tool that took courseId from model input would be a
 * cross-user read primitive.
 *
 * Misses answer with a structured `notFound` instead of throwing: a thrown
 * execute surfaces as `tool-error` and burns a loop step on a situation the
 * model can recover from by itself.
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
        const due = await getDueConceptsByCourse(scope.courseId, new Date());
        return {
          dueConcepts: due.slice(0, AGENT_LOOKUP.dueConceptsLimit).map((c) => ({
            name: c.name,
            tier: c.tier,
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
        const rows = await getAssessmentsByConcept(concept.id);
        return {
          conceptName,
          attempts: rows.slice(0, AGENT_LOOKUP.historyAttemptsLimit).map((r) => ({
            isCorrect: r.isCorrect,
            qualityScore: r.qualityScore,
          })),
        };
      },
    }),
  } as const;
}
