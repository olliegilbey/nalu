/**
 * Live-project setup file: after each live test file, write that file's
 * token + cost tally to the run's totals directory. The global setup
 * (`smokeUsageTotal.globalSetup.ts`) sums the files into one line.
 *
 * Setup files share the test file's module state, so `getRunUsageTally`
 * here reads the same tally the file's LLM calls fed.
 */

import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, inject } from "vitest";
import { getRunUsageTally } from "@/lib/llm/runUsageTally";

afterAll(() => {
  const file = path.join(inject("smokeUsageDir"), `${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify(getRunUsageTally()));
});
