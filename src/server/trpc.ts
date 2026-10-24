import { initTRPC, TRPCError } from "@trpc/server";
import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { NotFoundError } from "@/db/queries/errors";
import { ensureUserProfile } from "@/db/queries";
import { userIdStore } from "@/lib/llm/userIdStore";
import { clientErrorText } from "@/lib/security/clientErrorText";
import { readRequestSession, resolveOrMintRequestUserId } from "./requestUser";

/** The tRPC request context. Tests build one with `appRouter.createCaller({ userId })`. */
export interface TRPCContext {
  /** The caller's learner, from an existing session. Undefined when the request has none. */
  readonly userId: string | undefined;
  /**
   * Mint the caller's anonymous learner, once per HTTP request. Only
   * `mintingProcedure` calls it. `createCaller` tests leave it out.
   */
  readonly mintUserId?: () => Promise<string | undefined>;
}

/**
 * Build the tRPC request context, once per HTTP request. It reads an existing
 * session and never mints (#246); `mintingProcedure` mints on demand. The
 * streaming wave-turn route reads the session the same way.
 */
export const createTRPCContext = async (
  opts: FetchCreateContextFnOptions,
): Promise<TRPCContext> => {
  const session = await readRequestSession(opts.req);
  // A session that failed to load is still a learner's. Refuse the whole
  // request, so no procedure answers them as a stranger or mints over them.
  if (session.kind === "failed") {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "session failed to load" });
  }
  // One mint per HTTP request: every minting call in a batch awaits this
  // same promise. Mutable on purpose; it is a per-request memo.
  let mint: Promise<string | undefined> | undefined;
  return {
    userId: session.kind === "learner" ? session.userId : undefined,
    mintUserId: () => (mint ??= resolveOrMintRequestUserId(opts.req)),
  };
};

// Every tRPC error response passes through `errorFormatter`. The client gets
// only text the server wrote on purpose (`clientErrorText`): tRPC otherwise
// sends an unexpected error's own message, and a failed DB write's message
// lists its params (issue #171). `data` is an allowlist, so `stack` never
// ships. tRPC adds it outside production, and its first line repeats the
// raw message.
const t = initTRPC.context<TRPCContext>().create({
  errorFormatter: ({ shape, error }) => ({
    code: shape.code,
    message: clientErrorText(error),
    data: { code: shape.data.code, httpStatus: shape.data.httpStatus, path: shape.data.path },
  }),
});

/** Define a tRPC router */
export const router = t.router;

/**
 * Map `NotFoundError` (thrown by `src/db/queries/`) to a tRPC `NOT_FOUND`
 * response. Without this middleware, plain `Error` becomes INTERNAL_SERVER_ERROR
 * on the wire — clients can't tell a missing row from a server crash. Applied
 * as a middleware (not a global error formatter) so query-layer code stays
 * tRPC-agnostic and unit tests on `src/db/queries/` see the original error.
 */
const mapNotFound = t.middleware(async ({ next }) => {
  const result = await next();
  // tRPC v11 wraps thrown errors into a `{ ok: false, error }` return value
  // (see `callRecursive` in @trpc/server). Errors don't propagate as throws to
  // outer middleware — we have to inspect the result and re-throw with the
  // semantic code.
  if (!result.ok && result.error.cause instanceof NotFoundError) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: result.error.cause.message,
      cause: result.error.cause,
    });
  }
  return result;
});

/**
 * Run a procedure as `userId`. `ensureUserProfile` provisions the
 * `user_profiles` row first: a freshly minted anonymous user has an
 * `auth.users` row but no profile row, and `courses.user_id` references
 * `user_profiles.id`. Then `userId` is bound to ALS, so the LLM layer
 * (Cerebras rate limiter) reads it from ambient request scope rather than
 * threading it through generateChat's signature. ALS propagates through
 * await/Promise/fetch, so the AI SDK transport preserves the binding.
 */
async function runAsLearner<T>(userId: string, run: () => Promise<T>): Promise<T> {
  await ensureUserProfile(userId);
  return userIdStore.run(userId, run);
}

/**
 * A procedure for an existing learner's named resource; it never mints. A
 * caller with no session owns no course, so it answers NOT_FOUND, as for
 * another learner's course (#246). In production `ctx.userId` is the
 * Supabase anonymous user's id; in dev it is the `x-dev-user-id` stub.
 */
export const protectedProcedure = t.procedure.use(mapNotFound).use(async ({ ctx, next }) => {
  // Hoist into `userId` to keep the override ctx well-typed across the
  // callback boundary.
  const userId = ctx.userId;
  if (!userId) throw new TRPCError({ code: "NOT_FOUND", message: "no learner session" });
  return runAsLearner(userId, () => next({ ctx: { ...ctx, userId } }));
});

/**
 * A procedure for a read with a natural empty answer; it never mints.
 * `ctx.userId` stays optional: the procedure answers a caller with no
 * session with its empty answer (#246). A learner runs as in
 * `protectedProcedure`.
 */
export const optionalLearnerProcedure = t.procedure
  .use(mapNotFound)
  .use(async ({ ctx, next }) => (ctx.userId ? runAsLearner(ctx.userId, () => next()) : next()));

/**
 * A procedure that creates learner data. A caller with no session mints its
 * anonymous learner here, and nowhere else (#246). `ctx.mintUserId` memoises
 * the mint per HTTP request, so a batch shares one. A `createCaller` test
 * with no `userId` has no mint, so it answers UNAUTHORIZED.
 */
export const mintingProcedure = t.procedure.use(mapNotFound).use(async ({ ctx, next }) => {
  const userId = ctx.userId ?? (await ctx.mintUserId?.());
  if (!userId) throw new TRPCError({ code: "UNAUTHORIZED", message: "no authenticated user" });
  return runAsLearner(userId, () => next({ ctx: { ...ctx, userId } }));
});
