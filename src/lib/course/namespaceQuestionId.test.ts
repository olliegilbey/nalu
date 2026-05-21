import { describe, it, expect } from "vitest";
import { namespaceQuestionId } from "./namespaceQuestionId";

/**
 * Unit tests for the pure `namespaceQuestionId` helper. The collision-recovery
 * behaviour it enables is covered end-to-end in
 * `assessments.integration.test.ts` (cross-questionnaire + intra-questionnaire
 * reuse against the partial unique index); here we only pin the string shape
 * the insert and grading paths both rely on.
 */
describe("namespaceQuestionId", () => {
  it("prefixes the raw question id with the questionnaire id and a colon", () => {
    expect(namespaceQuestionId("aaaa-1111", "q1")).toBe("aaaa-1111:q1");
  });

  it("produces distinct values for the same raw id under different questionnaires", () => {
    // The whole point: two questionnaires reusing `q1` must not collide.
    expect(namespaceQuestionId("turn-3-msg", "q1")).not.toBe(
      namespaceQuestionId("turn-6-msg", "q1"),
    );
  });

  it("produces distinct values for different raw ids under the same questionnaire", () => {
    expect(namespaceQuestionId("msg-x", "q1")).not.toBe(namespaceQuestionId("msg-x", "q2"));
  });

  it("is deterministic — re-deriving from the same inputs yields the same key", () => {
    // The insert path namespaces with `assistantMessageId`; the grading paths
    // re-derive with the open questionnaire's `questionnaireId` (the same id).
    const inserted = namespaceQuestionId("msg-1", "q1");
    const reDerived = namespaceQuestionId("msg-1", "q1");
    expect(reDerived).toBe(inserted);
  });
});
