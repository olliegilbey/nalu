import { describe, it, expect } from "vitest";
import { calculateMcXp } from "@/lib/scoring/xp";
import { deriveMcXpAward, isTypedCorrectMcAnswer } from "./deriveMcXpAward";
import type { ChoiceQuestion } from "./adaptQuestionnaire";

const capital: ChoiceQuestion = {
  id: "q1",
  prompt: "Capital of France?",
  options: ["Paris", "Lyon", "Nice", "Lille"],
  correctIndex: 0,
  tier: 3,
};

describe("deriveMcXpAward", () => {
  it("keys the award by questionnaire buffer key and question id", () => {
    const award = deriveMcXpAward(capital, { persistKey: "nalu:wave:w1:q:a", questionsKey: "q1" });
    expect(award.key).toBe("nalu:wave:w1:q:a:q1");
  });

  it("falls back to the question ids when the card has no buffer key", () => {
    expect(deriveMcXpAward(capital, { questionsKey: "q1|q2" }).key).toBe("q1|q2:q1");
  });

  it("awards XP for the question's own tier first", () => {
    const award = deriveMcXpAward(capital, { questionsKey: "q1", waveTier: 1 });
    expect(award.amount).toBe(calculateMcXp(3, true));
  });

  it("falls back to the Wave tier, then to tier 1", () => {
    const { tier: _tier, ...untiered } = capital;
    expect(deriveMcXpAward(untiered, { questionsKey: "q1", waveTier: 2 }).amount).toBe(
      calculateMcXp(2, true),
    );
    expect(deriveMcXpAward(untiered, { questionsKey: "q1" }).amount).toBe(calculateMcXp(1, true));
  });
});

describe("isTypedCorrectMcAnswer", () => {
  it("is true for the correct option's text typed verbatim", () => {
    expect(isTypedCorrectMcAnswer(capital, "Paris")).toBe(true);
  });

  // "Lyon" names a wrong option. "paris" is not verbatim, so it ships as free text.
  it.each(["Lyon", "paris", "Paris, France"])("is false for %s", (answer) => {
    expect(isTypedCorrectMcAnswer(capital, answer)).toBe(false);
  });

  it("is false for an ungraded MC question, which has no answer key", () => {
    const { correctIndex: _correct, ...ungraded } = capital;
    expect(isTypedCorrectMcAnswer(ungraded, "Paris")).toBe(false);
  });

  it("is false for a free-text question", () => {
    expect(isTypedCorrectMcAnswer({ id: "q2", prompt: "Why?", options: [] }, "Paris")).toBe(false);
  });
});
