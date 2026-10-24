import { describe, expectTypeOf, it } from "vitest";
import type { inferRouterInputs } from "@trpc/server";
import type { AppRouter } from "@/server/routers";
import type { BaselineAnswer } from "@/lib/course/submitBaseline";
import type { ShapedQuestionnaireAnswer } from "@/lib/course/shapeQuestionnaireAnswers";
import type { UseScopingStateResult } from "@/hooks/useScopingState";
import type { UseWaveStateResult } from "@/hooks/useWaveState";
import type { QuestionnaireAnswer } from "./questionnaireAnswer";
import type { SubmitTurnBody, SubmitTurnPayload } from "./waveTurnInput";

// Type-level pins (issue #220). `expectTypeOf` does nothing at runtime;
// `tsc --noEmit` fails the moment any use drifts from the one schema.

/** One answer, as the Wave turn route's schema parses it. */
type WaveRouteAnswer = Extract<
  SubmitTurnPayload,
  { kind: "questionnaire-answers" }
>["answers"][number];

/** One answer, as `course.submitBaseline` parses it. */
type ScopingRouteAnswer =
  inferRouterInputs<AppRouter>["course"]["submitBaseline"]["answers"][number];

describe("QuestionnaireAnswer", () => {
  it("is the answer both submit routes parse", () => {
    expectTypeOf<WaveRouteAnswer>().toEqualTypeOf<QuestionnaireAnswer>();
    expectTypeOf<ScopingRouteAnswer>().toEqualTypeOf<QuestionnaireAnswer>();
  });

  it("is the answer the baseline grader and the client shaper use", () => {
    expectTypeOf<BaselineAnswer>().toEqualTypeOf<QuestionnaireAnswer>();
    expectTypeOf<ShapedQuestionnaireAnswer>().toEqualTypeOf<QuestionnaireAnswer>();
  });

  it("is the answer both client hooks submit", () => {
    expectTypeOf<
      Parameters<UseWaveStateResult["submitQuestionnaireAnswers"]>[0][number]
    >().toEqualTypeOf<QuestionnaireAnswer>();
    expectTypeOf<
      Parameters<UseScopingStateResult["submitBaselineAnswers"]>[0][number]
    >().toEqualTypeOf<QuestionnaireAnswer>();
  });

  it("rides in a Wave request body that carries only the payload", () => {
    // `useWaveState` types its `useChat` body as `SubmitTurnBody`.
    expectTypeOf<SubmitTurnBody>().toEqualTypeOf<{ payload: SubmitTurnPayload }>();
  });
});
