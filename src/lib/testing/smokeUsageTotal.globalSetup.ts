/**
 * Live-project global setup: one token + cost line for a whole `just smoke`
 * run.
 *
 * WHY: vitest gives each test file its own module state, so the cost tally
 * (`runUsageTally.ts`) restarts per file. `smokeUsageTotal.setup.ts` runs
 * inside every live file and drops that file's totals into a temp
 * directory. This module creates the directory, and its teardown sums the
 * files and prints the one run total. Every live file is covered with no
 * per-file call.
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestProject } from "vitest/node";
import { z } from "zod/v4";
import { formatUsageTotals } from "@/lib/llm/runUsageTally";
import { addUsageTotals, sumUsage, type UsageTotals } from "@/lib/llm/usageCost";

declare module "vitest" {
  /** Values the live project's global setup hands to every test file. */
  export interface ProvidedContext {
    /** Directory where each live test file writes its usage totals. */
    readonly smokeUsageDir: string;
  }
}

/** Shape of one file's totals on disk. Parsed: the file crosses a process boundary. */
const usageTotalsFileSchema = z.object({
  steps: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cachedInputTokens: z.number(),
  reasoningTokens: z.number(),
}) satisfies z.ZodType<UsageTotals>;

/** Make the totals directory; the returned teardown sums it and prints one line. */
export default function setup(project: TestProject): () => void {
  const dir = mkdtempSync(path.join(tmpdir(), "nalu-smoke-usage-"));
  project.provide("smokeUsageDir", dir);

  return () => {
    const files = readdirSync(dir);
    const total = files
      .map((file) =>
        usageTotalsFileSchema.parse(JSON.parse(readFileSync(path.join(dir, file), "utf8"))),
      )
      .reduce(addUsageTotals, sumUsage([]));
    rmSync(dir, { recursive: true, force: true });
    process.stderr.write(
      `\n[llm-usage] smoke run total (${files.length} files): ${formatUsageTotals(total)}\n`,
    );
  };
}
