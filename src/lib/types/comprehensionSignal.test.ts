import { describe, expectTypeOf, it } from "vitest";
import type { WaveMidTurnToolkit, WaveTurnCollector } from "@/lib/course/waveTurnTools";
import type { ComprehensionSignal } from "./comprehensionSignal";

// Type-level pins (issue #119). `expectTypeOf` does nothing at runtime;
// `tsc --noEmit` fails the moment either side drifts.

/** One flat signal, as the grading tool's execute receives it. */
type FlatToolSignal = Parameters<
  NonNullable<WaveMidTurnToolkit["tools"]["recordComprehensionSignals"]["execute"]>
>[0]["signals"][number];

describe("ComprehensionSignal", () => {
  it("keeps the exact shape the retired Zod schema inferred", () => {
    expectTypeOf<ComprehensionSignal>().toEqualTypeOf<
      | { kind: "mc-index"; questionId: string; rationale: string }
      | {
          kind: "free-text";
          questionId: string;
          verdict: "correct" | "partial" | "incorrect";
          qualityScore: 0 | 1 | 2 | 3 | 4 | 5;
          rationale: string;
        }
    >();
  });

  it("is the shape the grading tool's execute stages into the collector", () => {
    expectTypeOf<WaveTurnCollector["signals"][number]>().toEqualTypeOf<ComprehensionSignal>();
  });

  it("covers every kind the flat tool input accepts", () => {
    // `toCanonicalSignal` maps any kind that is not "free-text" to
    // "mc-index". A new wire kind would compile and be misfiled silently.
    expectTypeOf<FlatToolSignal["kind"]>().toEqualTypeOf<ComprehensionSignal["kind"]>();
  });
});
