import { describe, it, expect } from "vitest";
import type { Schema } from "ai";
import { z } from "zod/v4";
import { toCerebrasJsonSchema } from "@/lib/llm/toCerebrasJsonSchema";
import { clarifySchema } from "@/lib/prompts/clarify";
import { makeBaselineSchema } from "@/lib/prompts/baseline";
import { responsesSchema } from "@/lib/prompts/questionnaire";
import { buildWaveMidTurnTools } from "@/lib/course/waveTurnTools";
import { courseRouter } from "@/server/routers/course";
import { submitTurnInputSchema } from "@/server/routers/waveTurnInput";
import { clarificationJsonbSchema, baselineJsonbSchema } from "./jsonb";
import { waveChatLogSchema } from "./jsonbWaveChatLog";

/**
 * Wire-byte pins for every schema that carries an MC option key (issue #178).
 *
 * Each snapshot is pretty JSON, not an object: pretty-format sorts object
 * keys, and key order is part of the bytes the model and the cache see.
 * A snapshot diff here means a wire, storage or input shape changed.
 */
const toJson = (value: unknown): string => JSON.stringify(value, null, 2);

describe("schemas carrying an MC option key keep their bytes", () => {
  it("clarify response_format", () => {
    expect(toJson(toCerebrasJsonSchema(clarifySchema, { name: "clarify" }))).toMatchSnapshot();
  });

  it("baseline response_format", () => {
    const schema = makeBaselineSchema({ scopeTiers: [1, 2, 3] });
    expect(toJson(toCerebrasJsonSchema(schema, { name: "baseline" }))).toMatchSnapshot();
  });

  it("presentQuestionnaire tool input", async () => {
    const { tools } = buildWaveMidTurnTools({ answeredQuestionIds: [] });
    // Our tools always build `inputSchema` via `toToolInputSchema`, an AI SDK `Schema`.
    const schema = tools.presentQuestionnaire.inputSchema as Schema<unknown>;
    expect(toJson(await schema.jsonSchema)).toMatchSnapshot();
  });

  it("learner responses schema", () => {
    expect(toJson(z.toJSONSchema(responsesSchema))).toMatchSnapshot();
  });

  it("courses.clarification jsonb", () => {
    expect(toJson(z.toJSONSchema(clarificationJsonbSchema))).toMatchSnapshot();
  });

  it("courses.baseline jsonb", () => {
    expect(toJson(z.toJSONSchema(baselineJsonbSchema))).toMatchSnapshot();
  });

  it("waves.chat_log jsonb", () => {
    expect(toJson(z.toJSONSchema(waveChatLogSchema))).toMatchSnapshot();
  });

  it("course.submitBaseline tRPC input", () => {
    // The input is declared inline on the procedure; tRPC keeps it on `_def.inputs`.
    const [input] = courseRouter.submitBaseline._def.inputs;
    expect(toJson(z.toJSONSchema(input as z.ZodType))).toMatchSnapshot();
  });

  it("wave turn route input", () => {
    expect(toJson(z.toJSONSchema(submitTurnInputSchema))).toMatchSnapshot();
  });
});
