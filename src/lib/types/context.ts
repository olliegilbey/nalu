import type { FrameworkJsonb, DueConceptsSnapshot, SeedSource } from "@/lib/types/jsonb";

/**
 * Structured inputs to `renderContext` for a teaching Wave (spec §9.1).
 *
 * Mirrors the snapshot columns on `waves` plus the live course summary.
 * Wave-renderable state is fully described here — `renderContext` is pure
 * over these inputs.
 */
export interface WaveSeedInputs {
  readonly kind: "wave";
  readonly courseTopic: string;
  /** From clarification answers — the agreed scope for this course. */
  readonly topicScope: string;
  /** = waves.framework_snapshot — frozen at Wave open. */
  readonly framework: FrameworkJsonb;
  /** = waves.tier — the tier this Wave is teaching at. */
  readonly currentTier: number;
  readonly customInstructions: string | null;
  /** courses.summary at Wave-open time; null for first Wave. */
  readonly courseSummary: string | null;
  /** Used to render the static <due_for_review> block at Wave start. */
  readonly dueConcepts: DueConceptsSnapshot;
  readonly seedSource: SeedSource;
}

/**
 * Structured inputs to `renderContext` for a scoping pass (spec §9.1).
 *
 * Scoping is one Context across clarify → framework → baseline steps;
 * the system prompt frames the multi-turn discipline. Specific per-turn
 * envelopes are built by `renderStageEnvelope` in `src/lib/prompts/scoping.ts`
 * and arrive as user-role `context_messages` rows.
 */
export interface ScopingSeedInputs {
  readonly kind: "scoping";
  readonly topic: string;
}

export type SeedInputs = WaveSeedInputs | ScopingSeedInputs;
