/**
 * One-shot probe to verify a Cerebras model is reachable on the current
 * free-tier key and honours strict-mode JSON-schema constrained decoding.
 * Reads LLM_MODEL from the environment, issues a plain-text call followed
 * by a strict-mode call, prints results + token usage, then exits.
 *
 * Run via: `just probe-model <model-name>` (wraps with `op run` so the
 * 1Password reference in .env.local resolves).
 *
 * Used when picking the floor model — Cerebras free-tier availability and
 * deprecation cliffs shift; this script verifies a candidate before we
 * commit to it in `.env.local` / `modelCapabilities.ts`.
 */

/* eslint-disable no-console -- CLI script: console is the output channel. */

import { z } from "zod/v4";
import { generateChat } from "@/lib/llm/generate";

const PROBE_SCHEMA = z.object({
  word: z.literal("OK"),
  count: z.literal(1),
});

async function main(): Promise<void> {
  const model = process.env.LLM_MODEL;
  if (!model || model.length === 0) {
    console.error("LLM_MODEL env not set");
    process.exit(1);
  }
  console.log(`Probing model: ${model}`);

  // Plain text probe: verifies the model is reachable on this key.
  const plainStarted = Date.now();
  try {
    const result = await generateChat([
      {
        role: "user",
        content: "Reply with the single word OK and nothing else.",
      },
    ]);
    console.log(`PLAIN OK in ${Date.now() - plainStarted}ms`);
    console.log(`  response: ${result.text.slice(0, 200)}`);
    console.log(`  usage: ${JSON.stringify(result.usage)}`);
  } catch (err) {
    console.error(`PLAIN FAILED in ${Date.now() - plainStarted}ms`);
    console.error(err);
    process.exit(2);
  }

  // Strict-mode probe: verifies the model honours response_format json_schema
  // strict decoding. This is the deciding capability — production needs it
  // for prompt-LLM contract enforcement without inline schemas.
  // generateChat only sends response_format when modelCapabilities says
  // honorsStrictMode=true, so pass modelName="(probe-strict)" with an entry
  // OR bypass via opts. Simpler: force the path by setting modelName so the
  // gate returns true. We use a known strict-mode model name as the gate
  // probe; the actual underlying provider call still uses env LLM_MODEL.
  const strictStarted = Date.now();
  try {
    const result = await generateChat(
      [
        {
          role: "user",
          content:
            'Reply with JSON matching the schema: {"word": "OK", "count": 1}. No prose, no markdown.',
        },
      ],
      {
        responseSchema: PROBE_SCHEMA,
        responseSchemaName: "probe",
        modelName: "llama-3.3-70b", // forces strict-mode wire emission via capability gate
      },
    );
    console.log(`STRICT OK in ${Date.now() - strictStarted}ms`);
    console.log(`  response: ${result.text.slice(0, 200)}`);
    const parsed = PROBE_SCHEMA.safeParse(JSON.parse(result.text));
    console.log(`  parsed OK: ${parsed.success}`);
    if (!parsed.success) {
      console.log(`  parse errors: ${JSON.stringify(parsed.error.issues)}`);
    }
    console.log(`  usage: ${JSON.stringify(result.usage)}`);
  } catch (err) {
    console.error(`STRICT FAILED in ${Date.now() - strictStarted}ms`);
    console.error(err);
    process.exit(3);
  }
}

void main();
