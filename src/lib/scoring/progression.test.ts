import { describe, it, expect } from "vitest";
import { checkTierAdvancement } from "./progression";
import type { ConceptState } from "@/lib/types/scoring";

const concept = (q: number): ConceptState => ({ lastQualityScore: q });

describe("checkTierAdvancement", () => {
  describe("minimum concept threshold (5)", () => {
    it("empty array → cannot advance", () => {
      const r = checkTierAdvancement([]);
      expect(r.canAdvance).toBe(false);
      expect(r.minimumConceptsMet).toBe(false);
      expect(r.totalConcepts).toBe(0);
    });

    it("4 concepts all passing → cannot advance (below min 5)", () => {
      const r = checkTierAdvancement([concept(5), concept(5), concept(5), concept(5)]);
      expect(r.canAdvance).toBe(false);
      expect(r.minimumConceptsMet).toBe(false);
      expect(r.passingPercentage).toBe(1);
    });

    it("exactly 5 concepts all passing → can advance", () => {
      const r = checkTierAdvancement([concept(3), concept(4), concept(5), concept(3), concept(4)]);
      expect(r.canAdvance).toBe(true);
      expect(r.minimumConceptsMet).toBe(true);
      expect(r.totalConcepts).toBe(5);
      expect(r.passingConcepts).toBe(5);
    });
  });

  describe("80% passing threshold", () => {
    it("5 concepts, 4 passing (80%) → can advance (inclusive)", () => {
      const r = checkTierAdvancement([concept(3), concept(4), concept(5), concept(3), concept(2)]);
      expect(r.canAdvance).toBe(true);
      expect(r.passingConcepts).toBe(4);
      expect(r.passingPercentage).toBe(0.8);
    });

    it("5 concepts, 3 passing (60%) → cannot advance", () => {
      const r = checkTierAdvancement([concept(3), concept(4), concept(5), concept(1), concept(0)]);
      expect(r.canAdvance).toBe(false);
      expect(r.passingConcepts).toBe(3);
    });

    it("10 concepts, 8 passing → can advance", () => {
      const states: readonly ConceptState[] = [
        concept(4),
        concept(4),
        concept(4),
        concept(4),
        concept(4),
        concept(4),
        concept(4),
        concept(4),
        concept(1),
        concept(2),
      ];
      const r = checkTierAdvancement(states);
      expect(r.canAdvance).toBe(true);
      expect(r.passingPercentage).toBe(0.8);
    });

    it("10 concepts, 7 passing → cannot advance", () => {
      const states: readonly ConceptState[] = [
        concept(4),
        concept(4),
        concept(4),
        concept(4),
        concept(4),
        concept(4),
        concept(4),
        concept(1),
        concept(2),
        concept(0),
      ];
      const r = checkTierAdvancement(states);
      expect(r.canAdvance).toBe(false);
    });
  });

  describe("quality boundary", () => {
    it("quality exactly 3 counts as passing", () => {
      const r = checkTierAdvancement([concept(3), concept(3), concept(3), concept(3), concept(3)]);
      expect(r.canAdvance).toBe(true);
      expect(r.passingConcepts).toBe(5);
    });

    it("quality exactly 2 does not count as passing", () => {
      const r = checkTierAdvancement([concept(2), concept(2), concept(2), concept(2), concept(2)]);
      expect(r.canAdvance).toBe(false);
      expect(r.passingConcepts).toBe(0);
    });
  });
});
