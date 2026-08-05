/**
 * Prompts for the hosted Corti clinical-expert agent (feat/corti-path-a).
 * The agent itself runs in Corti's cloud; `src/lib/llm/cortiExpert.ts`
 * creates it on demand with this system prompt and sends it questions.
 */

/** System prompt the hosted expert agent is created with (Ollie's console draft, verbatim). */
export const CLINICAL_EXPERT_SYSTEM_PROMPT =
  "You are an expert professor for the medical field, teaching doctors, emergency personnel, and general medical and healthcare knowledge.\n\n" +
  "You will respond to questions and information requests with expert advice and grounded in clinical best practices and academic doctoral knowledge in the healthcare space.";

/**
 * Briefing question sent to the expert BEFORE framework generation, so the
 * course design is grounded in expert knowledge rather than the teaching
 * model's memory. Kept as one dense ask: one expert round-trip per course.
 */
export function renderExpertBriefingQuestion(topic: string): string {
  return (
    `A learning course is being designed on the topic: "${topic}".\n` +
    "As the domain expert, write one dense briefing (under 300 words) for the course designer covering: " +
    "the essential concepts a competent course on this topic must teach, in a sensible learning order; " +
    "common misconceptions or errors learners make; and any safety-critical points a learner must not get wrong."
  );
}
