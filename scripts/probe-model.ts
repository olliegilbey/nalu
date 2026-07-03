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

/**
 * Description-following probe. The deciding question for Nalu's prompt
 * architecture: does a strict-mode model actually READ field `description`
 * annotations, or only obey the structural grammar?
 *
 * `payload` is a deliberately neutral field name — it implies nothing about
 * its value. The grammar permits any string. The magic token lives ONLY in
 * the `.describe()` annotation; the probe's user message never mentions it.
 * If the model returns the token, the schema's descriptions are demonstrably
 * in the model's context — not just compiled into the decoder grammar.
 */
const DESC_PROBE_MAGIC = "ARTICHOKE-7732";
const DESC_PROBE_SCHEMA = z.object({
  payload: z
    .string()
    .describe(`Set this field's value to exactly this token and nothing else: ${DESC_PROBE_MAGIC}`),
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
  // generateChat sends response_format whenever a schema is supplied (the
  // old honorsStrictMode gate is gone), so supplying responseSchema alone
  // exercises the wire path against env LLM_MODEL.
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

  // Description-following probe: does the model READ field `description`
  // annotations, or only obey the structural grammar? The magic token lives
  // ONLY in the schema's `.describe()` — neither the system nor the user
  // message mentions it, and `payload` is a neutral field name. The system
  // prompt mirrors real Nalu usage (instruct schema-following) so the verdict
  // generalises to production rather than reflecting a bare-prompt artefact.
  // A returned token proves descriptions reach and steer the model.
  const descStarted = Date.now();
  try {
    const result = await generateChat(
      [
        {
          role: "system",
          content:
            "Reply with a single JSON object that conforms to the response schema you are given. Read each field's description and follow it exactly.",
        },
        { role: "user", content: "Return the JSON object." },
      ],
      {
        responseSchema: DESC_PROBE_SCHEMA,
        responseSchemaName: "desc_probe",
      },
    );
    console.log(`DESC-FOLLOWING responded in ${Date.now() - descStarted}ms`);
    console.log(`  raw response: ${JSON.stringify(result.text)}`);
    // Defensive parse: strip a markdown code fence if the model wrapped its
    // JSON in one (strict mode should prevent this — log + recover rather
    // than crash so the probe still prints a verdict either way).
    const raw = result.text.trim();
    const jsonText = raw.startsWith("```")
      ? raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
      : raw;
    let got = "(unparsed)";
    try {
      const parsed = DESC_PROBE_SCHEMA.safeParse(JSON.parse(jsonText));
      got = parsed.success
        ? parsed.data.payload
        : `(schema mismatch: ${JSON.stringify(parsed.error.issues)})`;
    } catch (parseErr) {
      got = `(JSON parse failed: ${String(parseErr)})`;
    }
    const readsDescriptions = got === DESC_PROBE_MAGIC;
    console.log(`  expected payload: ${DESC_PROBE_MAGIC}`);
    console.log(`  got payload:      ${got}`);
    console.log(
      `  → strict-mode model ${readsDescriptions ? "DOES" : "DOES NOT"} read field descriptions`,
    );
    console.log(`  usage: ${JSON.stringify(result.usage)}`);
  } catch (err) {
    console.error(`DESC-FOLLOWING FAILED in ${Date.now() - descStarted}ms`);
    console.error(err);
    process.exit(4);
  }
}

void main();
