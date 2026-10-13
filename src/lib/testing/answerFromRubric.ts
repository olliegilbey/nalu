/**
 * Correct-by-construction free-text answers for the live smoke (issue #22).
 *
 * A graded rubric states what a correct answer contains. Restating it as the
 * learner's answer gives the grader a known-correct reply, so a `q=0` grading
 * on it points at the grader, and `xp=0` on a high `q` points at XP plumbing.
 */

/** Grader lead-ins end here: "Accept explanation that …", "Answer should note that …". */
const LEAD_IN_END = " that ";

/** A learner answer that meets `rubric`: the rubric's claim, minus any grader lead-in. */
export function answerFromRubric(rubric: string): string {
  // Drop the lead-in so the answer reads as a claim, not a grading note.
  // A rubric without one ("Mentions the #[entry] attribute.") is used as-is.
  const end = rubric.indexOf(LEAD_IN_END);
  return end === -1 ? rubric : rubric.slice(end + LEAD_IN_END.length);
}
