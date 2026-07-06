import type { Course } from "@/db/schema";
import type { Wave } from "@/db/schema";
import type { WaveSeedInputs, WaveOutputContract } from "@/lib/types/context";
import type {
  ClarificationJsonb,
  DueConceptsSnapshot,
  FrameworkJsonb,
  SeedSource,
} from "@/lib/types/jsonb";

/**
 * Compose `WaveSeedInputs` from a Course row + Wave row for `executeTurn`.
 *
 * `outputContract` is the caller's transport declaration ("tools" = streaming
 * tool-loop turns, "json" = blocking mega-schema turns) — it selects the
 * teaching system prompt's output-format block. Explicit at every call site
 * so a transport can't silently render the wrong prompt.
 *
 * `topicScope` is derived from the clarification responses (already persisted
 * on `courses.clarification`); concatenating them gives the LLM a plain-text
 * reminder of the agreed scope without re-parsing.
 *
 * `course.clarification` is JSONB validated by `courseRowGuard`
 * (`src/db/queries/courses.ts`) on every read, so the `as` cast here is safe
 * — Drizzle's row type widens JSONB to `unknown`, but the runtime shape is
 * guaranteed by the read-side guard.
 */
export function buildWaveSeed(
  course: Course,
  wave: Wave,
  outputContract: WaveOutputContract,
): WaveSeedInputs {
  // Validated upstream by `courseRowGuard` — see file-level comment.
  const clarification = (course.clarification as ClarificationJsonb | null) ?? null;
  const topicScope = clarification
    ? clarification.responses
        .map((r) => r.freetext ?? "")
        .filter(Boolean)
        .join(" / ")
    : "";
  // Wave JSONB fields are validated upstream by `waveRowGuard` so these casts
  // are safe — Drizzle widens JSONB columns to `unknown` but the runtime shape
  // is guaranteed by the read-side guard.
  return {
    kind: "wave",
    courseTopic: course.topic,
    topicScope,
    framework: wave.frameworkSnapshot as FrameworkJsonb,
    currentTier: wave.tier,
    customInstructions: wave.customInstructionsSnapshot,
    courseSummary: course.summary,
    dueConcepts: wave.dueConceptsSnapshot as DueConceptsSnapshot,
    seedSource: wave.seedSource as SeedSource,
    outputContract,
  };
}
