import { TRPCError } from "@trpc/server";

/**
 * The content-free fields that place a failed request, in log order: a
 * course id and Wave number, or a tRPC procedure path. A value that is not a
 * safe token is dropped.
 */
export type ErrorLogPlace = Readonly<Record<string, string | number | undefined>>;

/** A value safe to log: a short identifier-like token, never prose. */
const SAFE_TOKEN = /^[\w.-]{1,64}$/;

/** A Postgres SQLSTATE: five digits or capitals, e.g. `23505`. */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * One content-free stderr line for a failed request (issues #169, #171).
 * `event` is the caller's fixed prefix, e.g. `[wave-turn] turn failed`. The
 * line carries the place, error class names and safe codes only: the TRPC
 * code, the Postgres SQLSTATE and constraint name, and the HTTP status. It
 * never reads a message, params, or a response body. A DrizzleQueryError's
 * message lists its params, and an APICallError holds the provider's
 * response body. Both can quote learner text, model prose and answer keys.
 */
export function errorLogLine(event: string, place: ErrorLogPlace, error: unknown): string {
  // The inner error: a wrapped driver error (`cause`), or the SDK retry
  // wrapper's final attempt (`RetryError.lastError`).
  const inner = readField(error, "cause") ?? readField(error, "lastError");
  const fields: readonly (readonly [string, string | undefined])[] = [
    ...Object.entries(place).map(
      ([key, value]) =>
        [key, safeToken(typeof value === "number" ? String(value) : value)] as const,
    ),
    ["name", safeErrorName(error)],
    ["inner", safeErrorName(inner)],
    ["trpcCode", safeToken(error instanceof TRPCError ? error.code : undefined)],
    ["sqlstate", firstMatch([error, inner], "code", SQLSTATE)],
    ["constraint", firstMatch([error, inner], "constraint_name", SAFE_TOKEN)],
    ["status", firstStatus([error, inner])],
  ];
  const logged = fields.filter(([, value]) => value !== undefined);
  return [event, ...logged.map(([key, value]) => `${key}=${value}`)].join(" ");
}

/**
 * An error's class name when it is a safe token, e.g. `AI_APICallError`;
 * undefined otherwise. The LLM telemetry spans keep this and nothing else
 * of an error (`src/lib/llm/telemetry.ts`).
 */
export function safeErrorName(error: unknown): string | undefined {
  return safeToken(readField(error, "name"));
}

/** Read one named field off an unknown value; undefined when absent. */
function readField(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** The value when it is a safe token; undefined otherwise. */
function safeToken(value: unknown): string | undefined {
  return typeof value === "string" && SAFE_TOKEN.test(value) ? value : undefined;
}

/** The first candidate's string field that matches `pattern`. */
function firstMatch(
  candidates: readonly unknown[],
  key: string,
  pattern: RegExp,
): string | undefined {
  return candidates
    .map((c) => readField(c, key))
    .find((v): v is string => typeof v === "string" && pattern.test(v));
}

/** The first candidate's integer `statusCode`, e.g. an APICallError's 429. */
function firstStatus(candidates: readonly unknown[]): string | undefined {
  const status = candidates
    .map((c) => readField(c, "statusCode"))
    .find((v): v is number => Number.isInteger(v));
  return status === undefined ? undefined : String(status);
}
