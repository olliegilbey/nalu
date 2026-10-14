import { TRPCError } from "@trpc/server";

/** The ids that place a failed Wave turn. Both are content-free. */
export interface WaveTurnErrorIds {
  readonly courseId: string;
  readonly waveNumber: number;
}

/** A value safe to log: a short identifier-like token, never prose. */
const SAFE_TOKEN = /^[\w.-]{1,64}$/;

/** A Postgres SQLSTATE: five digits or capitals, e.g. `23505`. */
const SQLSTATE = /^[0-9A-Z]{5}$/;

/**
 * One content-free stderr line for a failed Wave turn (#169). It carries
 * ids, error class names and safe codes only: the TRPC code, the Postgres
 * SQLSTATE and constraint name, and the HTTP status. It never reads a
 * message, params, or a response body. A DrizzleQueryError's message lists
 * its params, and an APICallError holds the provider's response body. Both
 * can quote learner text, model prose and answer keys.
 */
export function waveTurnErrorLogLine(error: unknown, ids: WaveTurnErrorIds): string {
  // The inner error: a wrapped driver error (`cause`), or the SDK retry
  // wrapper's final attempt (`RetryError.lastError`).
  const inner = readField(error, "cause") ?? readField(error, "lastError");
  const fields: readonly (readonly [string, string | undefined])[] = [
    ["course", ids.courseId],
    ["wave", String(ids.waveNumber)],
    ["name", safeToken(readField(error, "name"))],
    ["inner", safeToken(readField(inner, "name"))],
    ["trpcCode", safeToken(error instanceof TRPCError ? error.code : undefined)],
    ["sqlstate", firstMatch([error, inner], "code", SQLSTATE)],
    ["constraint", firstMatch([error, inner], "constraint_name", SAFE_TOKEN)],
    ["status", firstStatus([error, inner])],
  ];
  const logged = fields.filter(([, value]) => value !== undefined);
  return `[wave-turn] turn failed ${logged.map(([key, value]) => `${key}=${value}`).join(" ")}`;
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
