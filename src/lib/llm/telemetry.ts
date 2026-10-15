import { trace, type Context, type Span, type SpanOptions, type Tracer } from "@opentelemetry/api";
import type { TelemetrySettings } from "ai";
import { safeErrorName } from "@/lib/security/errorLogLine";

/**
 * Per-call `experimental_telemetry` settings for every LLM call, gated by
 * `LLM_TELEMETRY=true` and stage-labelled via `functionId` (e.g. "wave-mid",
 * "clarify") so traces group by pipeline stage.
 *
 * Reads `process.env` directly instead of `getEnv()`: unit tests call the
 * LLM wrappers with mock models and no full env, and this helper must not
 * force whole-schema env validation onto that path.
 *
 * Inputs/outputs contain learner content — keep them out of traces until a
 * deliberate decision says otherwise; spans still carry timing, tokens,
 * model, and retries. A failed call's error text stays out too: see
 * {@link contentFreeTracer}.
 */
export function llmTelemetry(functionId: string): TelemetrySettings {
  return {
    isEnabled: process.env.LLM_TELEMETRY === "true",
    functionId,
    recordInputs: false,
    recordOutputs: false,
    // "ai" is the SDK's own default tracer name, so spans keep their scope.
    // The SDK ignores the tracer while telemetry is off.
    tracer: contentFreeTracer(trace.getTracer("ai")),
  };
}

/** What `Tracer.startActiveSpan` takes after the span name. The callback is always last. */
type ActiveSpanArgs<F> =
  | readonly [fn: F]
  | readonly [options: SpanOptions, fn: F]
  | readonly [options: SpanOptions, parent: Context, fn: F];

/**
 * A tracer whose spans drop error text (#204). On a failed call the SDK
 * writes `error.message` and `error.stack` onto the span, and the record
 * flags do not cover them. A `TypeValidationError` message quotes the raw
 * model output, which can hold an answer key. An `APICallError` message can
 * carry provider text. The SDK opens every span through `startActiveSpan`,
 * so wrapping the tracer covers all of them.
 */
function contentFreeTracer(tracer: Tracer): Tracer {
  return {
    startSpan: (name, options, parent) => contentFreeSpan(tracer.startSpan(name, options, parent)),
    // The real tracer still starts the span and sets the active context, so
    // parent and child spans link as before. Only the callback's span is
    // wrapped, and that is the span the SDK records errors on.
    startActiveSpan<F extends (span: Span) => ReturnType<F>>(
      name: string,
      ...args: ActiveSpanArgs<F>
    ): ReturnType<F> {
      const wrap = (fn: F) => (span: Span) => fn(contentFreeSpan(span));
      if (args.length === 1) return tracer.startActiveSpan(name, wrap(args[0]));
      if (args.length === 2) return tracer.startActiveSpan(name, args[0], wrap(args[1]));
      return tracer.startActiveSpan(name, args[0], args[1], wrap(args[2]));
    },
  };
}

/**
 * The span, forwarding every call but the error text. `recordException`
 * keeps the error's class name, by the same safe-token rule as the stderr
 * error line, and drops its message and stack. The stack's first line
 * repeats the message. `setStatus` keeps the status code and drops its
 * message.
 */
function contentFreeSpan(span: Span): Span {
  return {
    spanContext: () => span.spanContext(),
    setAttribute(key, value) {
      span.setAttribute(key, value);
      return this;
    },
    setAttributes(attributes) {
      span.setAttributes(attributes);
      return this;
    },
    addEvent(name, attributesOrStartTime, startTime) {
      span.addEvent(name, attributesOrStartTime, startTime);
      return this;
    },
    addLink(link) {
      span.addLink(link);
      return this;
    },
    addLinks(links) {
      span.addLinks(links);
      return this;
    },
    setStatus({ code }) {
      span.setStatus({ code });
      return this;
    },
    updateName(name) {
      span.updateName(name);
      return this;
    },
    end: (endTime) => span.end(endTime),
    isRecording: () => span.isRecording(),
    // OTel drops an exception event that has neither a type nor a message,
    // so a name that fails the rule still records as a plain "Error".
    recordException: (exception, time) =>
      span.recordException({ name: safeErrorName(exception) ?? "Error" }, time),
  };
}
