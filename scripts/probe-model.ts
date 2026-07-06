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

import {
  generateText,
  tool,
  stepCountIs,
  jsonSchema,
  InvalidToolInputError,
  NoSuchToolError,
} from "ai";
import { z } from "zod/v4";
import { generateChat } from "@/lib/llm/generate";
import { getLlmModel } from "@/lib/llm/provider";
import { toCerebrasJsonSchema } from "@/lib/llm/toCerebrasJsonSchema";
import { awaitCerebrasCallSlot, recordCerebrasRateLimitHeaders } from "@/lib/llm/cerebrasRateLimit";
import { LLM } from "@/lib/config/tuning";

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

/** Trial count for the tool-calling reliability gate (plan 2026-06-10-tool-calling). */
const TOOL_PROBE_TRIALS = 20;

/**
 * Recursively drop `null`-valued object properties. Tool-trained models
 * (OpenAI strict-mode convention) emit explicit `null` for inapplicable
 * optional fields; Zod `.optional()` rejects null. Stripping nulls BEFORE
 * validation lets the wire schema stay union-free (see below) while
 * accepting the model's habit.
 */
function stripNullsDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripNullsDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== null)
        .map(([k, v]) => [k, stripNullsDeep(v)]),
    );
  }
  return value;
}

/**
 * Probe questionnaire input. Wire-schema design finding (live, 2026-07-06,
 * gpt-oss-120b on Cerebras — 3 probe configurations compared):
 *
 * 1. Bare `.optional()` wire schema: 90-95% valid-call rate; the ONLY
 *    failure mode was `"correct": null` emitted on free_text questions.
 * 2. `.nullish()` wire schema (anyOf-null unions): 44% — the union muddies
 *    the object constraint and the model starts emitting `options` as an
 *    ARRAY, plus refuses to call at all in ~25% of trials.
 * 3. (This shape) Bare-optional wire bytes + null-stripping validator:
 *    unions never reach the wire; explicit nulls are absorbed at validation.
 *
 * Task 4's real tool schemas must follow shape 3 — it is the tool-channel
 * analogue of `toOutputSchema`'s wire/validator split.
 */
const probeQuestionnaireSchema = z.object({
  questions: z
    .array(
      z.object({
        id: z.string(),
        conceptName: z.string(),
        type: z.enum(["multiple_choice", "free_text"]),
        question: z.string(),
        options: z.record(z.string(), z.string()).optional(),
        correct: z.enum(["A", "B", "C", "D"]).optional(),
      }),
    )
    .min(1)
    .max(3),
});

const probeQuestionnaireInput = jsonSchema<z.infer<typeof probeQuestionnaireSchema>>(
  toCerebrasJsonSchema(probeQuestionnaireSchema, { name: "present_questionnaire_input" }).schema,
  {
    validate: (value) => {
      const result = probeQuestionnaireSchema.safeParse(stripNullsDeep(value));
      return result.success
        ? { success: true, value: result.data }
        : { success: false, error: result.error };
    },
  },
);

/**
 * Tool-call reliability probe — THE decision gate for the tool-calling
 * migration (docs/superpowers/plans/2026-06-10-tool-calling-turn-actions.md).
 * Runs N scripted teach+quiz trials with two tools defined (pure SDK — no
 * DB, no turn pipeline) and tallies valid vs malformed tool behavior.
 *
 * GO criteria: ≥95% valid tool-call rate AND median loop depth ≤ 3 steps.
 *
 * Note on error surfacing (verified against installed ai@6.0.158):
 * schema-INVALID args and hallucinated tool names THROW from generateText
 * (InvalidToolInputError / NoSuchToolError) — they never appear as steps.
 * Only execute()-thrown errors surface as `tool-error` content parts. The
 * per-trial try/catch below classifies both shapes as invalid calls.
 */
async function probeToolCalling(): Promise<void> {
  const model = getLlmModel();
  const tally = {
    validCalls: 0,
    invalidCalls: 0,
    noCallWhenRequired: 0,
    erroredTrials: 0,
    steps: [] as number[],
  };

  for (let trial = 0; trial < TOOL_PROBE_TRIALS; trial++) {
    const started = Date.now();
    try {
      const result = await generateText({
        model,
        temperature: LLM.defaultTemperature,
        maxRetries: LLM.maxRetries,
        stopWhen: stepCountIs(4),
        // Rate-limit gate for EVERY loop step (prepareStep runs before each
        // step, including the first) — same pacing contract as generateChat.
        // Also strips reasoning parts from assistant messages: gpt-oss-120b
        // emits reasoning, the openai-compatible adapter round-trips it as
        // `reasoning_content`, and Cerebras REJECTS that as an input property
        // (400 wrong_api_format). Discovered live 2026-07-06.
        prepareStep: async ({ messages }) => {
          await awaitCerebrasCallSlot();
          return {
            messages: messages.map((m) =>
              m.role === "assistant" && Array.isArray(m.content)
                ? { ...m, content: m.content.filter((p) => p.type !== "reasoning") }
                : m,
            ),
          };
        },
        tools: {
          presentQuestionnaire: tool({
            description:
              "Present a short concept-check quiz to the learner. Call at most once per turn, AFTER your teaching prose.",
            // Wire/validator split — see probeQuestionnaireSchema TSDoc.
            inputSchema: probeQuestionnaireInput,
            // Staging-only execute — the probe just acknowledges.
            execute: async () => ({ accepted: true }),
          }),
          recordComprehensionSignals: tool({
            description: "Record grading verdicts for answers the learner just gave.",
            inputSchema: z.object({
              signals: z.array(
                z.object({
                  questionId: z.string(),
                  verdict: z.enum(["correct", "partial", "incorrect"]),
                }),
              ),
            }),
            execute: async () => ({ recorded: true }),
          }),
        },
        system:
          "You are a tutor. Teach the requested concept in under 120 words, then call presentQuestionnaire with 1-2 questions checking it.",
        prompt: `Teach trial #${trial}: the difference between let and const in JavaScript.`,
      });
      recordCerebrasRateLimitHeaders(result.response.headers);

      tally.steps.push(result.steps.length);
      const calls = result.steps.flatMap((s) => s.toolCalls);
      if (calls.length === 0) tally.noCallWhenRequired++;
      // Verified against installed ai@6.0.158: a schema-invalid call is NOT
      // thrown in the multi-step flow — it lands in step.toolCalls flagged
      // `invalid: true` (dynamic) AND emits a matching `tool-error` part fed
      // back to the model for in-loop self-correction. Count each attempt
      // once, from toolCalls; log invalid inputs for the gate record.
      const invalidIds = new Set<string>();
      for (const c of calls) {
        const knownName =
          c.toolName === "presentQuestionnaire" || c.toolName === "recordComprehensionSignals";
        if (knownName && !("invalid" in c && c.invalid === true)) {
          tally.validCalls++;
        } else {
          tally.invalidCalls++;
          invalidIds.add(c.toolCallId);
          // Tail-slice the error: Zod's issue list trails the (long) value
          // dump, and the issues are the diagnostic signal.
          const detail = "error" in c ? String(c.error).slice(-400) : "(unknown-tool)";
          console.log(`  invalid call → ${c.toolName}: …${detail}`);
          console.log(`    input: ${JSON.stringify(c.input).slice(0, 300)}`);
        }
      }
      // execute()-thrown failures, distinct from the schema-invalid calls
      // already counted above (none expected from the probe's stubs).
      const errors = result.steps.flatMap((s) =>
        s.content.filter((p) => p.type === "tool-error" && !invalidIds.has(p.toolCallId)),
      );
      tally.invalidCalls += errors.length;
      console.log(
        `trial ${trial}: ${result.steps.length} steps, ${calls.length} calls, ${Date.now() - started}ms`,
      );
    } catch (err) {
      if (InvalidToolInputError.isInstance(err) || NoSuchToolError.isInstance(err)) {
        // Malformed call: wrong schema or hallucinated tool name.
        tally.invalidCalls++;
        console.log(`trial ${trial}: INVALID CALL (${err.name}) in ${Date.now() - started}ms`);
      } else {
        // Transport/provider failure — not a model-behavior verdict; report
        // separately so a flaky network can't masquerade as NO-GO. Surface
        // the provider's response body: "Bad Request" alone can't
        // distinguish "tools unsupported for model" from a payload bug.
        tally.erroredTrials++;
        const body =
          err instanceof Error && "responseBody" in err
            ? String((err as { responseBody?: unknown }).responseBody)
            : "";
        console.log(
          `trial ${trial}: TRANSPORT ERROR in ${Date.now() - started}ms: ${String(err)}${body ? `\n  body: ${body.slice(0, 500)}` : ""}`,
        );
      }
    }
  }

  const attempts = tally.validCalls + tally.invalidCalls;
  const validRate = attempts === 0 ? 0 : tally.validCalls / attempts;
  const sortedSteps = [...tally.steps].sort((a, b) => a - b);
  const medianSteps = sortedSteps[Math.floor(sortedSteps.length / 2)] ?? 0;

  console.log("\n=== tool-call reliability tally ===");
  console.log(`trials:             ${TOOL_PROBE_TRIALS} (${tally.erroredTrials} transport errors)`);
  console.log(`valid calls:        ${tally.validCalls}`);
  console.log(`invalid calls:      ${tally.invalidCalls}`);
  console.log(`noCallWhenRequired: ${tally.noCallWhenRequired}`);
  console.log(`valid-call rate:    ${(validRate * 100).toFixed(1)}%`);
  console.log(`steps per trial:    [${tally.steps.join(", ")}] (median ${medianSteps})`);

  const go = validRate >= 0.95 && medianSteps <= 3;
  console.log(`\nVERDICT: ${go ? "GO" : "NO-GO"} (need ≥95% valid rate AND median steps ≤ 3)`);
  process.exit(go ? 0 : 1);
}

async function main(): Promise<void> {
  const model = process.env.LLM_MODEL;
  if (!model || model.length === 0) {
    console.error("LLM_MODEL env not set");
    process.exit(1);
  }
  console.log(`Probing model: ${model}`);

  // Tool-calling reliability mode: `bun scripts/probe-model.ts --tools`
  // (via `just probe-model <model> --tools`). Runs ONLY the tool probe.
  if (process.argv.includes("--tools")) {
    await probeToolCalling();
    return;
  }

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
