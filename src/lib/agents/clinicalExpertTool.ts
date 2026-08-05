import { tool } from "ai";
import { z } from "zod/v4";
import { askClinicalExpert } from "@/lib/llm/cortiExpert";

/**
 * `askClinicalExpert` tool for the mid-Wave teaching agent: delegates
 * clinical questions to Nalu's hosted Corti expert agent over A2A.
 * Execute never throws — failures come back as a model-readable `{ error }`
 * so the teaching loop degrades to answering from its own knowledge instead
 * of crashing the turn.
 */
export function buildAskClinicalExpertTool() {
  return tool({
    description:
      "Consult a hosted clinical domain expert for authoritative medical knowledge: clinical facts, guideline recommendations, dosages, red flags, differentials, exam findings, mechanisms. " +
      "Strongly prefer consulting the expert over answering from memory for ANY clinical claim a learner will rely on - ask more rather than less. " +
      "Ask one focused question per call; you may call this several times in a turn.",
    inputSchema: z.object({
      question: z
        .string()
        .min(1)
        .describe("One focused clinical question for the expert, self-contained (no chat context)"),
    }),
    execute: async ({ question }) => {
      try {
        const reply = await askClinicalExpert(question);
        return { answer: reply.answer };
      } catch (err) {
        return {
          error: `clinical expert unavailable (${err instanceof Error ? err.message : "unknown error"}) - answer from your own knowledge and say when you are uncertain`,
        };
      }
    },
  });
}
