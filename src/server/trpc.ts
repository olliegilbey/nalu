import { initTRPC, TRPCError } from "@trpc/server";
import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { NotFoundError } from "@/db/queries/errors";
import { ensureUserProfile } from "@/db/queries";
import { userIdStore } from "@/lib/llm/userIdStore";
import { resolveRequestUserId } from "./requestUser";

/**
 * Build the tRPC request context. Resolves `userId` (possibly undefined)
 * via `resolveRequestUserId` — the auth story shared with the streaming
 * wave-turn route handler.
 */
export const createTRPCContext = async (opts: FetchCreateContextFnOptions) => {
  return { userId: await resolveRequestUserId(opts.req) };
};

const t = initTRPC.context<typeof createTRPCContext>().create();

/** Define a tRPC router */
export const router = t.router;

/** Public procedure — no auth required */
export const publicProcedure = t.procedure;

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
 * Authenticated procedure. In production `ctx.userId` is the Supabase
 * anonymous user's id; in dev it is the `x-dev-user-id` stub. Either way,
 * `ensureUserProfile` provisions the `user_profiles` row on demand — a
 * freshly signed-in anonymous user has an `auth.users` row but no profile
 * row, and `courses.user_id` references `user_profiles.id`.
 */
export const protectedProcedure = t.procedure.use(mapNotFound).use(async ({ ctx, next }) => {
  if (!ctx.userId) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: "no authenticated user" });
  }
  await ensureUserProfile(ctx.userId);
  // Bind ctx.userId to ALS so the LLM layer (Cerebras rate limiter) reads
  // it from ambient request scope rather than threading it through
  // generateChat's signature. ALS propagates through await/Promise/fetch,
  // so the AI SDK transport preserves the binding. Hoist into `userId`
  // first to keep the override ctx well-typed across the callback boundary.
  const userId = ctx.userId;
  return userIdStore.run(userId, () => next({ ctx: { ...ctx, userId } }));
});
