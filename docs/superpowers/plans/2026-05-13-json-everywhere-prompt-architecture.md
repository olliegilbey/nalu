# JSON-Everywhere Prompt Architecture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace scoping-phase XML-bracketed prompt+parse contract with a JSON-everywhere contract enforced by Cerebras `response_format: { type: "json_schema", strict: true }`, plus migrate `gradeBaseline` to `executeTurn` so no legacy XML extraction path remains.

**Architecture:** One Zod schema per stage is the single source of truth — produces the wire schema (via `z.toJSONSchema` + Cerebras keyword stripping), the runtime validator (in `executeTurn`), and the model-facing field guide (via `.describe()` annotations rendered into the decoder's context). Per-turn user envelopes are bare `<stage>...</stage>` + `<learner_input>...</learner_input>`. System prompt is slim: persona + topic + one-line JSON rule.

**Tech Stack:** Zod v4 (`z.toJSONSchema()`), Vercel AI SDK v5 (`generateText` + `responseFormat`), `@ai-sdk/openai-compatible` with `supportsStructuredOutputs: true`, Cerebras Chat Completions (OpenAI-compatible). Tests: Vitest + testcontainers Postgres. Hard deadline: Cerebras strict-mode enforcement begins **2026-07-21**.

**Source spec:** `docs/superpowers/specs/2026-05-13-json-everywhere-prompt-architecture.md`

---

## File Structure

**New files**

- `src/lib/llm/toCerebrasJsonSchema.ts` — pure Zod→Cerebras-strict JSON Schema adapter. Strips `minItems`/`maxItems`/`pattern`/`minLength`/`maxLength`/`minimum`/`maximum`/`format`/`$ref`. Asserts size ≤ 5000 chars + depth ≤ 10.
- `src/lib/llm/toCerebrasJsonSchema.test.ts` — colocated unit tests.
- `src/lib/prompts/questionnaire.ts` — shared `questionSchema` (discriminated union: `free_text` | `multiple_choice`), `questionnaireSchema`, `responseSchema`, `responsesSchema`. Every field annotated with `.describe()` carrying `[UI]` / `[server]` / `[chat]` visibility tags.
- `src/lib/prompts/questionnaire.test.ts` — schema unit tests (visibility tags survive `toJSONSchema`, XOR enforced on responses).
- `src/lib/prompts/baselineGrading.ts` — `gradeBaselineSchema` and shared types.
- `src/lib/prompts/baselineGrading.test.ts`
- `src/db/migrations/0005_jsonb_rewrite.sql` — pre-launch truncate of in-flight scoping rows.

**Heavily rewritten files**

- `src/lib/prompts/scoping.ts` — slim system prompt + `renderStageEnvelope({ stage, learnerInput })`.
- `src/lib/prompts/clarify.ts` (new — replaces `clarification.ts`) — `clarifySchema` (= `userMessage` + `Questionnaire`), no system-prompt constant, no `buildClarificationPrompt`.
- `src/lib/prompts/framework.ts` — drop `FRAMEWORK_TURN_INSTRUCTIONS`, `buildClarificationAssistantMessage`, `buildFrameworkTurnUserContent`, `buildFrameworkPrompt`. Keep `frameworkSchema` + tier schema; add `.describe()` everywhere; remove non-Cerebras-safe constraints (`.min`/`.max`) where they would reach the wire schema (kept on Zod side via `.refine`).
- `src/lib/prompts/baseline.ts` — drop `BASELINE_TURN_INSTRUCTIONS`, `buildFrameworkAssistantMessage`, `buildBaselineTurnUserContent`, `buildBaselinePrompt`. Keep `MC_OPTION_KEYS`, `baselineSchema`. Migrate question shape onto shared `questionSchema` from `questionnaire.ts` + per-stage `.superRefine` (every question carries `conceptName`/`tier`; every MC carries `correct`; tier-scope invariant moves here).
- `src/lib/llm/generate.ts` — `generateChat` gains `responseSchema?: z.ZodType` option; pipes through to `generateText` as `responseFormat: { type: "json", schema: toCerebrasJsonSchema(...), name }`. `generateStructured` function deleted (only caller was `gradeBaseline`).
- `src/lib/llm/provider.ts` — `provider.chatModel(env.LLM_MODEL, { supportsStructuredOutputs: true })`.
- `src/lib/turn/executeTurn.ts` — `parser: (raw) => T` replaced by `responseSchema: z.ZodType<T>`. Harness does `JSON.parse → schema.parse`. `ValidationGateFailure` directive is generic on shape failures and the `.refine` message verbatim on business-invariant failures.
- `src/lib/turn/diagnoseFailure.ts` — XML tag heuristics replaced with JSON-only heuristics (`userMessage` missing, wrong stage payload field present, plausible cross-stage payload).
- `src/lib/course/clarify.ts` — pass `responseSchema: clarifySchema` into `executeTurn`; persist wire shape directly (no `toClarificationJsonb`).
- `src/lib/course/generateFramework.ts` — same pattern; drop `toFrameworkJsonb`; persist wire shape directly. Render envelope via `renderStageEnvelope`.
- `src/lib/course/generateBaseline.ts` — same pattern; drop `toBaselineJsonb`; tier-scope invariant moves into the schema's `.superRefine`.
- `src/lib/course/gradeBaseline.ts` — reshape to mirror `generateBaseline`: course fetch + preconditions + idempotency check + `executeTurn` (responseSchema = `gradeBaselineSchema`) + persist `gradings` into `courses.baseline.gradings`. All-MC shortcut preserved.
- `src/lib/types/jsonb.ts` — rewrite `clarificationJsonbSchema`, `frameworkJsonbSchema`, `baselineJsonbSchema` per spec §4.8. Field renames (`text`→`prompt`, `single_select`→`multiple_choice`, `answers`→`responses`/`options`). `z.unknown()[]` → typed.

**Deleted files**

- `src/lib/course/parsers.ts` (+ `.test.ts`) — replaced by in-`executeTurn` Zod parse.
- `src/lib/prompts/clarification.ts` — replaced by `clarify.ts`.
- `src/lib/prompts/baselineEvaluation.ts` (+ `.test.ts`) — only caller migrated.

**Updated docs**

- `src/lib/turn/CLAUDE.md`, `src/lib/course/CLAUDE.md`, `src/lib/prompts/CLAUDE.md` — match new contract; remove references to deleted modules.
- `docs/UBIQUITOUS_LANGUAGE.md` — add: Learner input, User envelope, Per-stage schema, Questionnaire, Question, Response (learner input).

---

## Task Ordering Rationale

Bottom-up so each task lands on green:

1. Pure utility (`toCerebrasJsonSchema`) — has no callers yet; TDD-easy.
2. Shared `Questionnaire`/`Question`/`Response` schemas — depended on by clarify + baseline.
3. Plumb `responseSchema` through `generate.ts` + `provider.ts` (adapter still works for any caller that doesn't pass one).
4. Plumb `responseSchema` through `executeTurn.ts` (both `parser` and `responseSchema` accepted in a transitional state? No — flip cleanly; per-stage parsers move into the same task chain).
5. Per-stage schemas (`clarify.ts`, `framework.ts`, `baseline.ts`) — annotated with `.describe()`, `.refine`/`.superRefine` for invariants.
6. Per-stage envelope + system prompt (`scoping.ts`).
7. Lib steps wired to new schemas, in dependency order: clarify → generateFramework → generateBaseline → gradeBaseline.
8. JSONB storage rewrite + DB query validators.
9. Pre-launch truncate migration.
10. Delete legacy modules + their tests.
11. `diagnoseFailure.ts` rewrite for JSON-only failure modes.
12. CLAUDE.md + UBIQUITOUS_LANGUAGE.md updates.
13. End-to-end verification: `just check`, integration suite, smoke run (`just smoke` under `CEREBRAS_LIVE=1`).

Commit at the end of each task.

---

### Task 1: `toCerebrasJsonSchema` utility

**Files:**

- Create: `src/lib/llm/toCerebrasJsonSchema.ts`
- Test: `src/lib/llm/toCerebrasJsonSchema.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/llm/toCerebrasJsonSchema.test.ts
import { describe, expect, it } from "vitest";
import { z } from "zod/v4";
import { toCerebrasJsonSchema } from "./toCerebrasJsonSchema";

describe("toCerebrasJsonSchema", () => {
  it("strips minItems/maxItems on arrays", () => {
    const schema = z.object({ items: z.array(z.string()).min(2).max(4) });
    const out = toCerebrasJsonSchema(schema, { name: "t" });
    const s = JSON.stringify(out);
    expect(s).not.toMatch(/"minItems"/);
    expect(s).not.toMatch(/"maxItems"/);
  });

  it("strips pattern/minLength/maxLength on strings", () => {
    const schema = z.object({
      id: z
        .string()
        .regex(/^b\d+$/)
        .min(1)
        .max(50),
    });
    const out = toCerebrasJsonSchema(schema, { name: "t" });
    const s = JSON.stringify(out);
    expect(s).not.toMatch(/"pattern"/);
    expect(s).not.toMatch(/"minLength"/);
    expect(s).not.toMatch(/"maxLength"/);
  });

  it("strips minimum/maximum/format/$ref", () => {
    const schema = z.object({ n: z.int().positive() });
    const out = toCerebrasJsonSchema(schema, { name: "t" });
    const s = JSON.stringify(out);
    expect(s).not.toMatch(/"minimum"/);
    expect(s).not.toMatch(/"maximum"/);
    expect(s).not.toMatch(/"format"/);
    expect(s).not.toMatch(/"\$ref"/);
  });

  it("preserves description fields", () => {
    const schema = z.object({
      prompt: z.string().describe("[UI] question shown to learner"),
    });
    const out = toCerebrasJsonSchema(schema, { name: "t" }) as Record<string, unknown>;
    expect(JSON.stringify(out)).toMatch(/\[UI\] question shown to learner/);
  });

  it("throws when serialised size exceeds 5000 chars", () => {
    const huge = z.object({
      x: z.string().describe("a".repeat(6000)),
    });
    expect(() => toCerebrasJsonSchema(huge, { name: "t" })).toThrow(/exceeds.*5000/);
  });

  it("throws when depth exceeds 10", () => {
    // Build 11-deep nested object.
    const deep = z.object({
      a: z.object({
        b: z.object({
          c: z.object({
            d: z.object({
              e: z.object({
                f: z.object({
                  g: z.object({
                    h: z.object({
                      i: z.object({
                        j: z.object({
                          k: z.string(),
                        }),
                      }),
                    }),
                  }),
                }),
              }),
            }),
          }),
        }),
      }),
    });
    expect(() => toCerebrasJsonSchema(deep, { name: "t" })).toThrow(/depth/);
  });

  it("attaches the supplied name", () => {
    const schema = z.object({ x: z.string() });
    const out = toCerebrasJsonSchema(schema, { name: "my_schema" });
    expect((out as { name?: string }).name).toBe("my_schema");
  });
});
```

- [ ] **Step 2: Run tests, see them fail**

```
just test src/lib/llm/toCerebrasJsonSchema.test.ts
```

Expected: module-not-found error.

- [ ] **Step 3: Implement the adapter**

```ts
// src/lib/llm/toCerebrasJsonSchema.ts
import { z } from "zod/v4";

/**
 * Keywords Cerebras strict-mode `response_format` rejects (per its docs).
 * Stripped from the JSON Schema before sending. The Zod side still
 * enforces them at parse-time; this only trims the wire payload.
 */
const FORBIDDEN_KEYWORDS = [
  "minItems",
  "maxItems",
  "pattern",
  "minLength",
  "maxLength",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "format",
  "$ref",
] as const;

/** Cerebras documented strict-mode budget: 5000 char wire schema, depth ≤ 10. */
const MAX_CHARS = 5000;
const MAX_DEPTH = 10;

export interface CerebrasJsonSchemaOptions {
  /** Schema name (passed as `response_format.json_schema.name`). */
  readonly name: string;
  /** Optional description (passed as `response_format.json_schema.description`). */
  readonly description?: string;
}

/** Wire-shape returned to callers — what AI SDK's `responseFormat` consumes. */
export interface CerebrasResponseFormat {
  readonly type: "json";
  readonly name: string;
  readonly description?: string;
  readonly schema: Record<string, unknown>;
}

/**
 * Convert a Zod schema to a Cerebras-strict-mode JSON Schema and wrap it
 * in the AI SDK's `responseFormat` shape. Strips forbidden keywords and
 * asserts size/depth at build time.
 */
export function toCerebrasJsonSchema<T>(
  schema: z.ZodType<T>,
  opts: CerebrasJsonSchemaOptions,
): CerebrasResponseFormat {
  const raw = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
  const stripped = stripForbidden(raw, 0);
  const serialised = JSON.stringify(stripped);
  if (serialised.length > MAX_CHARS) {
    throw new Error(
      `toCerebrasJsonSchema(${opts.name}): schema is ${serialised.length} chars, exceeds Cerebras ${MAX_CHARS}-char strict-mode budget`,
    );
  }
  return {
    type: "json",
    name: opts.name,
    description: opts.description,
    schema: stripped,
  };
}

/**
 * Recursively walk the schema, deleting forbidden keywords and asserting
 * the depth budget. Pure function — returns a new object, mutates nothing.
 */
function stripForbidden(node: unknown, depth: number): Record<string, unknown> {
  if (depth > MAX_DEPTH) {
    throw new Error(`toCerebrasJsonSchema: schema depth exceeds ${MAX_DEPTH}`);
  }
  if (typeof node !== "object" || node === null) {
    return node as Record<string, unknown>;
  }
  if (Array.isArray(node)) {
    return node.map((item) => stripForbidden(item, depth + 1)) as unknown as Record<
      string,
      unknown
    >;
  }
  // Object: shallow-copy without forbidden keys; recurse into each value.
  const obj = node as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(obj)
      .filter(([k]) => !FORBIDDEN_KEYWORDS.includes(k as (typeof FORBIDDEN_KEYWORDS)[number]))
      .map(([k, v]) => [k, stripForbidden(v, depth + 1)]),
  );
}
```

- [ ] **Step 4: Run tests, see them pass**

```
just test src/lib/llm/toCerebrasJsonSchema.test.ts
```

Expected: all 7 pass.

- [ ] **Step 5: Lint + typecheck**

```
just lint && just typecheck
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/llm/toCerebrasJsonSchema.ts src/lib/llm/toCerebrasJsonSchema.test.ts
git commit -m "feat(llm): add toCerebrasJsonSchema for strict-mode wire schemas"
```

---

### Task 2: Shared `Questionnaire`/`Question`/`Response` schemas

**Files:**

- Create: `src/lib/prompts/questionnaire.ts`
- Test: `src/lib/prompts/questionnaire.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/prompts/questionnaire.test.ts
import { describe, expect, it } from "vitest";
import {
  questionSchema,
  questionnaireSchema,
  responseSchema,
  responsesSchema,
  MC_OPTION_KEYS,
} from "./questionnaire";

describe("questionSchema", () => {
  it("accepts a minimal free_text question", () => {
    expect(() =>
      questionSchema.parse({
        id: "q1",
        type: "free_text",
        prompt: "Why?",
        freetextRubric: "any answer is fine",
      }),
    ).not.toThrow();
  });

  it("accepts a multiple_choice question with all four options", () => {
    expect(() =>
      questionSchema.parse({
        id: "q2",
        type: "multiple_choice",
        prompt: "Pick one.",
        options: { A: "a", B: "b", C: "c", D: "d" },
        correct: "C",
        freetextRubric: "rubric",
      }),
    ).not.toThrow();
  });

  it("rejects an MC question missing an option", () => {
    expect(() =>
      questionSchema.parse({
        id: "q2",
        type: "multiple_choice",
        prompt: "Pick one.",
        // Missing D.
        options: { A: "a", B: "b", C: "c" },
        correct: "A",
        freetextRubric: "rubric",
      }),
    ).toThrow();
  });

  it("rejects an unknown discriminator type", () => {
    expect(() =>
      questionSchema.parse({
        id: "q3",
        type: "single_select",
        prompt: "old",
      }),
    ).toThrow();
  });
});

describe("responseSchema", () => {
  it("accepts a choice-only response", () => {
    expect(() => responseSchema.parse({ questionId: "q1", choice: "A" })).not.toThrow();
  });

  it("accepts a freetext-only response", () => {
    expect(() => responseSchema.parse({ questionId: "q1", freetext: "hi" })).not.toThrow();
  });

  it("rejects a response with both choice and freetext", () => {
    expect(() => responseSchema.parse({ questionId: "q1", choice: "A", freetext: "hi" })).toThrow(
      /exactly one/i,
    );
  });

  it("rejects a response with neither choice nor freetext", () => {
    expect(() => responseSchema.parse({ questionId: "q1" })).toThrow(/exactly one/i);
  });
});

describe("questionnaireSchema + responsesSchema", () => {
  it("accepts a non-empty questionnaire", () => {
    expect(() =>
      questionnaireSchema.parse({
        questions: [{ id: "q1", type: "free_text", prompt: "p", freetextRubric: "r" }],
      }),
    ).not.toThrow();
  });

  it("rejects an empty questionnaire (refine: at least one question)", () => {
    expect(() => questionnaireSchema.parse({ questions: [] })).toThrow();
  });

  it("accepts a responses wrapper", () => {
    expect(() =>
      responsesSchema.parse({ responses: [{ questionId: "q1", choice: "A" }] }),
    ).not.toThrow();
  });
});

describe("MC_OPTION_KEYS", () => {
  it("is the canonical A/B/C/D tuple", () => {
    expect(MC_OPTION_KEYS).toEqual(["A", "B", "C", "D"]);
  });
});
```

- [ ] **Step 2: Run tests, see them fail**

```
just test src/lib/prompts/questionnaire.test.ts
```

Expected: module-not-found.

- [ ] **Step 3: Implement the schemas**

```ts
// src/lib/prompts/questionnaire.ts
import { z } from "zod/v4";

/**
 * Canonical four-option key tuple for multiple-choice questions. Used by
 * `questionSchema` and re-exported so per-stage schemas can pin themselves
 * to the same letters without duplicating the constant.
 */
export const MC_OPTION_KEYS = ["A", "B", "C", "D"] as const;
export type McOptionKey = (typeof MC_OPTION_KEYS)[number];

/**
 * Shared question shape used identically by clarify, baseline, and (later)
 * teaching quizzes. Visibility tiers are documented inline via .describe()
 * prefixes: [UI] = rendered to the learner, [server] = harness-only state
 * never shown, [chat] = chat-bubble prose. Cerebras tokenises descriptions
 * into the decoder's context so these annotations *are* the model's guide.
 *
 * Cross-field invariants (every MC has `correct` when graded; baseline
 * adds `conceptName`/`tier`) are enforced by per-stage `.superRefine` on
 * the wrapping stage schema, not here — clarify needs the looser shape.
 */
export const questionSchema = z.discriminatedUnion("type", [
  z.object({
    id: z
      .string()
      .describe("[server] Stable identifier so responses can be matched back to questions."),
    type: z.literal("free_text").describe("[server] Question kind discriminator."),
    prompt: z.string().describe("[UI] The question shown to the learner."),
    freetextRubric: z
      .string()
      .describe(
        "[server] How to grade a free-text response. For elicitation (clarify) " +
          "this can be a one-liner like 'no grading — informational'. Never shown to the learner.",
      ),
    conceptName: z
      .string()
      .optional()
      .describe("[server] Concept this question probes. Required for baseline + teaching quizzes."),
    tier: z
      .int()
      .positive()
      .optional()
      .describe(
        "[server] Framework tier this question targets. Required for baseline + teaching quizzes.",
      ),
  }),
  z.object({
    id: z.string().describe("[server] Stable identifier."),
    type: z.literal("multiple_choice").describe("[server] Question kind discriminator."),
    prompt: z.string().describe("[UI] The question shown to the learner."),
    options: z
      .object({
        A: z.string(),
        B: z.string(),
        C: z.string(),
        D: z.string(),
      })
      .describe(
        "[UI] Four keyed options shown to the learner. Learner can also bypass " +
          "via the free-text escape rendered alongside the buttons.",
      ),
    correct: z
      .enum(MC_OPTION_KEYS)
      .optional()
      .describe(
        "[server] Correct option key. NEVER shown to the learner. " +
          "PRESENT for graded questions (baseline, quiz) so the client can score MC immediately " +
          "without a round-trip; ABSENT for elicitation (clarify) where there is no right answer.",
      ),
    freetextRubric: z
      .string()
      .describe("[server] How to grade if the learner uses the free-text escape. Never shown."),
    conceptName: z.string().optional().describe("[server] Concept probed."),
    tier: z.int().positive().optional().describe("[server] Framework tier targeted."),
  }),
]);

/** Inferred Question union — re-exported for stage schemas + UI typing. */
export type Question = z.infer<typeof questionSchema>;

/**
 * Questionnaire wrapper. Per-stage `.refine` on the wrapping schema tightens
 * the count bounds (clarify: 2–4; baseline: derived from scope tiers).
 * Cerebras strict mode forbids `minItems`/`maxItems` on the wire side, so
 * count enforcement runs Zod-side via `.refine`.
 */
export const questionnaireSchema = z
  .object({
    questions: z
      .array(questionSchema)
      .describe(
        "One or more questions. UI shows them one at a time; the learner submits " +
          "the whole questionnaire before the model sees responses. " +
          "Clarify: 2–4 questions; baseline: count determined by scope tiers.",
      ),
  })
  .refine((q) => q.questions.length >= 1, {
    message: "questionnaire must contain at least one question",
    path: ["questions"],
  });

export type Questionnaire = z.infer<typeof questionnaireSchema>;

/**
 * One learner reply. Exactly one of `choice` | `freetext` is set — enforced
 * by superRefine because Cerebras strict mode rejects `oneOf` discrimination
 * on plain unions without an explicit discriminator field.
 */
export const responseSchema = z
  .object({
    questionId: z.string().describe("[server] Matches the question's id."),
    choice: z
      .enum(MC_OPTION_KEYS)
      .optional()
      .describe(
        "[UI→server] MC option key selected by the learner. Set only when the learner clicks an MC option.",
      ),
    freetext: z
      .string()
      .optional()
      .describe(
        "[UI→server] Free-text body. Set for free-text questions or when the learner uses the freetext-escape on an MC question.",
      ),
  })
  .superRefine((val, ctx) => {
    const both = val.choice !== undefined && val.freetext !== undefined;
    const neither = val.choice === undefined && val.freetext === undefined;
    if (both || neither) {
      ctx.addIssue({
        code: "custom",
        message: "response must have exactly one of `choice` or `freetext`",
        path: [],
      });
    }
  });

export type Response = z.infer<typeof responseSchema>;

/** Wrapper for serialising the learner's full set of replies. */
export const responsesSchema = z.object({
  responses: z.array(responseSchema),
});

export type Responses = z.infer<typeof responsesSchema>;
```

- [ ] **Step 4: Run tests, see them pass**

```
just test src/lib/prompts/questionnaire.test.ts
```

Expected: all 11 pass.

- [ ] **Step 5: Lint + typecheck**

```
just lint && just typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/prompts/questionnaire.ts src/lib/prompts/questionnaire.test.ts
git commit -m "feat(prompts): shared Questionnaire/Question/Response schemas"
```

---

### Task 3: Provider — enable `supportsStructuredOutputs`

**Files:**

- Modify: `src/lib/llm/provider.ts`

This change is needed before `generate.ts` can emit `response_format: { type: "json_schema", ... }`. AI SDK emits the legacy `{ type: "json_object" }` unless `supportsStructuredOutputs: true` is set on the chatModel (see `node_modules/@ai-sdk/openai-compatible/dist/index.mjs:517-525`).

- [ ] **Step 1: Edit provider**

```ts
// src/lib/llm/provider.ts
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { getEnv } from "@/lib/config";
import type { LlmModel } from "@/lib/types/llm";

/**
 * Single swap-point for the underlying LLM provider.
 *
 * `supportsStructuredOutputs: true` tells the openai-compatible adapter to
 * emit Cerebras's full strict-mode `response_format: { type: "json_schema",
 * json_schema: { schema, strict, name } }` when a caller passes a
 * `responseFormat: { type: "json", schema }` option. Without this flag the
 * adapter falls back to the legacy `{ type: "json_object" }` (no schema
 * constraints) — see node_modules/@ai-sdk/openai-compatible/dist/index.mjs.
 */
export function getLlmModel(): LlmModel {
  const env = getEnv();
  const provider = createOpenAICompatible({
    name: "nalu-llm",
    baseURL: env.LLM_BASE_URL,
    apiKey: env.LLM_API_KEY,
  });
  return provider.chatModel(env.LLM_MODEL, { supportsStructuredOutputs: true });
}
```

- [ ] **Step 2: Typecheck (no test for this — verified by Task 4)**

```
just typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add src/lib/llm/provider.ts
git commit -m "feat(llm): enable supportsStructuredOutputs on Cerebras chatModel"
```

---

### Task 4: `generateChat` accepts `responseSchema`

**Files:**

- Modify: `src/lib/llm/generate.ts`
- Test: `src/lib/llm/generate.test.ts` (existing)

This task lands BEFORE removing `generateStructured` so `gradeBaseline` continues to compile. `generateStructured` is deleted in Task 14.

- [ ] **Step 1: Read existing generate.test.ts**

```
just test src/lib/llm/generate.test.ts
```

Verify current tests still pass on the unchanged baseline before editing.

- [ ] **Step 2: Add a failing test for the new responseSchema path**

Append to `src/lib/llm/generate.test.ts`:

```ts
import { z } from "zod/v4";

describe("generateChat with responseSchema", () => {
  it("passes responseSchema through to the SDK as responseFormat: { type: 'json', schema, name }", async () => {
    // Mock the underlying generateText so we can inspect the args it received.
    const captured = vi.fn();
    vi.doMock("ai", async () => {
      const real = await vi.importActual<typeof import("ai")>("ai");
      return {
        ...real,
        generateText: vi.fn().mockImplementation(async (args: unknown) => {
          captured(args);
          return { text: '{"x":"hi"}', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } };
        }),
      };
    });
    // Re-import after the mock is registered.
    const { generateChat } = await import("./generate");
    const schema = z.object({ x: z.string() });
    await generateChat([{ role: "user", content: "hi" }], {
      responseSchema: schema,
      responseSchemaName: "test",
    });
    const args = captured.mock.calls[0][0];
    expect(args.responseFormat).toMatchObject({ type: "json", name: "test" });
    expect(args.responseFormat.schema).toBeDefined();
    vi.doUnmock("ai");
  });
});
```

(If the existing test file does not import `vi`/`describe`/`expect`, mirror the imports already present in the file. Adjust the mocking pattern to match the file's existing style — the file already mocks `ai` for `generateStructured`/`generateChat`; reuse that fixture if so.)

- [ ] **Step 3: Run, see it fail**

```
just test src/lib/llm/generate.test.ts
```

Expected: new test fails — `responseSchema` option does not yet exist on `GenerateOptions`.

- [ ] **Step 4: Wire `responseSchema` through `generateChat`**

```ts
// src/lib/llm/generate.ts  (replace whole file)
import { generateObject, generateText } from "ai";
import type { z } from "zod/v4";
import { LLM } from "@/lib/config/tuning";
import { getLlmModel } from "./provider";
import { toCerebrasJsonSchema } from "./toCerebrasJsonSchema";
import type { LlmMessage, LlmModel, LlmUsage } from "@/lib/types/llm";

/**
 * Options common to both generate wrappers. All optional — `tuning.LLM`
 * supplies defaults. Callers override per-flow (e.g. a creative framing
 * prompt may raise temperature).
 */
export interface GenerateOptions {
  /** 0–1. Lower → more consistent. Default: `LLM.defaultTemperature`. */
  readonly temperature?: number;
  /** Transport-level retries on transient errors. Default: `LLM.maxRetries`. */
  readonly maxRetries?: number;
  /** Override the model for a single call (testing, capability routing). */
  readonly model?: LlmModel;
}

/**
 * Chat-call extension: when `responseSchema` is provided, the call uses
 * Cerebras strict-mode constrained decoding — the model can only emit JSON
 * matching the schema. `responseSchemaName` is the JSON Schema `name`
 * field on the wire (defaults to "response").
 */
export interface ChatOptions extends GenerateOptions {
  readonly responseSchema?: z.ZodType<unknown>;
  readonly responseSchemaName?: string;
}

export interface StructuredResult<T> {
  readonly object: T;
  readonly usage: LlmUsage;
}

export interface ChatResult {
  readonly text: string;
  readonly usage: LlmUsage;
}

/**
 * @deprecated Slated for deletion in Task 14 once `gradeBaseline` migrates
 * to `executeTurn` + `responseSchema`. New code MUST NOT call this.
 */
export async function generateStructured<T>(
  schema: z.ZodType<T>,
  messages: readonly LlmMessage[],
  opts: GenerateOptions = {},
): Promise<StructuredResult<T>> {
  const result = await generateObject({
    model: opts.model ?? getLlmModel(),
    schema,
    messages: [...messages],
    temperature: opts.temperature ?? LLM.defaultTemperature,
    maxRetries: opts.maxRetries ?? LLM.maxRetries,
  });
  return { object: result.object as T, usage: result.usage };
}

/**
 * Free-form chat call. When `responseSchema` is supplied, Cerebras
 * constrained decoding guarantees the output parses as JSON matching the
 * schema (modulo business invariants — those still run Zod-side in
 * `executeTurn`). Without `responseSchema`, the call is unconstrained.
 */
export async function generateChat(
  messages: readonly LlmMessage[],
  opts: ChatOptions = {},
): Promise<ChatResult> {
  const responseFormat =
    opts.responseSchema !== undefined
      ? toCerebrasJsonSchema(opts.responseSchema, {
          name: opts.responseSchemaName ?? "response",
        })
      : undefined;
  const result = await generateText({
    model: opts.model ?? getLlmModel(),
    messages: [...messages],
    temperature: opts.temperature ?? LLM.defaultTemperature,
    maxRetries: opts.maxRetries ?? LLM.maxRetries,
    ...(responseFormat !== undefined ? { responseFormat } : {}),
  });
  return { text: result.text, usage: result.usage };
}
```

- [ ] **Step 5: Run tests, see them pass**

```
just test src/lib/llm/generate.test.ts
```

Expected: original tests + new responseSchema test all pass.

- [ ] **Step 6: Lint + typecheck**

```
just lint && just typecheck
```

- [ ] **Step 7: Commit**

```bash
git add src/lib/llm/generate.ts src/lib/llm/generate.test.ts
git commit -m "feat(llm): generateChat accepts responseSchema for strict JSON decoding"
```

---

### Task 5: `executeTurn` accepts `responseSchema` instead of `parser`

**Files:**

- Modify: `src/lib/turn/executeTurn.ts`
- Modify: `src/lib/turn/executeTurn.test.ts` (existing — adapt all `parser:` callsites)

This is a breaking change to the `ExecuteTurnParams` shape. All four existing callers (`clarify`, `generateFramework`, `generateBaseline`, plus tests) MUST be updated in Tasks 9–12. To keep the build green between commits we move tests first.

- [ ] **Step 1: Update `ExecuteTurnParams` + harness loop**

```ts
// src/lib/turn/executeTurn.ts — only the params interface + the parse line change.
// Replace the `parser` field on ExecuteTurnParams with `responseSchema`,
// replace the `params.parser(result.text)` call with JSON.parse → schema.parse.
```

Apply this Edit:

```ts
// Old:
export interface ExecuteTurnParams<T> {
  readonly parent: ContextParent;
  readonly seed: SeedInputs;
  readonly userMessageContent: string;
  readonly parser: (raw: string) => T;
  readonly retryDirective?: (err: ValidationGateFailure, attempt: number) => string;
  readonly label?: string;
  readonly successSummary?: (parsed: T) => string;
}

// New:
export interface ExecuteTurnParams<T> {
  readonly parent: ContextParent;
  readonly seed: SeedInputs;
  readonly userMessageContent: string;
  /**
   * Zod schema describing the strict JSON shape the model must return.
   * Used twice per turn: (1) at decode time via `generateChat` →
   * `toCerebrasJsonSchema` → Cerebras `response_format: { type: "json_schema",
   * strict: true }`, so invalid JSON is unreachable for the decoder;
   * (2) post-decode via `schema.safeParse(JSON.parse(text))`, which
   * enforces business invariants (`.refine`/`.superRefine` rules that
   * Cerebras strict mode can't express, e.g. tier-scope, count bounds).
   * Refine `.message` text flows verbatim into the retry directive.
   */
  readonly responseSchema: z.ZodType<T>;
  /** Optional `name` field on the wire JSON schema (defaults to `seed.kind`). */
  readonly responseSchemaName?: string;
  readonly retryDirective?: (err: ValidationGateFailure, attempt: number) => string;
  readonly label?: string;
  readonly successSummary?: (parsed: T) => string;
}
```

Then replace the parse block in the `attempt` closure:

```ts
// Old call site inside the try { ... }
// const parsed = params.parser(result.text);

// New call site:
const parsed = parseAndValidate(result.text, params.responseSchema);
```

And replace the `generateChat(llmMessages)` call to pass the schema:

```ts
const result = await generateChat(llmMessages, {
  responseSchema: params.responseSchema,
  responseSchemaName: params.responseSchemaName ?? params.seed.kind,
});
```

Add the helper at the bottom of the file:

```ts
import type { z } from "zod/v4";

/**
 * JSON-parse the model output then Zod-validate it against `schema`.
 * Throws `ValidationGateFailure` with a model-readable directive on either
 * failure mode. Generic directive on JSON shape failures (rare under
 * strict-mode constrained decoding but possible if the provider returns
 * text outside the JSON envelope); refine `.message` verbatim on
 * business-invariant failures.
 */
function parseAndValidate<T>(raw: string, schema: z.ZodType<T>): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ValidationGateFailure(
      "missing_response",
      "Your previous response did not parse as JSON. Reply with a single JSON object matching the schema attached to this turn.",
    );
  }
  const safe = schema.safeParse(parsed);
  if (!safe.success) {
    // Surface Zod's full issue list — refine `.message` strings include
    // field paths and the violated rule. The model needs the specifics.
    throw new ValidationGateFailure("missing_response", safe.error.message);
  }
  return safe.data;
}
```

Add the import at the top:

```ts
import type { z } from "zod/v4";
```

- [ ] **Step 2: Adapt `executeTurn.test.ts`**

For every test that builds `ExecuteTurnParams`, replace `parser: (raw) => ...` with `responseSchema: <some-zod-schema>`. Where the test mock model returns canned text, ensure that text is valid JSON matching the test's schema; otherwise the test will land on the new JSON-parse rejection.

Example transform — old:

```ts
parser: (raw) => {
  const obj = JSON.parse(raw);
  return obj as { x: string };
},
```

New:

```ts
responseSchema: z.object({ x: z.string() }),
```

- [ ] **Step 3: Run tests**

```
just test src/lib/turn/executeTurn.test.ts
```

Expected: all pass. (Other suites are red until Tasks 9–12; that is expected.)

- [ ] **Step 4: Commit (the build is intentionally red for the four lib-step callers — fixed in the next tasks)**

```bash
git add src/lib/turn/executeTurn.ts src/lib/turn/executeTurn.test.ts
git commit -m "feat(turn): executeTurn takes responseSchema; harness does JSON.parse + zod.parse"
```

---

### Task 6: Per-stage `clarifySchema` (replaces `clarification.ts`)

**Files:**

- Create: `src/lib/prompts/clarify.ts`
- Test: `src/lib/prompts/clarify.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/prompts/clarify.test.ts
import { describe, expect, it } from "vitest";
import { clarifySchema } from "./clarify";
import { SCOPING } from "@/lib/config/tuning";

describe("clarifySchema", () => {
  it("accepts a userMessage plus 2 questions", () => {
    expect(() =>
      clarifySchema.parse({
        userMessage: "Let's nail down a few things.",
        questions: {
          questions: [
            { id: "q1", type: "free_text", prompt: "What's your goal?", freetextRubric: "n/a" },
            { id: "q2", type: "free_text", prompt: "Prior background?", freetextRubric: "n/a" },
          ],
        },
      }),
    ).not.toThrow();
  });

  it("rejects fewer than the minimum clarify questions", () => {
    expect(() =>
      clarifySchema.parse({
        userMessage: "hi",
        questions: {
          questions: [{ id: "q1", type: "free_text", prompt: "p", freetextRubric: "r" }],
        },
      }),
    ).toThrow();
  });

  it("rejects more than the maximum clarify questions", () => {
    const make = (i: number) => ({
      id: `q${i}`,
      type: "free_text" as const,
      prompt: "p",
      freetextRubric: "r",
    });
    const overshoot = Array.from({ length: SCOPING.maxClarifyAnswers + 1 }, (_, i) => make(i + 1));
    expect(() =>
      clarifySchema.parse({ userMessage: "hi", questions: { questions: overshoot } }),
    ).toThrow();
  });

  it("rejects clarify questions carrying conceptName or tier", () => {
    expect(() =>
      clarifySchema.parse({
        userMessage: "hi",
        questions: {
          questions: [
            {
              id: "q1",
              type: "free_text",
              prompt: "p",
              freetextRubric: "r",
              conceptName: "should not be here",
              tier: 1,
            },
            { id: "q2", type: "free_text", prompt: "p2", freetextRubric: "r" },
          ],
        },
      }),
    ).toThrow(/clarify.*conceptName|tier/i);
  });
});
```

- [ ] **Step 2: Run, see it fail**

```
just test src/lib/prompts/clarify.test.ts
```

Expected: module-not-found.

- [ ] **Step 3: Implement**

```ts
// src/lib/prompts/clarify.ts
import { z } from "zod/v4";
import { SCOPING } from "@/lib/config/tuning";
import { questionnaireSchema } from "./questionnaire";

/**
 * Clarify-stage response schema.
 *
 * - `userMessage` is the warm chat-bubble framing the learner reads.
 * - `questions` is a Questionnaire (2–4 entries; conceptName/tier/correct
 *   absent — clarify is elicitation, not assessment).
 *
 * The count bounds come from `tuning.SCOPING` so the prompt contract and
 * runtime validator stay in lock-step. Cerebras strict mode cannot express
 * minItems/maxItems — refine messages compensate Zod-side and become the
 * retry directive verbatim.
 */
export const clarifySchema = z
  .object({
    userMessage: z
      .string()
      .describe(
        "[chat] Warm, brief chat-bubble shown verbatim to the learner. " +
          "Frame what you're about to ask and why — do NOT enumerate the questions here; " +
          "the UI renders the question cards from the `questions` field.",
      ),
    questions: questionnaireSchema.describe(
      `[UI] Between ${SCOPING.minClarifyAnswers} and ${SCOPING.maxClarifyAnswers} clarifying questions. ` +
        "Questions are elicitation — no `conceptName`, no `tier`, no `correct`. " +
        "Focus on scope, baseline knowledge, and end goal.",
    ),
  })
  .refine(
    (v) =>
      v.questions.questions.length >= SCOPING.minClarifyAnswers &&
      v.questions.questions.length <= SCOPING.maxClarifyAnswers,
    {
      message: `clarify questions must be between ${SCOPING.minClarifyAnswers} and ${SCOPING.maxClarifyAnswers}`,
      path: ["questions", "questions"],
    },
  )
  .refine(
    (v) => v.questions.questions.every((q) => q.conceptName === undefined && q.tier === undefined),
    {
      message:
        "clarify questions must not carry conceptName or tier — clarify is elicitation, not assessment",
      path: ["questions", "questions"],
    },
  );

export type ClarifyTurn = z.infer<typeof clarifySchema>;
```

> If `SCOPING.minClarifyAnswers` is not in `tuning.ts`, add it. Check first:
>
> ```
> grep -n "minClarifyAnswers\|maxClarifyAnswers" src/lib/config/tuning.ts
> ```
>
> If `minClarifyAnswers` is missing, edit `src/lib/config/tuning.ts` to add `minClarifyAnswers: 2,` next to `maxClarifyAnswers: 4,` with a one-line comment: `// Lower bound for the clarify questionnaire (P-ON-01).`

- [ ] **Step 4: Run, see them pass**

```
just test src/lib/prompts/clarify.test.ts
```

Expected: all 4 pass.

- [ ] **Step 5: Lint + typecheck**

```
just lint && just typecheck
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/prompts/clarify.ts src/lib/prompts/clarify.test.ts src/lib/config/tuning.ts
git commit -m "feat(prompts): clarifySchema with userMessage + Questionnaire"
```

---

### Task 7: Rewrite `frameworkSchema` with `.describe()` + `userMessage`

**Files:**

- Modify: `src/lib/prompts/framework.ts`
- Modify: `src/lib/prompts/framework.test.ts` (if present — adapt to new shape)

This task strips the now-unused builder helpers and adds `.describe()` + `userMessage`. Existing `.refine`/`.superRefine` logic is preserved.

- [ ] **Step 1: Edit `src/lib/prompts/framework.ts`**

Replace the entire file with:

```ts
// src/lib/prompts/framework.ts
import { z } from "zod/v4";
import { FRAMEWORK } from "@/lib/config/tuning";

/**
 * One rung of the learning ladder.
 *
 * Every field carries [.describe()] visibility-tag text so the model sees a
 * single source of truth — these descriptions are tokenised into the
 * Cerebras strict-mode decoder context, replacing the deleted
 * FRAMEWORK_TURN_INSTRUCTIONS prose block.
 */
const tierSchema = z.object({
  number: z
    .int()
    .positive()
    .describe("[UI] Tier number, starting at 1. Must be contiguous (1, 2, 3, …)."),
  name: z.string().describe("[UI] Short human-readable tier name."),
  description: z
    .string()
    .describe("[UI] One-to-two-sentence description of what a learner at this tier knows."),
  exampleConcepts: z
    .array(z.string())
    .describe(
      `[UI] Between ${FRAMEWORK.minExampleConceptsPerTier} and ${FRAMEWORK.maxExampleConceptsPerTier} concrete example concepts a learner at this tier studies. ` +
        "Pick specific concepts ('borrow checker lifetimes'), not vague themes ('memory stuff').",
    )
    .refine(
      (cs) =>
        cs.length >= FRAMEWORK.minExampleConceptsPerTier &&
        cs.length <= FRAMEWORK.maxExampleConceptsPerTier,
      {
        message: `exampleConcepts must contain between ${FRAMEWORK.minExampleConceptsPerTier} and ${FRAMEWORK.maxExampleConceptsPerTier} entries`,
      },
    ),
});

/**
 * Framework-turn response schema.
 *
 * - `userMessage` is the chat-bubble framing rendered verbatim.
 * - `tiers` is the produced ladder.
 * - `estimatedStartingTier` + `baselineScopeTiers` configure the next turn.
 *
 * Cross-field invariants (contiguous tier numbers, scope monotonicity,
 * scope membership) live in `.superRefine` because Cerebras strict mode
 * cannot express them. Each refine's `.message` is engineered to read as
 * a teacher-style retry directive — it goes back to the model verbatim
 * on the next attempt.
 */
export const frameworkSchema = z
  .object({
    userMessage: z
      .string()
      .describe(
        "[chat] Warm chat-bubble framing the framework you produced. " +
          "Do NOT enumerate the tiers here — the UI renders them from `tiers`.",
      ),
    tiers: z
      .array(tierSchema)
      .describe(
        `[UI] Between ${FRAMEWORK.minTiers} and ${FRAMEWORK.maxTiers} tiers, ordered foundational (1) → advanced. ` +
          "Each tier presupposes the prior one.",
      )
      .refine((ts) => ts.length >= FRAMEWORK.minTiers && ts.length <= FRAMEWORK.maxTiers, {
        message: `tiers must contain between ${FRAMEWORK.minTiers} and ${FRAMEWORK.maxTiers} entries`,
      }),
    estimatedStartingTier: z
      .int()
      .positive()
      .describe(
        "[server] Best-guess tier number for the learner's current level, " +
          "inferred from their clarification answers. A baseline assessment confirms it.",
      ),
    baselineScopeTiers: z
      .array(z.int().positive())
      .describe(
        `[server] Contiguous, ascending-sorted tier numbers the baseline will probe. ` +
          `At most ${FRAMEWORK.maxBaselineScopeSize} tiers. Must include estimatedStartingTier. ` +
          "Default: [estimatedStartingTier−1, estimatedStartingTier, estimatedStartingTier+1], clamped to range.",
      )
      .refine((s) => s.length >= 1 && s.length <= FRAMEWORK.maxBaselineScopeSize, {
        message: `baselineScopeTiers must contain between 1 and ${FRAMEWORK.maxBaselineScopeSize} entries`,
      }),
  })
  .refine(({ tiers }) => tiers.every((t, i) => t.number === i + 1), {
    message: "tier numbers must be contiguous starting at 1",
    path: ["tiers"],
  })
  .superRefine((value, ctx) => {
    const tierNumbers = new Set(value.tiers.map((t) => t.number));
    if (!tierNumbers.has(value.estimatedStartingTier)) {
      ctx.addIssue({
        code: "custom",
        path: ["estimatedStartingTier"],
        message: "estimatedStartingTier must be one of the produced tier numbers",
      });
    }
    const scope = value.baselineScopeTiers;
    const ascending = scope.every((n, i) => i === 0 || n > scope[i - 1]!);
    if (!ascending) {
      ctx.addIssue({
        code: "custom",
        path: ["baselineScopeTiers"],
        message: "baselineScopeTiers must be sorted ascending with no duplicates",
      });
    }
    const contiguous = scope.every((n, i) => i === 0 || n === scope[i - 1]! + 1);
    if (!contiguous) {
      ctx.addIssue({
        code: "custom",
        path: ["baselineScopeTiers"],
        message: "baselineScopeTiers must be contiguous",
      });
    }
    if (!scope.every((n) => tierNumbers.has(n))) {
      ctx.addIssue({
        code: "custom",
        path: ["baselineScopeTiers"],
        message: "baselineScopeTiers must reference produced tier numbers",
      });
    }
    if (!scope.includes(value.estimatedStartingTier)) {
      ctx.addIssue({
        code: "custom",
        path: ["baselineScopeTiers"],
        message: "baselineScopeTiers must include estimatedStartingTier",
      });
    }
  });

/** Inferred framework type. Re-exported via prompts/index.ts. */
export type Framework = z.infer<typeof frameworkSchema>;
```

- [ ] **Step 2: Adapt `framework.test.ts` (if present)**

```
ls src/lib/prompts/framework.test.ts 2>/dev/null
```

If present, update every test fixture object to include a `userMessage: "..."` field. Drop any tests for the now-deleted `buildFrameworkPrompt`, `buildClarificationAssistantMessage`, `buildFrameworkTurnUserContent`, `FRAMEWORK_TURN_INSTRUCTIONS` constants. If the test file becomes empty, delete it.

- [ ] **Step 3: Run**

```
just test src/lib/prompts/framework.test.ts
```

Expected: pass (or "no tests" if file deleted).

- [ ] **Step 4: Lint + typecheck**

```
just lint && just typecheck
```

The build will be red for `clarify.ts`, `parsers.ts`, `baseline.ts` (they import deleted symbols). Fixed in Tasks 8, 12, 14. Commit anyway — this is intentional sequencing inside the same plan, not a hand-off boundary.

- [ ] **Step 5: Commit**

```bash
git add src/lib/prompts/framework.ts src/lib/prompts/framework.test.ts
git commit -m "feat(prompts): frameworkSchema with userMessage + .describe() annotations"
```

---

### Task 8: Rewrite `baselineSchema` on shared `Question` + per-stage refines

**Files:**

- Modify: `src/lib/prompts/baseline.ts`
- Modify: `src/lib/prompts/baseline.test.ts`

The new `baselineSchema` wraps `questionnaireSchema` from Task 2 + adds `userMessage` + per-stage refines (every question has `conceptName`/`tier`; every MC has `correct`; tier-scope invariant via `.superRefine` with externally injected scope tiers — implemented as a schema _factory_ `makeBaselineSchema(scopeTiers)` so the closure captures scope per call).

- [ ] **Step 1: Write the failing tests**

Replace `src/lib/prompts/baseline.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { makeBaselineSchema } from "./baseline";

const fullMc = (id: string, tier: number) => ({
  id,
  tier,
  conceptName: "c",
  type: "multiple_choice" as const,
  prompt: "p",
  options: { A: "a", B: "b", C: "c", D: "d" },
  correct: "A" as const,
  freetextRubric: "r",
});

const fullFt = (id: string, tier: number) => ({
  id,
  tier,
  conceptName: "c",
  type: "free_text" as const,
  prompt: "p",
  freetextRubric: "r",
});

const wrap = (questions: unknown[]) => ({
  userMessage: "framing",
  questions: { questions },
});

describe("makeBaselineSchema", () => {
  it("accepts a valid baseline with all questions in scope", () => {
    const schema = makeBaselineSchema({ scopeTiers: [1, 2, 3] });
    const out = wrap([fullMc("b1", 1), fullFt("b2", 2), fullMc("b3", 3)]);
    expect(() => schema.parse(out)).not.toThrow();
  });

  it("rejects a question whose tier is out of scope", () => {
    const schema = makeBaselineSchema({ scopeTiers: [1, 2] });
    expect(() => schema.parse(wrap([fullMc("b1", 1), fullMc("b2", 5)]))).toThrow(/scope/i);
  });

  it("rejects an MC question missing `correct`", () => {
    const schema = makeBaselineSchema({ scopeTiers: [1] });
    const broken = { ...fullMc("b1", 1) } as Record<string, unknown>;
    delete broken.correct;
    expect(() => schema.parse(wrap([broken]))).toThrow(/correct/i);
  });

  it("rejects a question missing conceptName", () => {
    const schema = makeBaselineSchema({ scopeTiers: [1] });
    const broken = { ...fullMc("b1", 1) } as Record<string, unknown>;
    delete broken.conceptName;
    expect(() => schema.parse(wrap([broken]))).toThrow(/conceptName/i);
  });

  it("rejects a question missing tier", () => {
    const schema = makeBaselineSchema({ scopeTiers: [1] });
    const broken = { ...fullMc("b1", 1) } as Record<string, unknown>;
    delete broken.tier;
    expect(() => schema.parse(wrap([broken]))).toThrow(/tier/i);
  });

  it("rejects duplicate question ids", () => {
    const schema = makeBaselineSchema({ scopeTiers: [1] });
    expect(() => schema.parse(wrap([fullMc("b1", 1), fullMc("b1", 1)]))).toThrow(/duplicate/i);
  });
});
```

- [ ] **Step 2: Run, see it fail**

```
just test src/lib/prompts/baseline.test.ts
```

Expected: module-export-not-found (`makeBaselineSchema`).

- [ ] **Step 3: Replace `src/lib/prompts/baseline.ts` with the JSON-everywhere version**

```ts
// src/lib/prompts/baseline.ts
import { z } from "zod/v4";
import { BASELINE } from "@/lib/config/tuning";
import { questionSchema, MC_OPTION_KEYS } from "./questionnaire";

export { MC_OPTION_KEYS, type McOptionKey } from "./questionnaire";

/**
 * Build a per-call `baselineSchema` whose `.superRefine` knows the scope
 * tiers the framework prescribed. Scope cannot live on the shared
 * `questionSchema` because clarify uses the same Question shape with no
 * scope concept; only the baseline-stage wrapper enforces it.
 */
export interface MakeBaselineSchemaParams {
  /** Tier numbers the baseline may draw from. Sourced from `framework.baselineScopeTiers`. */
  readonly scopeTiers: readonly number[];
}

export function makeBaselineSchema(params: MakeBaselineSchemaParams) {
  const scope = new Set(params.scopeTiers);
  return z
    .object({
      userMessage: z
        .string()
        .describe(
          "[chat] Warm chat-bubble framing the baseline. Do NOT enumerate the questions; the UI renders cards.",
        ),
      questions: z
        .object({
          questions: z
            .array(questionSchema)
            .describe(
              `[UI] Between ${BASELINE.minQuestions} and ${BASELINE.maxQuestions} questions total, ` +
                `${BASELINE.questionsPerTier} per tier in scope. Every question is STANDALONE — never reference another question. ` +
                "Mix multiple_choice and free_text. MC: 4 keyed options A/B/C/D, no 'Not sure' option. " +
                "Every question carries `conceptName`, `tier`, and `freetextRubric`. Every MC carries `correct`. " +
                "Use ids b1, b2, b3, … in order.",
            ),
        })
        .refine(
          (q) =>
            q.questions.length >= BASELINE.minQuestions &&
            q.questions.length <= BASELINE.maxQuestions,
          {
            message: `baseline must contain between ${BASELINE.minQuestions} and ${BASELINE.maxQuestions} questions`,
            path: ["questions"],
          },
        ),
    })
    .superRefine((val, ctx) => {
      const qs = val.questions.questions;
      // Every question must carry conceptName + tier.
      qs.forEach((q, idx) => {
        if (q.conceptName === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["questions", "questions", idx, "conceptName"],
            message: `question ${q.id} is missing required conceptName`,
          });
        }
        if (q.tier === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["questions", "questions", idx, "tier"],
            message: `question ${q.id} is missing required tier`,
          });
        }
        if (q.type === "multiple_choice" && q.correct === undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["questions", "questions", idx, "correct"],
            message: `MC question ${q.id} is missing required correct key`,
          });
        }
      });
      // Tier-scope invariant.
      qs.forEach((q, idx) => {
        if (q.tier !== undefined && !scope.has(q.tier)) {
          ctx.addIssue({
            code: "custom",
            path: ["questions", "questions", idx, "tier"],
            message: `question ${q.id} tier ${q.tier} is outside the requested scope [${[...scope].join(", ")}]`,
          });
        }
      });
      // Unique ids.
      const ids = qs.map((q) => q.id);
      const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
      if (dupes.length > 0) {
        ctx.addIssue({
          code: "custom",
          path: ["questions", "questions"],
          message: `duplicate question ids: ${[...new Set(dupes)].join(", ")}`,
        });
      }
    });
}

/** Inferred Baseline payload — `z.infer` over the factory return type. */
export type BaselineTurn = z.infer<ReturnType<typeof makeBaselineSchema>>;

/**
 * Convenience re-export for code that needs the Questionnaire-level Question type.
 * The per-baseline-stage type narrows further via `.superRefine`, but for storage
 * and UI typing the shared Question union suffices.
 */
export type BaselineQuestion = z.infer<typeof questionSchema>;
```

- [ ] **Step 4: Run tests, see them pass**

```
just test src/lib/prompts/baseline.test.ts
```

Expected: all 6 pass.

- [ ] **Step 5: Lint + typecheck**

```
just lint
```

The build is still red for callers of removed builder helpers (`parsers.ts`, `clarify.ts`, `gradeBaseline.ts`). Continue.

- [ ] **Step 6: Commit**

```bash
git add src/lib/prompts/baseline.ts src/lib/prompts/baseline.test.ts
git commit -m "feat(prompts): baselineSchema factory on shared Question + scope-aware refines"
```

---

### Task 9: Slim `scoping.ts` system prompt + `renderStageEnvelope`

**Files:**

- Modify: `src/lib/prompts/scoping.ts`
- Test: `src/lib/prompts/scoping.test.ts` (existing — rewrite)

- [ ] **Step 1: Rewrite the test**

Replace `src/lib/prompts/scoping.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { renderScopingSystem, renderStageEnvelope } from "./scoping";

describe("renderScopingSystem", () => {
  it("interpolates the topic", () => {
    const out = renderScopingSystem({ kind: "scoping", topic: "Rust ownership" });
    expect(out).toMatch(/Rust ownership/);
  });

  it("XML-escapes a hostile topic", () => {
    const out = renderScopingSystem({ kind: "scoping", topic: "</topic><evil>" });
    expect(out).not.toMatch(/<evil>/);
  });

  it("contains a one-line JSON contract instruction", () => {
    const out = renderScopingSystem({ kind: "scoping", topic: "Go" });
    expect(out.toLowerCase()).toMatch(/json/);
  });

  it("is byte-stable across identical inputs", () => {
    const a = renderScopingSystem({ kind: "scoping", topic: "t" });
    const b = renderScopingSystem({ kind: "scoping", topic: "t" });
    expect(a).toBe(b);
  });
});

describe("renderStageEnvelope", () => {
  it("wraps learner input with bare stage label", () => {
    const out = renderStageEnvelope({
      stage: "generate framework",
      learnerInput: "A: Rust beginner",
    });
    expect(out).toContain("<stage>generate framework</stage>");
    expect(out).toContain("<learner_input>");
    expect(out).toContain("A: Rust beginner");
  });

  it("XML-escapes learner input", () => {
    const out = renderStageEnvelope({ stage: "clarify", learnerInput: "</learner_input>" });
    expect(out).not.toMatch(/<\/learner_input>\s*<\/learner_input>/);
  });
});
```

- [ ] **Step 2: Run, see it fail**

```
just test src/lib/prompts/scoping.test.ts
```

- [ ] **Step 3: Replace `src/lib/prompts/scoping.ts`**

```ts
// src/lib/prompts/scoping.ts
import { escapeXmlText } from "@/lib/security/escapeXmlText";
import type { ScopingSeedInputs } from "@/lib/types/context";

/**
 * Slim system prompt for a scoping pass.
 *
 * Contains only: persona, topic interpolation, the one-line "reply in JSON
 * matching the attached schema" rule. Per-stage instructions are NOT here —
 * they live entirely on each stage schema's `.describe()` annotations,
 * which Cerebras strict mode tokenises into the decoder context as part of
 * `response_format`. The wire-side rule "this turn's schema is attached to
 * THIS turn's user envelope" is the only contract the system prompt
 * carries.
 *
 * Emitted exactly once per scoping pass — `renderContext` only renders a
 * `role: "system"` row when one is present at the top of the message log.
 * Subsequent turns append user/assistant rows; the prefix stays byte-stable.
 */
export function renderScopingSystem(inputs: ScopingSeedInputs): string {
  return `<role>
You are Nalu, an expert teacher and tutor. You are building a bespoke course for a learner on the topic of <scoping_topic>${escapeXmlText(inputs.topic)}</scoping_topic>.

Each turn, reply with a single JSON object matching the response schema attached to that turn. Field-level guidance lives in the schema's description metadata — read it carefully before generating. No prose outside the JSON object.
</role>`;
}

export interface RenderStageEnvelopeParams {
  /** Bare stage label — appears verbatim inside `<stage>...</stage>`. */
  readonly stage: "clarify" | "generate framework" | "generate baseline" | "grade baseline";
  /** Learner input — XML-escaped before embedding. May be empty for stage-only envelopes. */
  readonly learnerInput: string;
}

/**
 * Build the per-turn user-role envelope. Minimal by design — the schema's
 * descriptions carry per-field guidance; this wrapper just names the stage
 * and surfaces the learner's input. Cache-prefix stability: the only
 * variable bytes per turn are the stage label and the escaped input.
 */
export function renderStageEnvelope(params: RenderStageEnvelopeParams): string {
  return `<stage>${params.stage}</stage>
<learner_input>
${escapeXmlText(params.learnerInput)}
</learner_input>`;
}
```

- [ ] **Step 4: Run, see them pass**

```
just test src/lib/prompts/scoping.test.ts
```

- [ ] **Step 5: Lint + typecheck**

```
just lint
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/prompts/scoping.ts src/lib/prompts/scoping.test.ts
git commit -m "refactor(prompts): slim scoping system prompt; add renderStageEnvelope"
```

---

### Task 10: Update `src/lib/prompts/index.ts` barrel

**Files:**

- Modify: `src/lib/prompts/index.ts`

- [ ] **Step 1: Read current barrel**

```
just typecheck 2>&1 | head -50
```

- [ ] **Step 2: Rewrite barrel**

```ts
// src/lib/prompts/index.ts
export {
  questionSchema,
  questionnaireSchema,
  responseSchema,
  responsesSchema,
  MC_OPTION_KEYS,
  type Question,
  type Questionnaire,
  type Response,
  type Responses,
  type McOptionKey,
} from "./questionnaire";
export { clarifySchema, type ClarifyTurn } from "./clarify";
export { frameworkSchema, type Framework } from "./framework";
export {
  makeBaselineSchema,
  type BaselineTurn,
  type BaselineQuestion,
  type MakeBaselineSchemaParams,
} from "./baseline";
export { gradeBaselineSchema, type GradeBaselineTurn } from "./baselineGrading";
export { renderScopingSystem, renderStageEnvelope } from "./scoping";
```

> If `baselineGrading.ts` does not exist yet (Task 11), comment out that line and uncomment it during Task 11.

- [ ] **Step 3: Typecheck**

```
just typecheck
```

Expected: `index.ts` line resolves. (Other consumers still red — fixed in Tasks 11–13.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/prompts/index.ts
git commit -m "refactor(prompts): re-export new schema surface from barrel"
```

---

### Task 11: `gradeBaselineSchema`

**Files:**

- Create: `src/lib/prompts/baselineGrading.ts`
- Test: `src/lib/prompts/baselineGrading.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/prompts/baselineGrading.test.ts
import { describe, expect, it } from "vitest";
import { gradeBaselineSchema } from "./baselineGrading";

const good = {
  userMessage: "Here is how you did.",
  gradings: [
    {
      questionId: "b1",
      conceptName: "ownership",
      verdict: "correct" as const,
      qualityScore: 5 as const,
      rationale: "Hit the key idea.",
    },
  ],
};

describe("gradeBaselineSchema", () => {
  it("accepts a well-formed grading payload", () => {
    expect(() => gradeBaselineSchema.parse(good)).not.toThrow();
  });

  it("rejects an unknown verdict", () => {
    expect(() =>
      gradeBaselineSchema.parse({
        ...good,
        gradings: [{ ...good.gradings[0], verdict: "mediocre" }],
      }),
    ).toThrow();
  });

  it("rejects a qualityScore out of range", () => {
    expect(() =>
      gradeBaselineSchema.parse({
        ...good,
        gradings: [{ ...good.gradings[0], qualityScore: 99 }],
      }),
    ).toThrow();
  });

  it("rejects duplicate questionIds", () => {
    expect(() =>
      gradeBaselineSchema.parse({
        ...good,
        gradings: [good.gradings[0], good.gradings[0]],
      }),
    ).toThrow(/duplicate/i);
  });
});
```

- [ ] **Step 2: Run, see it fail**

```
just test src/lib/prompts/baselineGrading.test.ts
```

- [ ] **Step 3: Implement**

```ts
// src/lib/prompts/baselineGrading.ts
import { z } from "zod/v4";
import { qualityScoreSchema } from "@/lib/types/spaced-repetition";

const verdictSchema = z
  .enum(["correct", "partial", "incorrect"])
  .describe("[server] Overall verdict on the learner's answer. Drives SM-2 quality bucketing.");

const gradingItemSchema = z.object({
  questionId: z.string().describe("[server] Matches the question's id."),
  conceptName: z
    .string()
    .describe("[server] Concept the question probed (carried from the baseline question)."),
  verdict: verdictSchema,
  qualityScore: qualityScoreSchema.describe(
    "[server] SM-2 quality score 0–5. Map: correct → 4–5, partial → 2–3, incorrect → 0–1. " +
      "Calibrate by depth of understanding shown.",
  ),
  rationale: z
    .string()
    .describe("[server] One- or two-sentence justification. Internal — not shown to the learner."),
});

/**
 * Grade-baseline turn schema. Mirrors the rest of the scoping contract:
 * userMessage (chat) + structured gradings (server-only).
 *
 * Cross-field invariant: gradings list has unique questionIds. Count
 * bounds come from the submitted answer list — the harness enforces those
 * post-decode in `gradeBaseline.ts` because Cerebras strict mode rejects
 * minItems/maxItems.
 */
export const gradeBaselineSchema = z
  .object({
    userMessage: z
      .string()
      .describe(
        "[chat] Brief warm summary of how the learner did. Do NOT list per-question verdicts here — the UI renders those from `gradings`.",
      ),
    gradings: z
      .array(gradingItemSchema)
      .describe("[server] One grading entry per question that was sent to the grader."),
  })
  .superRefine((val, ctx) => {
    const ids = val.gradings.map((g) => g.questionId);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["gradings"],
        message: `duplicate questionIds in gradings: ${[...new Set(dupes)].join(", ")}`,
      });
    }
  });

export type GradeBaselineTurn = z.infer<typeof gradeBaselineSchema>;
```

- [ ] **Step 4: Run, see them pass**

```
just test src/lib/prompts/baselineGrading.test.ts
```

- [ ] **Step 5: Uncomment the `baselineGrading` export in `src/lib/prompts/index.ts`** (if commented in Task 10).

- [ ] **Step 6: Commit**

```bash
git add src/lib/prompts/baselineGrading.ts src/lib/prompts/baselineGrading.test.ts src/lib/prompts/index.ts
git commit -m "feat(prompts): gradeBaselineSchema for grade-baseline turn"
```

---

### Task 12: Rewrite `src/lib/types/jsonb.ts` storage schemas

**Files:**

- Modify: `src/lib/types/jsonb.ts`

- [ ] **Step 1: Replace clarification + framework + baseline blocks**

Replace the three blocks in `src/lib/types/jsonb.ts` (`courses.clarification`, `courses.framework`, `courses.baseline`) with:

```ts
import { z } from "zod";
import {
  questionSchema as questionSchemaV4,
  responseSchema as responseSchemaV4,
} from "@/lib/prompts/questionnaire";
import { qualityScoreSchema } from "@/lib/types/spaced-repetition";

/**
 * NOTE: storage schemas live on `zod` v3 (the v3 import the rest of jsonb.ts
 * already uses for table guards). Wire schemas live on `zod/v4` for the
 * `z.toJSONSchema()` codegen. We bridge by re-defining the JSONB shapes
 * here in v3 mirroring the v4 wire shape — these two surfaces drift only
 * if a developer changes one without the other, which is caught by the
 * round-trip test below.
 */

// --- courses.clarification --------------------------------------------------

const v3McOption = z.enum(["A", "B", "C", "D"]);

const v3Question = z.discriminatedUnion("type", [
  z.object({
    id: z.string(),
    type: z.literal("free_text"),
    prompt: z.string(),
    freetextRubric: z.string(),
    conceptName: z.string().optional(),
    tier: z.number().int().positive().optional(),
  }),
  z.object({
    id: z.string(),
    type: z.literal("multiple_choice"),
    prompt: z.string(),
    options: z.object({ A: z.string(), B: z.string(), C: z.string(), D: z.string() }),
    correct: v3McOption.optional(),
    freetextRubric: z.string(),
    conceptName: z.string().optional(),
    tier: z.number().int().positive().optional(),
  }),
]);

const v3Response = z
  .object({
    questionId: z.string(),
    choice: v3McOption.optional(),
    freetext: z.string().optional(),
  })
  .refine((r) => (r.choice === undefined) !== (r.freetext === undefined), {
    message: "response must have exactly one of choice or freetext",
  });

export const clarificationJsonbSchema = z.object({
  questions: z.array(v3Question),
  responses: z.array(v3Response),
});
export type ClarificationJsonb = z.infer<typeof clarificationJsonbSchema>;

// --- courses.framework ------------------------------------------------------

/** One rung of the learning ladder. camelCase — matches wire shape (spec §4.8). */
export const tierSchema = z.object({
  number: z.number().int().min(1),
  name: z.string(),
  description: z.string(),
  exampleConcepts: z.array(z.string()),
});

export const frameworkJsonbSchema = z.object({
  tiers: z.array(tierSchema),
  estimatedStartingTier: z.number().int().min(1),
  baselineScopeTiers: z.array(z.number().int().min(1)),
});
export type FrameworkJsonb = z.infer<typeof frameworkJsonbSchema>;

// --- courses.baseline -------------------------------------------------------

/** LLM grading output for one baseline question. */
export const baselineGradingSchema = z.object({
  questionId: z.string(),
  conceptName: z.string(),
  verdict: z.enum(["correct", "partial", "incorrect"]),
  qualityScore: qualityScoreSchema,
  rationale: z.string(),
});

export const baselineJsonbSchema = z.object({
  questions: z.array(v3Question),
  responses: z.array(v3Response),
  gradings: z.array(baselineGradingSchema),
});
export type BaselineJsonb = z.infer<typeof baselineJsonbSchema>;

// (waves.*, blueprint, etc. blocks below this point are UNTOUCHED.)
```

Keep the file's remaining sections (due-concepts snapshot, seed source, blueprint) verbatim.

- [ ] **Step 2: Run the queries test suite to find consumers that still hold old field names**

```
just test src/db/queries
```

Expected: `courses.ts` queries should still pass since `courseRowGuard` parses opaque-typed JSONB through the schema. If any test breaks, it has hard-coded an old field name (`text`, `single_select`, `answers`); update the fixture to the new shape.

- [ ] **Step 3: Update `src/lib/testing/scopingInvariants.ts`**

```
grep -n "baseline_scope_tiers\|estimated_starting_tier\|example_concepts\|scope_summary" src/lib/testing/scopingInvariants.ts
```

For each hit, rename to camelCase (`baselineScopeTiers`, `estimatedStartingTier`, `exampleConcepts`). Delete any reference to `scope_summary` — the field is removed.

- [ ] **Step 4: Lint + typecheck**

```
just lint && just typecheck
```

The build remains red where lib steps reference `toClarificationJsonb`, `toFrameworkJsonb`, `toBaselineJsonb` (gone) or old field names. Fixed in Tasks 13–15.

- [ ] **Step 5: Commit**

```bash
git add src/lib/types/jsonb.ts src/lib/testing/scopingInvariants.ts
git commit -m "refactor(types): rewrite scoping JSONB schemas to camelCase wire shape"
```

---

### Task 13: Rewrite `src/lib/course/clarify.ts`

**Files:**

- Modify: `src/lib/course/clarify.ts`
- Modify: `src/lib/course/clarify.test.ts` (existing)

- [ ] **Step 1: Read current test scaffolding (do not edit yet)**

```
just test src/lib/course/clarify.test.ts 2>&1 | head -30
```

- [ ] **Step 2: Replace `src/lib/course/clarify.ts`**

```ts
import { sanitiseUserInput } from "@/lib/security/sanitiseUserInput";
import { executeTurn } from "@/lib/turn/executeTurn";
import { createCourse, updateCourseScopingState } from "@/db/queries/courses";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import { clarifySchema, type ClarifyTurn } from "@/lib/prompts/clarify";
import { renderStageEnvelope } from "@/lib/prompts/scoping";
import type { ClarificationJsonb } from "@/lib/types/jsonb";

/** Parameters for {@link clarify}. */
export interface ClarifyParams {
  readonly userId: string;
  readonly topic: string;
}

export interface ClarifyResult {
  readonly courseId: string;
  /** Full Questionnaire payload — the UI renders cards from this. */
  readonly clarification: ClarifyTurn;
  readonly nextStage: "framework";
}

/**
 * Drive the clarify turn.
 *
 * Flow: createCourse → ensureOpenScopingPass → executeTurn(responseSchema=clarifySchema)
 *   → persist wire shape directly (no translator) → return.
 *
 * The persisted JSONB shape is `{ questions, responses: [] }` — responses
 * are populated after the learner submits answers via the next router call.
 */
export async function clarify(params: ClarifyParams): Promise<ClarifyResult> {
  const course = await createCourse({ userId: params.userId, topic: params.topic });

  if (course.clarification !== null) {
    // Idempotency: rebuild ClarifyTurn from stored JSONB. `courseRowGuard`
    // already validated the row against `clarificationJsonbSchema`.
    const stored = course.clarification as ClarificationJsonb;
    return {
      courseId: course.id,
      clarification: {
        userMessage: "", // userMessage not persisted post-clarify — UI shows nothing on replay.
        questions: { questions: stored.questions },
      },
      nextStage: "framework",
    };
  }

  const pass = await ensureOpenScopingPass(course.id);
  const { parsed } = await executeTurn({
    parent: { kind: "scoping", id: pass.id },
    seed: { kind: "scoping", topic: params.topic },
    userMessageContent: renderStageEnvelope({
      stage: "clarify",
      learnerInput: sanitiseUserInput(params.topic),
    }),
    responseSchema: clarifySchema,
    responseSchemaName: "clarify",
    label: "clarify",
    successSummary: (p) => `questions=${p.questions.questions.length}`,
  });

  // Persist wire shape directly. responses start empty; populated after the learner submits.
  await updateCourseScopingState(course.id, {
    clarification: { questions: parsed.questions.questions, responses: [] },
  });

  return { courseId: course.id, clarification: parsed, nextStage: "framework" };
}
```

- [ ] **Step 3: Update `clarify.test.ts`**

Adjust test fixtures: the mocked `executeTurn` (or its underlying `generateChat`) should return JSON like `'{"userMessage":"hi","questions":{"questions":[{"id":"q1","type":"free_text","prompt":"p","freetextRubric":"r"},{"id":"q2","type":"free_text","prompt":"p2","freetextRubric":"r"}]}}'`. Update assertions that read `result.questions` (an array of strings) to read `result.clarification.questions.questions` (the Question array). Update idempotency-branch assertions accordingly.

- [ ] **Step 4: Run**

```
just test src/lib/course/clarify.test.ts
```

Expected: green.

- [ ] **Step 5: Lint + typecheck**

```
just lint
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/course/clarify.ts src/lib/course/clarify.test.ts
git commit -m "refactor(course): clarify lib step on JSON-everywhere contract"
```

---

### Task 14: Rewrite `src/lib/course/generateFramework.ts`

**Files:**

- Modify: `src/lib/course/generateFramework.ts`
- Modify: `src/lib/course/generateFramework.test.ts`

- [ ] **Step 1: Replace `generateFramework.ts`**

```ts
import { TRPCError } from "@trpc/server";
import { executeTurn } from "@/lib/turn/executeTurn";
import { getCourseById, updateCourseScopingState } from "@/db/queries/courses";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import { SCOPING } from "@/lib/config/tuning";
import { frameworkSchema, type Framework } from "@/lib/prompts/framework";
import { renderStageEnvelope } from "@/lib/prompts/scoping";
import type { ClarificationJsonb, FrameworkJsonb } from "@/lib/types/jsonb";

export interface GenerateFrameworkParams {
  readonly courseId: string;
  readonly userId: string;
  /** Learner responses, one per clarify question. Same order as the stored questions. */
  readonly responses: readonly { readonly questionId: string; readonly freetext: string }[];
}

export interface GenerateFrameworkResult {
  readonly framework: FrameworkJsonb;
  readonly nextStage: "baseline";
}

export async function generateFramework(
  params: GenerateFrameworkParams,
): Promise<GenerateFrameworkResult> {
  if (params.responses.length === 0) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "responses cannot be empty" });
  }
  if (params.responses.length > SCOPING.maxClarifyAnswers) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `at most ${SCOPING.maxClarifyAnswers} responses allowed`,
    });
  }

  const course = await getCourseById(params.courseId, params.userId);
  if (course.status !== "scoping") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `generateFramework: course ${course.id} is in status '${course.status}'`,
    });
  }
  if (course.clarification === null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `generateFramework: course ${course.id} has no clarification`,
    });
  }
  const clarification = course.clarification as ClarificationJsonb;
  if (params.responses.length !== clarification.questions.length) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `responses length (${params.responses.length}) must match questions length (${clarification.questions.length})`,
    });
  }
  // Idempotency.
  if (course.framework !== null) {
    return { framework: course.framework as FrameworkJsonb, nextStage: "baseline" };
  }

  // Persist the learner's responses on the clarification row before calling the LLM,
  // so a retry of generateFramework does not lose them. Idempotent: overwrites the
  // empty `responses: []` initialised by clarify.
  await updateCourseScopingState(course.id, {
    clarification: {
      questions: clarification.questions,
      responses: params.responses.map((r) => ({ questionId: r.questionId, freetext: r.freetext })),
    },
  });

  // Render responses as Q/A pairs for the envelope. Question text comes from the
  // stored questions (trusted — we generated them). Response freetext is sanitised
  // by `renderStageEnvelope` (XML escape).
  const qaPairs = params.responses
    .map((r) => {
      const q = clarification.questions.find((q) => q.id === r.questionId);
      return q
        ? `Q: ${q.prompt}\nA: ${r.freetext}`
        : `Q: (unknown ${r.questionId})\nA: ${r.freetext}`;
    })
    .join("\n\n");

  const pass = await ensureOpenScopingPass(course.id);
  const { parsed } = await executeTurn({
    parent: { kind: "scoping", id: pass.id },
    seed: { kind: "scoping", topic: course.topic },
    userMessageContent: renderStageEnvelope({
      stage: "generate framework",
      learnerInput: qaPairs,
    }),
    responseSchema: frameworkSchema,
    responseSchemaName: "framework",
    label: "framework",
    successSummary: (p) => `tiers=${p.tiers.length} startTier=${p.estimatedStartingTier}`,
  });

  // Wire shape IS storage shape — write the structured fields directly (no translator).
  // `userMessage` is the chat bubble; we drop it from JSONB persistence because it's
  // not re-read after the turn (UI re-uses the assistant_response row for replay).
  const jsonb: FrameworkJsonb = {
    tiers: parsed.tiers,
    estimatedStartingTier: parsed.estimatedStartingTier,
    baselineScopeTiers: parsed.baselineScopeTiers,
  };
  await updateCourseScopingState(course.id, { framework: jsonb });

  return { framework: jsonb, nextStage: "baseline" };
}

/** Re-exported for routers + tests. */
export type { Framework };
```

- [ ] **Step 2: Update `generateFramework.test.ts`**

- Rename `params.answers` → `params.responses` everywhere; switch to `{ questionId, freetext }` shape.
- Mock LLM output: return JSON like `'{"userMessage":"...","tiers":[...],"estimatedStartingTier":2,"baselineScopeTiers":[1,2,3]}'`.
- Replace any reference to old snake_case JSONB keys (`baseline_scope_tiers`) with camelCase.
- Delete tests that asserted `scope_summary` or `topic` on stored JSONB — those fields are gone.

- [ ] **Step 3: Run**

```
just test src/lib/course/generateFramework.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/course/generateFramework.ts src/lib/course/generateFramework.test.ts
git commit -m "refactor(course): generateFramework on JSON-everywhere contract"
```

---

### Task 15: Rewrite `src/lib/course/generateBaseline.ts`

**Files:**

- Modify: `src/lib/course/generateBaseline.ts`
- Modify: `src/lib/course/generateBaseline.test.ts`

- [ ] **Step 1: Replace `generateBaseline.ts`**

```ts
import { TRPCError } from "@trpc/server";
import { executeTurn } from "@/lib/turn/executeTurn";
import { getCourseById, updateCourseScopingState } from "@/db/queries/courses";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import { makeBaselineSchema, type BaselineTurn } from "@/lib/prompts/baseline";
import { renderStageEnvelope } from "@/lib/prompts/scoping";
import type { BaselineJsonb, FrameworkJsonb } from "@/lib/types/jsonb";

export interface GenerateBaselineParams {
  readonly courseId: string;
  readonly userId: string;
}

export interface GenerateBaselineResult {
  readonly baseline: BaselineTurn;
  readonly nextStage: "answering";
}

export async function generateBaseline(
  params: GenerateBaselineParams,
): Promise<GenerateBaselineResult> {
  const course = await getCourseById(params.courseId, params.userId);

  if (course.status !== "scoping") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `generateBaseline: course ${course.id} is in status '${course.status}'`,
    });
  }
  if (course.clarification === null || course.framework === null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `generateBaseline: course ${course.id} requires both clarification and framework`,
    });
  }

  const framework = course.framework as FrameworkJsonb;
  const scopeTiers = framework.baselineScopeTiers;
  const schema = makeBaselineSchema({ scopeTiers });

  if (course.baseline !== null) {
    const stored = course.baseline as BaselineJsonb;
    // Re-validate the stored questions against the per-call schema so the
    // returned BaselineTurn matches the freshly-typed shape.
    const out = schema.parse({
      userMessage: "",
      questions: { questions: stored.questions },
    });
    return { baseline: out, nextStage: "answering" };
  }

  const pass = await ensureOpenScopingPass(course.id);
  const { parsed } = await executeTurn({
    parent: { kind: "scoping", id: pass.id },
    seed: { kind: "scoping", topic: course.topic },
    userMessageContent: renderStageEnvelope({
      stage: "generate baseline",
      // Stage envelope carries no learner input on this turn — scope is in the
      // schema description. Empty learner_input is the bare-stage signal.
      learnerInput: "",
    }),
    responseSchema: schema,
    responseSchemaName: "baseline",
    label: "baseline",
    successSummary: (p) => `questions=${p.questions.questions.length}`,
  });

  const jsonb: BaselineJsonb = {
    questions: parsed.questions.questions,
    responses: [],
    gradings: [],
  };
  await updateCourseScopingState(course.id, { baseline: jsonb });

  return { baseline: parsed, nextStage: "answering" };
}
```

- [ ] **Step 2: Update `generateBaseline.test.ts`**

Mock LLM output as `'{"userMessage":"...","questions":{"questions":[...]}}'` with full `Question` shape (every question has `conceptName`, `tier`, `correct` on MC). Update idempotency-branch fixtures: stored JSONB is `{ questions: [...], responses: [], gradings: [] }`.

- [ ] **Step 3: Run**

```
just test src/lib/course/generateBaseline.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/course/generateBaseline.ts src/lib/course/generateBaseline.test.ts
git commit -m "refactor(course): generateBaseline on JSON-everywhere contract"
```

---

### Task 16: Rewrite `src/lib/course/gradeBaseline.ts` onto `executeTurn`

**Files:**

- Modify: `src/lib/course/gradeBaseline.ts`
- Keep: `src/lib/course/gradeBaseline.internal.ts` (MC mechanical grading helpers — preserved)
- Modify: `src/lib/course/gradeBaseline.test.ts`

- [ ] **Step 1: Replace `gradeBaseline.ts`**

```ts
import { TRPCError } from "@trpc/server";
import { executeTurn } from "@/lib/turn/executeTurn";
import { getCourseById, updateCourseScopingState } from "@/db/queries/courses";
import { ensureOpenScopingPass } from "@/db/queries/scopingPasses";
import { gradeBaselineSchema } from "@/lib/prompts/baselineGrading";
import { renderStageEnvelope } from "@/lib/prompts/scoping";
import type { BaselineJsonb, BaselineGradingSchema } from "@/lib/types/jsonb";
import { baselineGradingSchema } from "@/lib/types/jsonb";
import type { LlmUsage } from "@/lib/types/llm";
import type { McOptionKey } from "@/lib/prompts/questionnaire";
import { gradeMc, splitOne, ZERO_USAGE, toEvaluationItem } from "./gradeBaseline.internal";

export type BaselineAnswer =
  | { readonly id: string; readonly kind: "mc"; readonly selected: McOptionKey }
  | {
      readonly id: string;
      readonly kind: "freetext";
      readonly text: string;
      readonly fromEscape: boolean;
    };

export interface GradeBaselineParams {
  readonly courseId: string;
  readonly userId: string;
  readonly answers: readonly BaselineAnswer[];
}

export interface GradeBaselineResult {
  readonly gradings: readonly z.infer<typeof baselineGradingSchema>[];
  readonly usage: LlmUsage;
}

/**
 * Drive the baseline-grading turn.
 *
 * Pattern (spec §4.9): course fetch → preconditions → idempotency →
 * mechanical MC pass (no LLM) → if any non-MC answers, executeTurn with
 * `gradeBaselineSchema` → merge → persist `courses.baseline.gradings`.
 *
 * The all-MC shortcut (no LLM call when every answer is an MC click) is
 * preserved verbatim from the legacy implementation — same byId lookup,
 * same mechanical grader (`gradeMc` in `gradeBaseline.internal.ts`).
 */
export async function gradeBaseline(params: GradeBaselineParams): Promise<GradeBaselineResult> {
  const course = await getCourseById(params.courseId, params.userId);
  if (course.status !== "scoping") {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `gradeBaseline: course ${course.id} is in status '${course.status}'`,
    });
  }
  if (course.baseline === null) {
    throw new TRPCError({
      code: "PRECONDITION_FAILED",
      message: `gradeBaseline: course ${course.id} has no baseline`,
    });
  }

  const stored = course.baseline as BaselineJsonb;
  // Idempotency — if gradings already exist, just return them.
  if (stored.gradings.length > 0) {
    return { gradings: stored.gradings, usage: ZERO_USAGE };
  }

  // Build byId, validate answers (every id known, no duplicates).
  const byId = Object.fromEntries(stored.questions.map((q) => [q.id, q] as const));
  const unknown = params.answers.find((a) => !(a.id in byId));
  if (unknown) throw new Error(`answer for unknown question id: ${unknown.id}`);
  const dupId = params.answers.map((a) => a.id).find((id, i, all) => all.indexOf(id) !== i);
  if (dupId !== undefined) throw new Error(`duplicate answer for question id: ${dupId}`);

  const answerById = Object.fromEntries(params.answers.map((a) => [a.id, a] as const));

  const splits = stored.questions.map((q) => {
    const a = answerById[q.id];
    if (!a) throw new Error(`no answer provided for question ${q.id}`);
    return splitOne(q, a);
  });

  const llmItems = splits.flatMap((s) => (s.kind === "llm" ? [s.item] : []));

  // All-MC shortcut.
  if (llmItems.length === 0) {
    const gradings = splits.map((s) => {
      if (s.kind !== "mechanical") throw new Error(`no mechanical grading for ${s.qid}`);
      return s.grading;
    });
    await updateCourseScopingState(course.id, {
      baseline: { ...stored, gradings },
    });
    return { gradings, usage: ZERO_USAGE };
  }

  // LLM grading via executeTurn.
  const pass = await ensureOpenScopingPass(course.id);
  const learnerInput = JSON.stringify({ items: llmItems });
  const { parsed, usage } = await executeTurn({
    parent: { kind: "scoping", id: pass.id },
    seed: { kind: "scoping", topic: course.topic },
    userMessageContent: renderStageEnvelope({ stage: "grade baseline", learnerInput }),
    responseSchema: gradeBaselineSchema,
    responseSchemaName: "grade_baseline",
    label: "grade-baseline",
    successSummary: (p) => `gradings=${p.gradings.length}`,
  });

  // Fail loud on drift between submitted and returned ids.
  const submitted = new Set(llmItems.map((i) => i.questionId));
  const returned = new Set(parsed.gradings.map((g) => g.questionId));
  const stragglers = [...returned].filter((id) => !submitted.has(id));
  if (stragglers.length > 0) {
    throw new Error(`grader returned unsubmitted ids: ${stragglers.join(", ")}`);
  }
  const omitted = [...submitted].filter((id) => !returned.has(id));
  if (omitted.length > 0) throw new Error(`grader omitted ids: ${omitted.join(", ")}`);

  const llmGradingsById = Object.fromEntries(
    parsed.gradings.map((g) => [g.questionId, g] as const),
  );

  const mergedGradings = splits.map((s) => {
    if (s.kind === "mechanical") return s.grading;
    const g = llmGradingsById[s.qid];
    if (!g) throw new Error(`no grading produced for ${s.qid}`);
    return {
      questionId: g.questionId,
      conceptName: g.conceptName,
      verdict: g.verdict,
      qualityScore: g.qualityScore,
      rationale: g.rationale,
    };
  });

  await updateCourseScopingState(course.id, {
    baseline: { ...stored, gradings: mergedGradings },
  });

  return { gradings: mergedGradings, usage };
}
```

> If `gradeBaseline.internal.ts`'s mechanical-grading output uses the OLD field names (`isCorrect`, `quality_score`, `concept_name`, `rationale`) check it now:
>
> ```
> grep -n "concept_name\|quality_score\|is_correct\|isCorrect\|qualityScore" src/lib/course/gradeBaseline.internal.ts
> ```
>
> If it emits `quality_score`/`concept_name`/`is_correct` snake_case, rename to `qualityScore`/`conceptName`/`verdict` (mapping `isCorrect: true → "correct"`, `false → "incorrect"` — there's no partial path for mechanical MC). Keep `splitOne`, `gradeMc`, `toEvaluationItem`, `ZERO_USAGE` API surface stable.

- [ ] **Step 2: Update `gradeBaseline.test.ts`**

- Replace `generateStructured` mock with an `executeTurn` mock (or, if test directly mocks `generateChat`, return JSON shaped per `gradeBaselineSchema`).
- Adjust assertions: grading shape now has `verdict` + `qualityScore` (camelCase) + `conceptName`, not `is_correct`/`quality_score`/`concept_name`.
- Drop the test for "buildBaselineEvaluationPrompt is called" — that path is gone.
- Add a test asserting idempotency: a second call with non-empty stored gradings returns them without making any LLM call.

- [ ] **Step 3: Run**

```
just test src/lib/course/gradeBaseline.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/course/gradeBaseline.ts src/lib/course/gradeBaseline.test.ts src/lib/course/gradeBaseline.internal.ts
git commit -m "refactor(course): gradeBaseline on executeTurn + gradeBaselineSchema"
```

---

### Task 17: Update `diagnoseFailure.ts` for JSON-only failure modes

**Files:**

- Modify: `src/lib/turn/diagnoseFailure.ts`
- Modify: `src/lib/turn/diagnoseFailure.test.ts`

- [ ] **Step 1: Rewrite test**

Replace `src/lib/turn/diagnoseFailure.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { ValidationGateFailure } from "@/lib/llm/parseAssistantResponse";
import { diagnoseFailure } from "./diagnoseFailure";

const fail = (msg: string) => new ValidationGateFailure("missing_response", msg);

describe("diagnoseFailure (JSON contract)", () => {
  it("calls out a non-JSON response", () => {
    const err = fail("Your previous response did not parse as JSON.");
    expect(diagnoseFailure(err, "<framework>...</framework>")).toMatch(/json/i);
  });

  it("calls out a missing userMessage", () => {
    const err = fail('"userMessage": Required');
    expect(diagnoseFailure(err, '{"tiers":[]}')).toMatch(/userMessage/);
  });

  it("notes a plausible cross-stage payload (framework keys in a baseline turn)", () => {
    const err = fail("baselineScopeTiers");
    const raw =
      '{"tiers":[{"number":1,"name":"a","description":"d","exampleConcepts":["x"]}],"estimatedStartingTier":1,"baselineScopeTiers":[1]}';
    expect(diagnoseFailure(err, raw)).toMatch(/framework|stage/i);
  });

  it("falls back to a generic message when no heuristic matches", () => {
    const err = fail("something else");
    expect(diagnoseFailure(err, '{"x":"y"}')).toMatch(/zod|gate|directive/i);
  });
});
```

- [ ] **Step 2: Rewrite `diagnoseFailure.ts`**

```ts
import type { ValidationGateFailure } from "@/lib/llm/parseAssistantResponse";

/**
 * Heuristic post-mortem for `ValidationGateFailure` during live smoke.
 *
 * Under JSON-everywhere all parse failures fall into a small set:
 *   1. Non-JSON response — directive starts with "Your previous response did not parse as JSON".
 *   2. Missing required field — Zod error mentions a field path.
 *   3. Wrong stage payload — the raw text JSON-parses but its keys belong to another stage.
 *   4. Generic Zod failure — fall through with a short gloss.
 */

const STAGE_KEY_SIGNATURES: Record<string, readonly string[]> = {
  clarify: ["questions.questions", "freetextRubric"],
  framework: ["tiers", "estimatedStartingTier", "baselineScopeTiers"],
  baseline: ["questions.questions", "conceptName", "tier", "correct"],
  "grade-baseline": ["gradings", "verdict", "qualityScore"],
};

function detectStageFromBody(raw: string): string | null {
  // Cheap JSON probe — if the response parses, score top-level + nested keys
  // against each stage's signature. Highest score (≥ 2 unique sigs) wins.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const haystack = JSON.stringify(parsed);
  const scores = Object.entries(STAGE_KEY_SIGNATURES).map(([stage, sigs]) => ({
    stage,
    score: sigs.filter((s) => haystack.includes(`"${s.split(".").pop()!}"`)).length,
  }));
  const best = scores.reduce((a, b) => (b.score > a.score ? b : a), { stage: "", score: 0 });
  return best.score >= 2 ? best.stage : null;
}

export function diagnoseFailure(err: ValidationGateFailure, raw: string): string {
  const detail = err.detail;

  // (1) Non-JSON.
  if (detail.toLowerCase().includes("did not parse as json")) {
    return "model returned text that is not valid JSON — check for stray prose outside the JSON envelope.";
  }

  // (2) Missing userMessage — every stage requires it.
  if (detail.includes("userMessage") && detail.toLowerCase().includes("required")) {
    return "response is missing the required `userMessage` field — every turn must include it.";
  }

  // (3) Wrong-stage detection.
  const detected = detectStageFromBody(raw);
  if (detected !== null) {
    return `body matches the ${detected} stage schema — model appears to have answered the wrong turn.`;
  }

  // (4) Generic Zod fallback.
  if (detail.match(/\[\s*\{[\s\S]*?"path":\s*\[/)) {
    return "zod schema validation failed — see retry directive below for the precise field path(s).";
  }
  return `gate '${err.reason}' tripped — see retry directive below.`;
}
```

- [ ] **Step 3: Run**

```
just test src/lib/turn/diagnoseFailure.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add src/lib/turn/diagnoseFailure.ts src/lib/turn/diagnoseFailure.test.ts
git commit -m "refactor(turn): diagnoseFailure heuristics for JSON-only contract"
```

---

### Task 18: Delete legacy modules

**Files:**

- Delete: `src/lib/course/parsers.ts`
- Delete: `src/lib/course/parsers.test.ts`
- Delete: `src/lib/prompts/clarification.ts`
- Delete: `src/lib/prompts/baselineEvaluation.ts`
- Delete: `src/lib/prompts/baselineEvaluation.test.ts`
- Modify: `src/lib/llm/generate.ts` — remove `generateStructured` function (and the `ai`'s `generateObject` import if unused).

- [ ] **Step 1: Verify no remaining callers**

```bash
grep -rn "from \"@/lib/course/parsers\"\|from \"@/lib/prompts/clarification\"\|from \"@/lib/prompts/baselineEvaluation\"\|generateStructured\|parseClarifyResponse\|parseFrameworkResponse\|parseBaselineResponse\|buildClarificationPrompt\|buildBaselineEvaluationPrompt\|buildFrameworkPrompt\|buildBaselinePrompt\|CLARIFICATION_SYSTEM_PROMPT\|FRAMEWORK_TURN_INSTRUCTIONS\|BASELINE_TURN_INSTRUCTIONS\|clarifyingQuestionsSchema\|baselineEvaluationSchema" src --include="*.ts"
```

Expected: zero hits (only deleted-file references in this task's own deletion list, if any are still showing).

If hits remain, surface them — that means an earlier task missed a caller.

- [ ] **Step 2: Delete files**

```bash
rm src/lib/course/parsers.ts src/lib/course/parsers.test.ts \
   src/lib/prompts/clarification.ts \
   src/lib/prompts/baselineEvaluation.ts src/lib/prompts/baselineEvaluation.test.ts
```

- [ ] **Step 3: Remove `generateStructured` from `generate.ts`**

Re-edit `src/lib/llm/generate.ts`:

- Remove the `generateStructured` export.
- Remove the `generateObject` import.
- Remove the `StructuredResult` interface.

Resulting file exports only: `GenerateOptions`, `ChatOptions`, `ChatResult`, `generateChat`.

- [ ] **Step 4: Run full suites + typecheck**

```
just check
```

Expected: green. If anything fails to resolve, an import to a deleted module is hiding somewhere — fix it now.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: remove legacy XML/parsers modules after JSON-everywhere migration"
```

---

### Task 19: Pre-launch JSONB truncate migration

**Files:**

- Create: `src/db/migrations/0005_jsonb_rewrite.sql`

- [ ] **Step 1: Inspect the latest migration to match style + numbering**

```
ls src/db/migrations/
```

Confirm `0004_add_retry_kinds.sql` is the latest. The new migration is `0005_jsonb_rewrite.sql`.

- [ ] **Step 2: Write the migration**

```sql
-- src/db/migrations/0005_jsonb_rewrite.sql
--
-- JSON-everywhere prompt architecture migration.
--
-- The wire/storage shapes for courses.clarification, courses.framework,
-- and courses.baseline are rewritten (snake_case → camelCase, field
-- renames text→prompt, single_select→multiple_choice, answers→responses).
-- The app is pre-launch and these tables carry no production data, so
-- we truncate in-flight scoping state rather than write a back-compat
-- shim.
--
-- After this migration applies, the next clarify call on any course
-- starts a fresh scoping pass.

BEGIN;

-- Drop in-flight scoping conversations (cascades to context_messages).
TRUNCATE TABLE scoping_passes CASCADE;

-- Defensive: if any context_messages rows survived the cascade
-- (e.g. a wave was opened then abandoned), clear them too.
TRUNCATE TABLE context_messages CASCADE;

-- Reset the scoping JSONB columns on every course.
UPDATE courses
SET clarification = NULL,
    framework = NULL,
    baseline = NULL;

COMMIT;
```

- [ ] **Step 3: Update the migrations meta journal (if drizzle-kit maintains one)**

```
ls src/db/migrations/meta/
```

If a `_journal.json` exists, append a corresponding entry. (Otherwise drizzle-kit picks the file up by name on next `just db-migrate`.)

```
cat src/db/migrations/meta/_journal.json | tail -20
```

If a journal is present, replicate the same shape with `idx: 5`, the new tag, and current timestamp — exact format mirrors prior entries verbatim.

- [ ] **Step 4: Smoke the migration locally**

```
just db-migrate
```

Expected: applies cleanly. (Run against a dev DB; testcontainers picks it up on next test run.)

- [ ] **Step 5: Run full suite — testcontainers will rebuild from migrations**

```
just check
```

Expected: green.

- [ ] **Step 6: Commit**

```bash
git add src/db/migrations/0005_jsonb_rewrite.sql src/db/migrations/meta/
git commit -m "feat(db): migration 0005 — truncate scoping rows for JSONB rewrite"
```

---

### Task 20: Update CLAUDE.md docs + UBIQUITOUS_LANGUAGE.md

**Files:**

- Modify: `src/lib/prompts/CLAUDE.md`
- Modify: `src/lib/course/CLAUDE.md`
- Modify: `src/lib/turn/CLAUDE.md`
- Modify: `docs/UBIQUITOUS_LANGUAGE.md`

- [ ] **Step 1: Rewrite `src/lib/prompts/CLAUDE.md`**

```md
# src/lib/prompts

Single source of truth for all LLM prompt text and per-stage schemas. No prompt text lives outside this directory.

- Every prompt is a pure function: typed params → `LlmMessage[]` or string. No side effects, no DB calls.
- Each scoping stage owns one Zod schema (`clarifySchema`, `frameworkSchema`, `makeBaselineSchema`, `gradeBaselineSchema`). `.describe()` on every field carries the model-facing guidance — Cerebras strict mode tokenises descriptions into the decoder context, so they ARE the contract.
- Visibility tags in `.describe()` prefixes: `[chat]` = `userMessage` (chat bubble), `[UI]` = rendered card/component, `[server]` = harness-only state.
- The shared `Question`/`Questionnaire`/`Response` union lives in `questionnaire.ts` and is reused by clarify + baseline.
- The system prompt (`scoping.ts:renderScopingSystem`) is slim: persona + topic + one-line JSON rule. Per-stage envelopes (`renderStageEnvelope`) are bare `<stage>...</stage>` + `<learner_input>...</learner_input>`.
- Sanitise untrusted text inside `renderStageEnvelope` so callers can't skip it.
- Cross-field invariants live on `.refine`/`.superRefine`. Refine messages flow back to the model as retry directives verbatim — phrase them as instructions, not error reports.
```

- [ ] **Step 2: Rewrite `src/lib/course/CLAUDE.md`**

```md
# src/lib/course

Scoping steps. One file = one LLM call wrapped up.

- Each lib step: validate course state → run `executeTurn` with `responseSchema` (no translator helpers, no parser closures) → persist the wire shape directly to `courses.{column}` → return typed payload + `nextStage`.
- Untrusted input reaches the prompt envelope via `renderStageEnvelope`, which XML-escapes.
- Routers (`src/server/routers/`) sequence steps; UI never imports from here.
- `gradeBaseline` follows the same shape: mechanical MC pass first, then `executeTurn(gradeBaselineSchema)` only if any answer is freetext. All-MC answer batches skip the LLM call entirely.
```

- [ ] **Step 3: Update `src/lib/turn/CLAUDE.md`**

Replace the "Parsers live in the caller" sentence with:

```md
- Used by scoping (`src/lib/course/`) today; teaching (`src/lib/wave/`) later.
- Callers pass `responseSchema: z.ZodType<T>`. The harness JSON-parses the model output, runs `schema.safeParse`, and throws `ValidationGateFailure` with a model-readable retry directive on failure. Refine `.message` flows back to the model verbatim.
- Transport errors (timeouts, 5xx) propagate untouched; no rows are persisted on transport failure.
```

- [ ] **Step 4: Append to `docs/UBIQUITOUS_LANGUAGE.md`**

Add the six new entries (Learner input, User envelope, Per-stage schema, Questionnaire, Question, Response) per spec §7, alphabetised into the existing list. Use the spec's wording verbatim for each.

- [ ] **Step 5: Commit**

```bash
git add src/lib/prompts/CLAUDE.md src/lib/course/CLAUDE.md src/lib/turn/CLAUDE.md docs/UBIQUITOUS_LANGUAGE.md
git commit -m "docs: align CLAUDE.md + ubiquitous language with JSON-everywhere contract"
```

---

### Task 21: End-to-end verification

**Files:** none — verification only.

- [ ] **Step 1: Full check**

```
just check
```

Expected: lint, typecheck, vitest all green.

- [ ] **Step 2: Routers integration suite**

```
just test src/server/routers
```

If `course.integration.test.ts` references old shapes, fix in this task as it surfaces; do not split into a separate task.

- [ ] **Step 3: Live smoke (manual — requires `LLM_API_KEY`)**

```
CEREBRAS_LIVE=1 just test src/server/routers/course.live.test.ts
```

Expected: clarify → generateFramework → generateBaseline → idempotency check all pass against real Cerebras. Per-turn ✓ summaries appear on stderr; no `<questions>`/`<framework>`/`<baseline>` tags in the response payloads (it's pure JSON now).

If a turn fails, read the per-turn prompt + response + diagnosis block printed by `formatTurn.ts`. Common failure modes:

- "model returned text that is not valid JSON" → the system prompt is still permitting prose; tighten its wording.
- "response is missing the required `userMessage`" → the schema's `.describe()` text needs `[chat]` annotation to nudge the model.
- "body matches the framework stage schema" → the envelope `<stage>` label disagrees with the schema; fix the envelope.

Iterate on the system prompt or `.describe()` text per the spec §6 "tuning surface" note. Schema architecture is fixed.

- [ ] **Step 4: Commit any smoke-iteration prompt tweaks**

```bash
git add src/lib/prompts/scoping.ts src/lib/prompts/*.ts
git commit -m "tune(prompts): live-smoke iteration on system prompt and .describe text"
```

- [ ] **Step 5: Final status check**

```
git status
git log --oneline -25
```

All 21 task commits accounted for; working tree clean.

---

## Self-Review (run mentally against the spec)

- **§4.1 slim system prompt:** Task 9 — done.
- **§4.2 bare stage envelopes:** Task 9 `renderStageEnvelope` + Tasks 13–16 callers — done.
- **§4.3 visibility tiers:** Tasks 2, 6, 7, 8, 11 — `.describe()` carries `[UI]/[server]/[chat]` annotations.
- **§4.4 unified Question/Questionnaire/Response:** Task 2 — done.
- **§4.5 schema-as-source-of-truth:** Task 2, 6, 7, 8, 11 — every field annotated; no separate prose copy.
- **§4.6 Cerebras strict constraints:** Task 1 (`toCerebrasJsonSchema`) + Task 4 (wire-up via `generateChat`) — done.
- **§4.7 simplified retry:** Task 5 (`parseAndValidate` raises generic-or-refine directives) — done.
- **§4.8 JSONB rewrite:** Task 12 (schemas) + Tasks 13–16 (wire shape persisted directly) + Task 19 (truncate) — done.
- **§4.9 gradeBaseline migration:** Task 11 (schema) + Task 16 (lib step) + Task 18 (delete `generateStructured`) — done.
- **§5 file impact table:** every row covered.
- **§7 Ubiquitous language additions:** Task 20.
- **Deletions explicit (parsers.ts, generateStructured, baselineEvaluation.ts, clarification.ts, build*Prompt builders, FRAMEWORK_TURN_INSTRUCTIONS, BASELINE_TURN_INSTRUCTIONS, all to*Jsonb helpers):** Tasks 7, 8, 13, 14, 15, 18 — done.
- **Hard deadline 2026-07-21:** plan executes in ~20 commits; well within budget.
- **Type-consistency spot-checks:**
  - `executeTurn`'s `responseSchema: z.ZodType<T>` (Task 5) ↔ `generateChat`'s `ChatOptions.responseSchema?: z.ZodType<unknown>` (Task 4) — Zod v4 ZodType is covariant on T; `T` flows through `executeTurn` and is widened to `unknown` at the SDK boundary. OK.
  - `makeBaselineSchema(...).superRefine` uses the closure's `scope` Set — `Set` allocation per call is fine (one call per generateBaseline + one per idempotent return).
  - JSONB v3 schemas (Task 12) mirror v4 wire shapes (Task 2) — bridged manually; if either side changes, the round-trip test (an integration test that round-trips a wire payload through `clarificationJsonbSchema.parse`) catches drift. Note: the round-trip test itself is not authored above — flagged for execution-time follow-up if smoke surfaces a drift.

If the executor finds a gap I missed, fix inline and add the fix to the relevant task's checklist.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-13-json-everywhere-prompt-architecture.md`. Two execution options:

1. **Subagent-Driven (recommended)** — controller dispatches a fresh subagent per task, reviews between tasks, fast iteration. REQUIRED SUB-SKILL: `superpowers:subagent-driven-development`.
2. **Inline Execution** — execute tasks in this session using `superpowers:executing-plans`, batch execution with checkpoints.

Which approach?
