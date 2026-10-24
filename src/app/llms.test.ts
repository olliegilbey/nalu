import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SITE_URL } from "@/lib/config/site";
import { BASELINE, FRAMEWORK, PROGRESSION, SCOPING, WAVE } from "@/lib/config/tuning";

/*
 * `public/llms.txt` is the agent-facing summary of Nalu (llmstxt.org). It is a
 * static file, so these checks stand in for a type checker: the format the
 * spec requires, the glossary terms, the tuned numbers it quotes, and links
 * that match `SITE_URL`.
 */

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const llmsTxt = readFileSync(path.join(REPO_ROOT, "public/llms.txt"), "utf8");

describe("public/llms.txt", () => {
  it("opens with the H1 and blockquote summary the llms.txt spec sets", () => {
    const [h1, blank, summary] = llmsTxt.split("\n");
    expect(h1).toBe("# Nalu");
    expect(blank).toBe("");
    expect(summary).toMatch(/^> \S/);
  });

  it("keeps the prose heading-free and puts only link lists under H2s", () => {
    // llmstxt.org: details before the first H2 are any markdown but headings.
    // Each H2 section is a file list of `- [title](url): notes` items.
    const [details = "", ...fileLists] = llmsTxt.split(/^## .*$/m);
    const detailHeadings = details
      .split("\n")
      .slice(1) // the H1
      .filter((line) => line.startsWith("#"));
    expect(detailHeadings).toEqual([]);
    expect(fileLists.length).toBeGreaterThan(0);
    for (const section of fileLists) {
      for (const line of section.split("\n").filter((text) => text.trim() !== "")) {
        expect(line).toMatch(/^- \[[^\]]+\]\(\S+\)(: .+)?$/);
      }
    }
  });

  // A retune in `tuning.ts` fails here until llms.txt says the new number.
  it.each([
    `asks ${SCOPING.minClarifyAnswers}-${SCOPING.maxClarifyAnswers} clarifying questions`,
    `Framework of ${FRAMEWORK.minTiers}-${FRAMEWORK.maxTiers} Tiers`,
    `Baseline quiz of ${BASELINE.minQuestions}-${BASELINE.maxQuestions} questions`,
    `at least ${PROGRESSION.minimumConceptsPerTier} current-Tier Concepts`,
    `${PROGRESSION.passingRatio * 100}% of them last scored ${PROGRESSION.passingQualityScore} or more`,
    `${WAVE.turnCount} by default`,
  ])("quotes the tuned value: %s", (phrase) => {
    expect(llmsTxt).toContain(phrase);
  });

  it.each([
    "Scoping",
    "Framework",
    "Tier",
    "Baseline",
    "Concept",
    "Wave",
    "Turn",
    "Context",
    "Harness",
    "XP",
    "SM-2",
  ])("defines the glossary term %s", (term) => {
    expect(llmsTxt).toContain(`- **${term}**: `);
  });

  it("says deterministic code owns the score, not the model", () => {
    expect(llmsTxt).toContain("The model never sees XP");
  });

  it("links only to the production origin in SITE_URL", () => {
    const links = [...llmsTxt.matchAll(/\]\((\S+?)\)/g)].map((match) => match[1]);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link?.startsWith(`${SITE_URL}/`)).toBe(true);
  });
});
